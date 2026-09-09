import * as TairSdk from "@alicloud/r-kvstore20150101";
import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import * as Tair from "../tair/index.ts";
import * as VPC from "../vpc/index.ts";
import { RemovalPolicy } from "alchemy/RemovalPolicy";
import { listPersistedFqns } from "./file-state.ts";
import { withProtocolHarness, withTempDir } from "./harness.ts";
import {
  deployProtocol,
  destroyProtocol,
  protocolMakeOptions,
  protocolStack,
} from "./stack.ts";
const tairCreate = (vpcId: Input<string>, vSwitchId: Input<string>) => ({
  instanceType: "Redis",
  engineVersion: "7.0",
  instanceClass: "redis.shard.small.2.ce",
  chargeType: "PostPaid",
  networkType: "VPC",
  vpcId,
  vSwitchId,
  zoneId: "ap-southeast-5b",
});
describe("Alchemy stack protocol lifecycle", { timeout: 30000 }, () => {
  it.each(["retain", "destroy"] as const)(
    "honors %s removal policy when an update removes a resource from the graph",
    async (policy) => {
      const stage = "test-protocol";
      await withTempDir(async (directory) => {
        await withProtocolHarness(async ({ server, world }) => {
          const options = {
            ...protocolMakeOptions(server.host, directory),
            stage,
          };
          const stackName = "ExampleProtocolEnvironmentRetention";
          const populated = protocolStack(
            stackName,
            options,
            Effect.gen(function* () {
              return yield* VPC.Network("vpc", {
                name: `protocol-${stage}-vpc`,
                cidrBlock: "10.40.0.0/16",
              });
            }).pipe(Effect.provideService(RemovalPolicy, policy)),
          );
          await deployProtocol(options, populated);
          expect(world.networks.size).toBe(1);
          const empty = protocolStack(
            stackName,
            options,
            Effect.succeed({}).pipe(
              Effect.provideService(RemovalPolicy, policy),
            ),
          );
          await deployProtocol(options, empty);
          expect(world.networks.size).toBe(policy === "retain" ? 1 : 0);
        });
      });
    },
  );
  it("creates, reuses persisted state, and tears down to zero", async () => {
    await withTempDir(async (directory) => {
      await withProtocolHarness(
        async ({ server, world }) => {
          const options = protocolMakeOptions(server.host, directory);
          const stack = protocolStack(
            "ExampleProtocolTair",
            options,
            Effect.gen(function* () {
              const network = yield* VPC.Network("vpc", {
                name: "protocol-stack-vpc",
                cidrBlock: "10.40.0.0/16",
              });
              const vswitch = yield* VPC.VSwitch("vsw", {
                vpcId: network.vpcId,
                name: "protocol-stack-vsw",
                cidrBlock: "10.40.1.0/24",
                zoneId: "ap-southeast-5b",
              });
              const tair = yield* Tair.Instance("tair", {
                name: "protocol-stack-tair",
                password: Redacted.make("ProtocolPass1!"),
                ...tairCreate(network.vpcId, vswitch.vSwitchId),
                ssl: "Enable",
                evictionPolicy: "noeviction",
                vpcAuthMode: "Open",
              });
              return {
                vpcId: network.vpcId,
                vswitchId: vswitch.vSwitchId,
                instanceId: tair.instanceId,
                status: tair.status,
              };
            }),
          );
          const created = await deployProtocol(options, stack);
          expect(created.status).toBe("Normal");
          expect(listPersistedFqns(directory).length).toBeGreaterThan(0);
          const createsBeforeRestart = world.tairCreates();
          const restarted = await deployProtocol(options, stack);
          expect(restarted.instanceId).toBe(created.instanceId);
          expect(world.tairCreates()).toBe(createsBeforeRestart);
          await destroyProtocol(options, stack);
          expect(world.networks.size).toBe(0);
          expect(world.vswitches.size).toBe(0);
          expect(world.activeTair()).toHaveLength(0);
          expect(listPersistedFqns(directory)).toEqual([]);
        },
        { tairSslRejects: 1, tairKvstoreHoldAfterDestroy: 1 },
      );
    });
  });
  it("recovers an accepted create that was not persisted by Alchemy", async () => {
    await withTempDir(async (directory) => {
      await withProtocolHarness(async ({ server, world, clients }) => {
        await clients.tair.createInstance(
          new TairSdk.CreateInstanceRequest({
            regionId: "ap-southeast-5",
            instanceName: "protocol-restart-tair",
            instanceClass: "redis.shard.small.2.ce",
            instanceType: "Redis",
            engineVersion: "7.0",
            networkType: "VPC",
            vpcId: "vpc-external",
            vSwitchId: "vsw-external",
            token: "external-create-token",
            tag: [
              { key: "alchemy::stack", value: "ExampleProtocolRestart" },
              { key: "alchemy::stage", value: "test-protocol" },
              { key: "alchemy::id", value: "tair" },
            ],
          }),
        );
        const options = protocolMakeOptions(server.host, directory);
        const stack = protocolStack(
          "ExampleProtocolRestart",
          options,
          Effect.gen(function* () {
            const tair = yield* Tair.Instance("tair", {
              name: "protocol-restart-tair",
              ...tairCreate("vpc-external", "vsw-external"),
            });
            return { instanceId: tair.instanceId };
          }),
        );
        const deployed = await deployProtocol(options, stack);
        expect(world.tairCreates()).toBe(1);
        expect(deployed.instanceId).toMatch(/^r-test/);
        expect(world.activeTair()).toHaveLength(1);
      });
    });
  });
  it("treats a duplicate tokenized create as the same instance", async () => {
    await withProtocolHarness(async ({ clients, world }) => {
      const request = new TairSdk.CreateInstanceRequest({
        regionId: "ap-southeast-5",
        instanceName: "protocol-token-tair",
        instanceClass: "redis.shard.small.2.ce",
        instanceType: "Redis",
        engineVersion: "7.0",
        token: "stable-create-token",
      });
      const first = await clients.tair.createInstance(request);
      const second = await clients.tair.createInstance(request);
      expect(second.body?.instanceId).toBe(first.body?.instanceId);
      expect(world.activeTair()).toHaveLength(1);
      expect(world.tairCreates()).toBe(2);
    });
  });
  it("retains parent VPC and vSwitch state when Tair destruction fails", async () => {
    await withTempDir(async (directory) => {
      await withProtocolHarness(async ({ server, world }) => {
        world.script({
          action: "DestroyInstance",
          code: "InternalError",
          times: 50,
        });
        const options = protocolMakeOptions(server.host, directory);
        const stack = protocolStack(
          "ExampleProtocolRetain",
          options,
          Effect.gen(function* () {
            const network = yield* VPC.Network("vpc", {
              name: "protocol-retain-vpc",
              cidrBlock: "10.40.0.0/16",
            });
            const vswitch = yield* VPC.VSwitch("vsw", {
              vpcId: network.vpcId,
              name: "protocol-retain-vsw",
              cidrBlock: "10.40.1.0/24",
              zoneId: "ap-southeast-5b",
            });
            yield* Tair.Instance("tair", {
              name: "protocol-retain-tair",
              ...tairCreate(network.vpcId, vswitch.vSwitchId),
            });
            return { vpcId: network.vpcId, vswitchId: vswitch.vSwitchId };
          }),
        );
        await deployProtocol(options, stack);
        await expect(destroyProtocol(options, stack)).rejects.toMatchObject({
          _tag: "DestroyError",
        });
        expect(world.networks.size).toBe(1);
        expect(world.vswitches.size).toBe(1);
        expect(world.activeTair()).toHaveLength(1);
        expect(listPersistedFqns(directory).length).toBeGreaterThan(0);
        world.faults.length = 0;
        await destroyProtocol(options, stack);
        expect(world.networks.size).toBe(0);
        expect(world.vswitches.size).toBe(0);
        expect(world.activeTair()).toHaveLength(0);
        expect(listPersistedFqns(directory)).toEqual([]);
      });
    });
  });
});
