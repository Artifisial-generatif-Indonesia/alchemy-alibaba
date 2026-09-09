import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import * as RDS from "../rds/index.ts";
import * as Tair from "../tair/index.ts";
import { withProtocolHarness, withTempDir } from "./harness.ts";
import {
  deployProtocol,
  destroyProtocol,
  protocolMakeOptions,
  protocolStack,
} from "./stack.ts";
import { assertNoSecrets } from "./redaction.ts";
const create = {
  engine: "PostgreSQL" as const,
  engineVersion: "16.0",
  DBInstanceClass: "class-a",
  DBInstanceStorage: 20,
  DBInstanceNetType: "Intranet" as const,
  payType: "Serverless" as const,
  securityIPList: "127.0.0.1",
};
describe("Instance mutation protocol", { timeout: 30000 }, () => {
  it("restores into a distinct managed instance while leaving the source intact", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = protocolStack(
          "RdsRestore",
          options,
          Effect.gen(function* () {
            const source = yield* RDS.Instance("source", {
              ...create,
              name: "restore-source",
            });
            const restored = yield* RDS.Instance("restored", {
              ...create,
              name: "restore-target",
              restoreFrom: {
                instanceId: source.instanceId,
                backupId: "backup-test",
              },
            });
            return { source: source.instanceId, restored: restored.instanceId };
          }),
        );
        const first = await deployProtocol(options, stack);
        expect(first.source).not.toBe(first.restored);
        expect(world.rds.size).toBe(2);
        expect(await deployProtocol(options, stack)).toEqual(first);
        expect(
          world.actions().filter((action) => action === "CloneDBInstance"),
        ).toHaveLength(1);
        expect(
          world.actions().filter((action) => action === "CreateDBInstance"),
        ).toHaveLength(1);
        await destroyProtocol(options, stack);
        expect(world.rds.size).toBe(0);
      }),
    );
  });
  it("reads MySQL max_connections without counting reserved management connections", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = (limit: string) =>
          protocolStack(
            "MysqlConnectionLimit",
            options,
            RDS.Instance("database", {
              ...create,
              engine: "MySQL",
              engineVersion: "8.0",
              payType: "Postpaid",
              parameters: { max_connections: limit },
              restartForParameterChanges: true,
            }),
          );
        const first = await deployProtocol(options, stack("128"));
        expect(first.parameters?.max_connections).toBe("128");
        expect(first.pendingRestartParameters).toEqual([]);
        const record = world.rds.get(first.instanceId)!;
        expect(record.runningParameters?.max_connections).toBe("648");
        const updates = () =>
          world.actions().filter((a) => a === "ModifyParameter").length;
        const before = updates();
        expect((await deployProtocol(options, stack("128"))).instanceId).toBe(
          first.instanceId,
        );
        expect(updates()).toBe(before);
        // Same desired input must repair real drift in the user connection limit.
        record.maxConnections = 200;
        record.runningParameters!.max_connections = "720";
        expect(
          (await deployProtocol(options, stack("128"))).parameters
            ?.max_connections,
        ).toBe("128");
        expect(updates()).toBe(before + 1);
        expect(
          (await deployProtocol(options, stack("160"))).parameters
            ?.max_connections,
        ).toBe("160");
        await destroyProtocol(options, stack("160"));
      }),
    );
  });

  it("repairs backup drift and reports pending parameter restarts", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = (restart = false) =>
          protocolStack(
            "RdsConfiguration",
            options,
            RDS.Instance("database", {
              name: "configured-db",
              ...create,
              backupPolicy: {
                backupRetentionPeriod: 7,
                preferredBackupPeriod: "Monday,Wednesday,Friday",
                preferredBackupTime: "02:00Z-03:00Z",
              },
              parameters: { max_connections: "200" },
              restartForParameterChanges: restart,
              maintenanceWindow: "04:00Z-05:00Z",
            }),
          );
        const first = await deployProtocol(options, stack(false));
        expect(first.backupPolicy?.backupRetentionPeriod).toBe(7);
        expect(first.pendingRestartParameters).toEqual(["max_connections"]);
        const mutations = () =>
          world
            .actions()
            .filter(
              (action) =>
                !action.startsWith("Describe") && !action.startsWith("List"),
            );
        const before = mutations();
        expect((await deployProtocol(options, stack(false))).instanceId).toBe(
          first.instanceId,
        );
        expect(mutations()).toEqual(before);
        world.rds.get(first.instanceId)!.backupPolicy!.BackupRetentionPeriod =
          1;
        expect(
          (await deployProtocol(options, stack(false))).backupPolicy
            ?.backupRetentionPeriod,
        ).toBe(7);
        expect(
          (await deployProtocol(options, stack(true))).pendingRestartParameters,
        ).toEqual([]);
        expect(world.rds.size).toBe(1);
        expect(
          world.actions().filter((action) => action === "CreateDBInstance"),
        ).toHaveLength(1);
        await destroyProtocol(options, stack(true));
      }),
    );
  });
  it("waits for RDS resize and SSL completion, rotates key material, and cycles protection", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        world.rdsPublicEndpoint = true;
        const options = protocolMakeOptions(server.host, directory);
        const stack = (revision: number) =>
          protocolStack(
            "RdsWireUpdates",
            options,
            Effect.gen(function* () {
              const instance = yield* RDS.Instance("instance", {
                name: "protocol-rds",
                ...create,
                deletionProtection: revision !== 1,
                DBInstanceClass: revision ? "class-b" : "class-a",
                serverlessConfig: {
                  minCapacity: revision ? 1 : 0.5,
                  maxCapacity: 2,
                  autoPause: !!revision,
                },
                ssl: {
                  SSLEnabled: 1,
                  CAType: "custom",
                  serverCert: `public-cert-${revision}`,
                },
                sslServerKey: Redacted.make(`protocol-private-key-${revision}`),
                sslPassword: Redacted.make(`protocol-key-password-${revision}`),
              });
              return { id: instance.instanceId };
            }),
          );
        const initial = await deployProtocol(options, stack(0));
        expect([...world.rds.values()][0]?.ssl.LastModifyStatus).toBe(
          "success",
        );
        expect(await deployProtocol(options, stack(0))).toEqual(initial);
        expect(await deployProtocol(options, stack(1))).toEqual(initial);
        expect([...world.rds.values()][0]).toMatchObject({
          instanceClass: "class-b",
          serverless: { ScaleMin: 1, ScaleMax: 2, AutoPause: true },
          deletionProtection: false,
        });
        expect(await deployProtocol(options, stack(2))).toEqual(initial);
        const setters = world.captured.filter(
          (x) => x.action === "ModifyDBInstanceDeletionProtection",
        );
        expect(setters.map((x) => x.deletionProtection)).toEqual([
          "true",
          "false",
          "true",
        ]);
        expect(setters.every((x) => !x.clientToken)).toBe(true);
        const ssl = world.captured.filter(
          (x) => x.action === "ModifyDBInstanceSSL",
        );
        expect(ssl).toHaveLength(3);
        expect(ssl.every((x) => x.hasPassword && x.hasServerKey)).toBe(true);
        expect(ssl[0]?.connectionString).toBe(
          `${initial.id}.pg.rds.aliyuncs.com`,
        );
        expect(
          world.actions().filter((x) => x === "ModifyDBInstanceSpec"),
        ).toHaveLength(2);
        expect(JSON.stringify([...world.rds.values()])).not.toContain(
          "protocol-private-key",
        );
        expect(JSON.stringify([...world.rds.values()])).not.toContain(
          "protocol-key-password",
        );
        await destroyProtocol(options, stack(2));
        expect(world.rds.size).toBe(0);
        const evidence = JSON.stringify({
          requests: world.captured,
          records: [...world.rds.values()],
        });
        expect(evidence).not.toContain("protocol-private-key");
        expect(evidence).not.toContain("protocol-key-password");
        assertNoSecrets(world.captured);
      }),
    );
  });
  it("fails RDS reconciliation when the asynchronous SSL operation fails", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        world.rdsSslFailure = true;
        const options = protocolMakeOptions(server.host, directory);
        const stack = protocolStack(
          "RdsSslFailed",
          options,
          Effect.gen(function* () {
            yield* RDS.Instance("instance", {
              name: "protocol-ssl-failure",
              ...create,
              ssl: { SSLEnabled: 1, CAType: "aliyun" },
            });
            return {};
          }),
        );
        await expect(deployProtocol(options, stack)).rejects.toThrow(
          "SSL configuration failed",
        );
        expect(world.rds.size).toBe(1);
        expect(
          world.actions().filter((x) => x === "ModifyDBInstanceSSL"),
        ).toHaveLength(1);
      }),
    );
  });
  it.each([
    ["MASTER_SLAVE", "STAND_ALONE"],
    ["STAND_ALONE", "MASTER_SLAVE"],
  ])(
    "compares Tair %s against the detail API node type vocabulary",
    async (initialType, nextType) => {
      await withTempDir((directory) =>
        withProtocolHarness(async ({ server, world }) => {
          const options = protocolMakeOptions(server.host, directory);
          const stack = (nodeType: string) =>
            protocolStack(
              "TairNodeType",
              options,
              Effect.gen(function* () {
                const instance = yield* Tair.Instance("instance", {
                  instanceClass: "redis.test",
                  instanceType: "Redis",
                  chargeType: "PostPaid",
                  nodeType,
                });
                return { id: instance.instanceId };
              }),
            );
          const initial = await deployProtocol(options, stack(initialType));
          expect(
            world.actions().filter((action) => action === "ModifyInstanceSpec"),
          ).toHaveLength(0);
          expect(await deployProtocol(options, stack(nextType))).toEqual(
            initial,
          );
          expect([...world.tair.values()][0]?.nodeType).toBe(nextType);
          expect(
            world.actions().filter((action) => action === "ModifyInstanceSpec"),
          ).toHaveLength(1);
          expect(await deployProtocol(options, stack(nextType))).toEqual(
            initial,
          );
          expect(
            world.actions().filter((action) => action === "ModifyInstanceSpec"),
          ).toHaveLength(1);
          await destroyProtocol(options, stack(nextType));
        }),
      );
    },
  );

  it("resizes Tair A to B to A with distinct operation tokens and rotates the default password", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = (size: string, revision: number) =>
          protocolStack(
            "TairWireResize",
            options,
            Effect.gen(function* () {
              const instance = yield* Tair.Instance("instance", {
                name: "protocol-resize",
                instanceClass: size,
                engineVersion: "7.0",
                instanceType: "Redis",
                chargeType: "PostPaid",
                password: Redacted.make(`protocol-tair-password-${revision}`),
              });
              return { id: instance.instanceId };
            }),
          );
        const initial = await deployProtocol(options, stack("class-a", 0));
        expect(await deployProtocol(options, stack("class-b", 1))).toEqual(
          initial,
        );
        expect([...world.tair.values()][0]?.instanceClass).toBe("class-b");
        expect(await deployProtocol(options, stack("class-a", 1))).toEqual(
          initial,
        );
        expect([...world.tair.values()][0]?.instanceClass).toBe("class-a");
        const resizes = world.captured.filter(
          (x) => x.action === "ModifyInstanceSpec",
        );
        expect(resizes).toHaveLength(2);
        expect(new Set(resizes.map((x) => x.clientToken)).size).toBe(2);
        expect(resizes.every((x) => !!x.clientToken)).toBe(true);
        expect(world.resources.passwordResets).toBe(1);
        await destroyProtocol(options, stack("class-a", 1));
        expect(world.activeTair()).toHaveLength(0);
      }),
    );
  });
});
