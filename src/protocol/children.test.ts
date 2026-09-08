import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as RdsSdk from "@alicloud/rds20140815";
import { describe, expect, it } from "vitest";
import * as RDS from "../rds/index.ts";
import * as Tair from "../tair/index.ts";
import * as ACR from "../acr/index.ts";
import { withProtocolHarness, withTempDir } from "./harness.ts";
import {
  deployProtocol,
  destroyProtocol,
  protocolMakeOptions,
  protocolStack,
} from "./stack.ts";
import { assertNoSecrets } from "./redaction.ts";

const password = Redacted.make("ProtocolChildPassword1!");
const rotated = Redacted.make("ProtocolChildPassword2!");

describe("Child resource SDK protocol lifecycles", { timeout: 30_000 }, () => {
  it.each(["MySQL", "PostgreSQL"] as const)(
    "persists RDS %s children, rotates passwords, and verifies teardown semantics",
    async (engine) => {
      await withTempDir((directory) =>
        withProtocolHarness(async ({ server, clients, world }) => {
          const options = protocolMakeOptions(server.host, directory);
          const stack = (revision: number) =>
            protocolStack(
              `Children${engine}`,
              options,
              Effect.gen(function* () {
                const instance = yield* RDS.Instance("rds", {
                  name: "protocol-children",
                  create: {
                    engine,
                    engineVersion: engine === "MySQL" ? "8.0" : "16.0",
                    DBInstanceClass: "protocol-class",
                    DBInstanceStorage: 20,
                    DBInstanceNetType: "Intranet",
                    payType: "Postpaid",
                    securityIPList: "127.0.0.1",
                  },
                });
                const account = yield* RDS.Account("account", {
                  instanceId: instance.instanceId,
                  password: revision ? rotated : password,
                  description: `revision-${revision}`,
                });
                const group = yield* RDS.SecurityIpGroup("group", {
                  instanceId: instance.instanceId,
                  name: "runner",
                  securityIps: [revision ? "192.0.2.2/32" : "192.0.2.1/32"],
                });
                const database = yield* RDS.Database("database", {
                  instanceId: instance.instanceId,
                  name: "example",
                  characterSetName: "UTF8",
                  description: `revision-${revision}`,
                  accountNames: [account.name],
                  securityGroupName: group.name,
                });
                yield* RDS.AccountPrivilege("grant", {
                  instanceId: instance.instanceId,
                  accountName: account.name,
                  databaseName: database.name,
                  privilege:
                    engine === "PostgreSQL"
                      ? "DBOwner"
                      : revision
                        ? "ReadWrite"
                        : "ReadOnly",
                });
                return {
                  instanceId: instance.instanceId,
                  account: account.name,
                  database: database.name,
                };
              }),
            );
          const initial = await deployProtocol(options, stack(0));
          expect(await deployProtocol(options, stack(0))).toEqual(initial);
          expect(
            world.actions().filter((x) => x === "CreateAccount"),
          ).toHaveLength(1);
          expect(await deployProtocol(options, stack(1))).toEqual(initial);
          expect(world.resources.passwordResets).toBe(1);
          expect(
            [...world.resources.accounts.values()][0]?.AccountDescription,
          ).toBe("revision-1");
          expect(
            [...world.resources.databases.values()][0]?.DBDescription,
          ).toBe("revision-1");
          expect([...world.resources.groups.values()][0]?.ips).toBe(
            "192.0.2.2/32",
          );
          expect(
            JSON.stringify([...world.resources.accounts.values()]),
          ).not.toContain("ProtocolChildPassword");
          expect(
            world.captured
              .filter(
                (x) =>
                  x.action === "CreateAccount" ||
                  x.action === "ResetAccountPassword",
              )
              .every((x) => x.hasPassword),
          ).toBe(true);
          if (engine === "PostgreSQL") {
            await expect(destroyProtocol(options, stack(1))).rejects.toThrow(
              "PostgreSQL does not support RevokeAccountPrivilege",
            );
            expect(world.actions()).not.toContain("RevokeAccountPrivilege");
            expect(world.actions()).not.toContain("DeleteDBInstance");
            expect(world.resources.databases.size).toBe(1);
            // Scoped recovery matches the disposable live test; production requires reviewed SQL.
            await clients.rds.deleteDatabase(
              new RdsSdk.DeleteDatabaseRequest({
                DBInstanceId: initial.instanceId,
                DBName: initial.database,
              }),
            );
          } else {
            world.script({
              action: "RevokeAccountPrivilege",
              code: "ServiceUnavailable",
              statusCode: 503,
            });
          }
          await destroyProtocol(options, stack(1));
          expect(world.resources.accounts.size).toBe(0);
          expect(world.resources.databases.size).toBe(0);
          expect(world.resources.privileges.size).toBe(0);
          expect([...world.resources.groups.values()][0]?.ips).toBe(
            "127.0.0.1",
          );
          expect(world.rds.size).toBe(0);
          const actions = world.actions();
          expect(actions.lastIndexOf("DeleteAccount")).toBeLessThan(
            actions.lastIndexOf("DeleteDBInstance"),
          );
          expect(actions.filter((x) => x === "DeleteDatabase")).toHaveLength(1);
          assertNoSecrets(world.captured);
        }),
      );
    },
  );

  it("propagates an authorization failure and recovers an accepted account create without duplicating it", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = protocolStack(
          "AccountRecovery",
          options,
          Effect.gen(function* () {
            const account = yield* RDS.Account("account", {
              instanceId: "rm-parent",
              name: "example_user",
              password,
            });
            return { name: account.name };
          }),
        );
        world.script({
          action: "DescribeAccounts",
          code: "Forbidden",
          statusCode: 403,
        });
        await expect(deployProtocol(options, stack)).rejects.toMatchObject({
          code: "Forbidden",
          statusCode: 403,
        });
        expect(world.actions()).not.toContain("CreateAccount");
        world.script({
          action: "CreateAccount",
          code: "OperationAcceptedButResponseLost",
          accept: true,
        });
        await expect(deployProtocol(options, stack)).rejects.toThrow();
        expect(world.resources.accounts.size).toBe(1);
        expect(await deployProtocol(options, stack)).toEqual({
          name: "example_user",
        });
        expect(
          world.actions().filter((x) => x === "CreateAccount"),
        ).toHaveLength(1);
        expect(
          JSON.stringify([...world.resources.accounts.values()]),
        ).not.toContain("ProtocolChildPassword");
        await destroyProtocol(options, stack);
      }),
    );
  });

  it("uses the Tair account envelope and removes a dedicated whitelist group", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = (revision: number) =>
          protocolStack(
            "TairChildren",
            options,
            Effect.gen(function* () {
              const account = yield* Tair.Account("account", {
                instanceId: "r-parent",
                password: revision ? rotated : password,
                settings: { accountDescription: `revision-${revision}` },
              });
              yield* Tair.SecurityIpGroup("group", {
                instanceId: account.instanceId,
                name: "runner",
                securityIps: [revision ? "192.0.2.2/32" : "192.0.2.1/32"],
              });
              return { name: account.name };
            }),
          );
        const first = await deployProtocol(options, stack(0));
        expect(await deployProtocol(options, stack(0))).toEqual(first);
        expect(await deployProtocol(options, stack(1))).toEqual(first);
        expect(world.resources.passwordResets).toBe(1);
        expect(
          [...world.resources.accounts.values()][0]?.AccountDescription,
        ).toBe("revision-1");
        expect(
          world.captured
            .filter((x) => x.action === "DescribeAccounts")
            .every((x) => x.version === "2015-01-01"),
        ).toBe(true);
        await destroyProtocol(options, stack(1));
        expect(world.resources.accounts.size).toBe(0);
        expect(world.resources.groups.size).toBe(0);
        assertNoSecrets(world.captured);
      }),
    );
  });

  it("handles ACR namespaces, repository updates, ACL comment replacement, and retained parents", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = (revision: number) =>
          protocolStack(
            "AcrChildren",
            options,
            Effect.gen(function* () {
              const instance = yield* ACR.InstanceReference("instance", {
                instanceId: "cri-retained",
              });
              const ns = yield* ACR.Namespace("namespace", {
                instanceId: instance.instanceId,
                name: "example",
                settings: {
                  autoCreateRepo: !!revision,
                  defaultRepoType: "PRIVATE",
                  defaultRepoConfiguration: {
                    repoType: "PRIVATE",
                    tagImmutability: !!revision,
                    artifactBuildRuleParameters: { imageIndexOnly: !!revision },
                  },
                },
              });
              const repo = yield* ACR.Repository("repository", {
                instanceId: ns.instanceId,
                namespaceName: ns.name,
                name: "app",
                settings: {
                  repoType: "PRIVATE",
                  summary: `revision-${revision}`,
                  tagImmutability: !!revision,
                },
              });
              yield* ACR.EndpointAclEntry("acl", {
                instanceId: instance.instanceId,
                entry: "192.0.2.1/32",
                comment: `revision-${revision}`,
              });
              return { id: repo.repositoryId };
            }),
          );
        const first = await deployProtocol(options, stack(0));
        expect(await deployProtocol(options, stack(0))).toEqual(first);
        expect(await deployProtocol(options, stack(1))).toEqual(first);
        expect([...world.resources.repositories.values()][0]).toMatchObject({
          Summary: "revision-1",
          TagImmutability: true,
        });
        expect([...world.resources.namespaces.values()][0]).toMatchObject({
          AutoCreateRepo: true,
          DefaultRepoConfiguration: {
            RepoType: "PRIVATE",
            TagImmutability: true,
            ArtifactBuildRuleParameters: { ImageIndexOnly: true },
          },
        });
        expect([...world.resources.acls.values()][0]?.Comment).toBe(
          "revision-1",
        );
        expect(
          world
            .actions()
            .filter((x) => x === "CreateInstanceEndpointAclPolicy"),
        ).toHaveLength(2);
        world.resources.acrFailure = {
          action: "DeleteRepository",
          code: "FORBIDDEN",
        };
        await expect(destroyProtocol(options, stack(1))).rejects.toThrow();
        expect(world.resources.namespaces.size).toBe(1);
        expect(world.actions()).not.toContain("DeleteNamespace");
        await destroyProtocol(options, stack(1));
        expect(world.resources.repositories.size).toBe(0);
        expect(world.resources.namespaces.size).toBe(0);
        expect(world.resources.acls.size).toBe(0);
        expect(world.actions()).not.toContain("DeleteInstance");
      }),
    );
  });
});
