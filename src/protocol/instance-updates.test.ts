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

describe("Instance mutation protocol", { timeout: 30_000 }, () => {
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
                create,
                deletionProtection: revision !== 1,
                spec: {
                  DBInstanceClass: revision ? "class-b" : "class-a",
                  serverlessConfiguration: {
                    minCapacity: revision ? 1 : 0.5,
                    maxCapacity: 2,
                    autoPause: !!revision,
                  },
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
              create,
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
                create: {
                  instanceClass: "class-a",
                  instanceType: "Redis",
                  chargeType: "PostPaid",
                },
                spec: { instanceClass: size },
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
