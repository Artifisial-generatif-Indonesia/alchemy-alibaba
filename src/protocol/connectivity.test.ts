import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import * as VPC from "../vpc/index.ts";
import { withProtocolHarness, withTempDir } from "./harness.ts";
import {
  deployProtocol,
  destroyProtocol,
  protocolMakeOptions,
  protocolStack,
} from "./stack.ts";

it(
  "owns EIP, NAT and SNAT through persisted updates and dependency-ordered teardown",
  { timeout: 30000 },
  async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = (revision: number) =>
          protocolStack(
            "Connectivity",
            options,
            Effect.gen(function* () {
              const nat = yield* VPC.NatGateway("gateway", {
                vpcId: "vpc-test",
                vSwitchId: revision > 1 ? "vsw-replacement" : "vsw-test",
                tags: revision ? { revision: "1" } : { remove: "yes" },
              });
              const eip = yield* VPC.Eip("address", {
                bandwidth: revision ? 10 : 5,
                tags: revision ? {} : { remove: "yes" },
              });
              const association = yield* VPC.EipAssociation("association", {
                allocationId: eip.allocationId,
                instanceId: nat.natGatewayId,
                instanceType: "Nat",
              });
              const snat = yield* VPC.SnatEntry("snat", {
                snatTableId: nat.snatTableId,
                sourceVSwitchId: "vsw-test",
                snatIp: association.ipAddress,
              });
              return {
                natId: nat.natGatewayId,
                eipId: eip.allocationId,
                ip: eip.ipAddress,
                snatId: snat.snatEntryId,
              };
            }),
          );
        const first = await deployProtocol(options, stack(0));
        const mutations = () =>
          world.connectivity.requests.filter(
            (r) => !r.action.startsWith("Describe"),
          );
        const initialMutations = mutations().length;
        expect(await deployProtocol(options, stack(0))).toEqual(first);
        expect(mutations()).toHaveLength(initialMutations);
        expect(await deployProtocol(options, stack(1))).toEqual(first);
        expect(world.connectivity.eips.get(first.eipId)?.Bandwidth).toBe("10");
        expect(
          world.connectivity.nats
            .get(first.natId)
            ?.Tags.Tag.some((t) => t.TagKey === "remove"),
        ).toBe(false);
        world.connectivity.eips.get(first.eipId)!.Bandwidth = "2";
        await deployProtocol(options, stack(1));
        expect(world.connectivity.eips.get(first.eipId)?.Bandwidth).toBe("10");
        const replaced = await deployProtocol(options, stack(2));
        expect(replaced.natId).not.toBe(first.natId);
        expect(replaced.snatId).not.toBe(first.snatId);
        expect(world.connectivity.nats.size).toBe(1);
        expect(world.connectivity.snats.size).toBe(1);
        const teardownStart = mutations().length;
        await destroyProtocol(options, stack(2));
        expect(
          world.connectivity.eips.size +
            world.connectivity.nats.size +
            world.connectivity.snats.size,
        ).toBe(0);
        const actions = mutations()
          .slice(teardownStart)
          .map((r) => r.action);
        expect(actions.indexOf("DeleteSnatEntry")).toBeLessThan(
          actions.indexOf("UnassociateEipAddress"),
        );
        expect(actions.indexOf("UnassociateEipAddress")).toBeLessThan(
          actions.indexOf("ReleaseEipAddress"),
        );
        expect(actions.indexOf("UnassociateEipAddress")).toBeLessThan(
          actions.indexOf("DeleteNatGateway"),
        );
      }),
    );
  },
);
