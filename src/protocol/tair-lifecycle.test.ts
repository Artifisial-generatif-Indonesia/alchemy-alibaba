import * as Tair from "@alicloud/r-kvstore20150101";
import type * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { alchemyTestRuntime, resourceBase } from "../test-support.ts";
import { Instance, InstanceProvider } from "../tair/instance.ts";
import { VSwitch, VSwitchProvider } from "../vpc/vswitch.ts";
import { Network, NetworkProvider } from "../vpc/network.ts";
import {
  fastWait,
  protocolClientLayer,
  withProtocolHarness,
} from "./harness.ts";

const tairNews = {
  name: "protocol-tair",
  password: Redacted.make("ProtocolPass1!"),
  create: {
    instanceType: "Redis",
    engineVersion: "7.0",
    instanceClass: "redis.shard.small.2.ce",
    chargeType: "PostPaid",
    networkType: "VPC",
    vpcId: "vpc-protocol",
    vSwitchId: "vsw-protocol",
    zoneId: "ap-southeast-5b",
  },
  ssl: "Enable" as const,
  evictionPolicy: "noeviction" as const,
  vpcAuthMode: "Open" as const,
};

const runWith = <A, Error>(
  host: string,
  program: Effect.Effect<A, Error, Provider.Provider<Instance>>,
): Promise<A> =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(
        InstanceProvider({
          wait: fastWait,
          createRecoveryWait: fastWait,
        }).pipe(Layer.provide(protocolClientLayer(host))),
      ),
      Effect.provide(alchemyTestRuntime),
    ),
  );

describe("Tair protocol lifecycle", { timeout: 30_000 }, () => {
  it("recovers a lock-rejected create that Alibaba still accepted", async () => {
    await withProtocolHarness(
      async ({ server, world, clients }) => {
        world.script({
          action: "CreateInstance",
          code: "CanNotAcquireLock",
          accept: true,
        });
        const created = await runWith(
          server.host,
          Effect.gen(function* () {
            const provider = yield* Instance.Provider;
            return yield* provider.reconcile({
              ...resourceBase("tair-lock"),
              news: tairNews,
              olds: undefined,
              output: undefined,
            });
          }),
        );
        expect(created.instanceId).toMatch(/^r-test/);
        expect(created.status).toBe("Normal");
        expect(world.tairCreates()).toBe(1);
        expect(world.activeTair()).toHaveLength(1);
        const list = await clients.tair.describeInstances(
          new Tair.DescribeInstancesRequest({ pageNumber: 1, pageSize: 50 }),
        );
        expect(list.body?.instances?.KVStoreInstance).toHaveLength(1);
      },
      { tairDescribesUntilNormal: 2, omitCreatingIdentityReads: 1 },
    );
  });

  it("fills identity when creating attributes omit it", async () => {
    await withProtocolHarness(
      async ({ server, world }) => {
        const created = await runWith(
          server.host,
          Effect.gen(function* () {
            const provider = yield* Instance.Provider;
            return yield* provider.reconcile({
              ...resourceBase("tair-partial"),
              news: {
                name: "protocol-tair-partial",
                create: tairNews.create,
              },
              olds: undefined,
              output: undefined,
            });
          }),
        );
        expect(created).toMatchObject({
          instanceId: expect.stringMatching(/^r-test/),
          name: "protocol-tair-partial",
          status: "Normal",
        });
        expect(world.activeTair()[0]?.instanceId).toBe(created.instanceId);
      },
      { omitCreatingIdentityReads: 2, tairDescribesUntilNormal: 3 },
    );
  });

  it("retries IncorrectDBInstanceState and serializes SSL then VPC auth then config", async () => {
    await withProtocolHarness(
      async ({ server, world }) => {
        await runWith(
          server.host,
          Effect.gen(function* () {
            const provider = yield* Instance.Provider;
            return yield* provider.reconcile({
              ...resourceBase("tair-ssl"),
              news: tairNews,
              olds: undefined,
              output: undefined,
            });
          }),
        );
        const actions = world.actions();
        const ssl = actions.indexOf("ModifyInstanceSSL");
        const auth = actions.indexOf("ModifyInstanceVpcAuthMode");
        const config = actions.indexOf("ModifyInstanceConfig");
        expect(ssl).toBeGreaterThan(-1);
        expect(auth).toBeGreaterThan(ssl);
        expect(config).toBeGreaterThan(auth);
        expect(
          world.captured.filter((item) => item.action === "ModifyInstanceSSL")
            .length,
        ).toBeGreaterThan(1);
      },
      { tairSslRejects: 2, tairDescribesUntilNormal: 1 },
    );
  });

  it("preserves IncorrectDBInstanceState when SSL never becomes accepted", async () => {
    await withProtocolHarness(
      async ({ server }) => {
        const error = await Effect.runPromise(
          Effect.flip(
            Effect.gen(function* () {
              const provider = yield* Instance.Provider;
              return yield* provider.reconcile({
                ...resourceBase("tair-ssl-timeout"),
                news: tairNews,
                olds: undefined,
                output: undefined,
              });
            }).pipe(
              Effect.provide(
                InstanceProvider({
                  wait: { attempts: 2, interval: 0 },
                  createRecoveryWait: fastWait,
                }).pipe(Layer.provide(protocolClientLayer(server.host))),
              ),
              Effect.provide(alchemyTestRuntime),
            ),
          ),
        );
        expect(error).toMatchObject({
          _tag: "AlibabaProviderError",
          code: "IncorrectDBInstanceState",
          operation: "ModifyInstanceSSL",
        });
      },
      { tairSslRejects: 20 },
    );
  });

  it("hides Released instances from DescribeInstances and requires DestroyInstance", async () => {
    await withProtocolHarness(async ({ server, world, clients }) => {
      const created = await runWith(
        server.host,
        Effect.gen(function* () {
          const provider = yield* Instance.Provider;
          const output = yield* provider.reconcile({
            ...resourceBase("tair-recycle"),
            news: { name: "protocol-tair-recycle", create: tairNews.create },
            olds: undefined,
            output: undefined,
          });
          yield* provider.delete({
            ...resourceBase("tair-recycle"),
            olds: { name: "protocol-tair-recycle", create: tairNews.create },
            output,
          });
          return output;
        }),
      );
      expect(world.actions()).toContain("DeleteInstance");
      expect(world.actions()).toContain("DestroyInstance");
      expect(world.actions()).toContain("DescribeInstancesOverview");
      const hidden = await clients.tair.describeInstances(
        new Tair.DescribeInstancesRequest({
          instanceIds: created.instanceId,
        }),
      );
      expect(hidden.body?.instances?.KVStoreInstance ?? []).toHaveLength(0);
      expect(world.activeTair()).toHaveLength(0);
    });
  });

  it("does not treat a live overview row as absent during inconsistent detail reads", async () => {
    await withProtocolHarness(async ({ server, world }) => {
      const created = await runWith(
        server.host,
        Effect.gen(function* () {
          const provider = yield* Instance.Provider;
          return yield* provider.reconcile({
            ...resourceBase("tair-inconsistent-delete"),
            news: {
              name: "protocol-tair-inconsistent-delete",
              create: tairNews.create,
            },
            olds: undefined,
            output: undefined,
          });
        }),
      );
      world.tairDetailReadOmissions = 2;
      await runWith(
        server.host,
        Effect.gen(function* () {
          const provider = yield* Instance.Provider;
          yield* provider.delete({
            ...resourceBase("tair-inconsistent-delete"),
            olds: {
              name: "protocol-tair-inconsistent-delete",
              create: tairNews.create,
            },
            output: created,
          });
        }),
      );
      expect(world.actions()).toContain("DeleteInstance");
      expect(world.actions()).toContain("DestroyInstance");
      expect(world.activeTair()).toHaveLength(0);
    });
  });

  it("fails deletion visibly when live overview and detail reads stay inconsistent", async () => {
    await withProtocolHarness(async ({ server, world }) => {
      const created = await runWith(
        server.host,
        Effect.gen(function* () {
          const provider = yield* Instance.Provider;
          return yield* provider.reconcile({
            ...resourceBase("tair-inconsistent-timeout"),
            news: {
              name: "protocol-tair-inconsistent-timeout",
              create: tairNews.create,
            },
            olds: undefined,
            output: undefined,
          });
        }),
      );
      world.tairDetailReadOmissions = 100;
      await expect(
        runWith(
          server.host,
          Effect.gen(function* () {
            const provider = yield* Instance.Provider;
            yield* provider.delete({
              ...resourceBase("tair-inconsistent-timeout"),
              olds: {
                name: "protocol-tair-inconsistent-timeout",
                create: tairNews.create,
              },
              output: created,
            });
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "AlibabaObservationConflictError",
        operation: "ObserveInstanceForDelete",
        resourceId: created.instanceId,
        attempts: 20,
      });
      expect(world.actions()).not.toContain("DeleteInstance");
      expect(world.activeTair()).toHaveLength(1);
    });
  });

  it("waits through delayed Kvstore detachment before deleting a vSwitch", async () => {
    await withProtocolHarness(
      async ({ server, world }) => {
        const program = Effect.gen(function* () {
          const networkProvider = yield* Network.Provider;
          const vswitchProvider = yield* VSwitch.Provider;
          const tairProvider = yield* Instance.Provider;
          const network = yield* networkProvider.reconcile({
            ...resourceBase("vpc"),
            news: { name: "protocol-vpc", cidrBlock: "10.40.0.0/16" },
            olds: undefined,
            output: undefined,
          });
          const vswitch = yield* vswitchProvider.reconcile({
            ...resourceBase("vsw"),
            news: {
              vpcId: network.vpcId,
              name: "protocol-vsw",
              cidrBlock: "10.40.1.0/24",
              zoneId: "ap-southeast-5b",
            },
            olds: undefined,
            output: undefined,
          });
          const tair = yield* tairProvider.reconcile({
            ...resourceBase("tair"),
            news: {
              name: "protocol-tair-dep",
              create: {
                ...tairNews.create,
                vpcId: network.vpcId,
                vSwitchId: vswitch.vSwitchId,
              },
            },
            olds: undefined,
            output: undefined,
          });
          yield* tairProvider.delete({
            ...resourceBase("tair"),
            olds: {
              name: "protocol-tair-dep",
              create: {
                ...tairNews.create,
                vpcId: network.vpcId,
                vSwitchId: vswitch.vSwitchId,
              },
            },
            output: tair,
          });
          yield* vswitchProvider.delete({
            ...resourceBase("vsw"),
            olds: {
              vpcId: network.vpcId,
              name: "protocol-vsw",
              cidrBlock: "10.40.1.0/24",
              zoneId: "ap-southeast-5b",
            },
            output: vswitch,
          });
          return { network, vswitch };
        });
        await Effect.runPromise(
          program.pipe(
            Effect.provide(
              Layer.mergeAll(
                NetworkProvider({ wait: fastWait }),
                VSwitchProvider({
                  wait: fastWait,
                  deleteDependencyWait: fastWait,
                }),
                InstanceProvider({
                  wait: fastWait,
                  createRecoveryWait: fastWait,
                }),
              ).pipe(Layer.provide(protocolClientLayer(server.host))),
            ),
            Effect.provide(alchemyTestRuntime),
          ),
        );
        expect(world.vswitches.size).toBe(0);
        expect(
          world.captured.some(
            (item) =>
              item.action === "DeleteVSwitch" &&
              world.actions().filter((action) => action === "DeleteVSwitch")
                .length > 1,
          ),
        ).toBe(true);
      },
      { tairKvstoreHoldAfterDestroy: 2 },
    );
  });
});
