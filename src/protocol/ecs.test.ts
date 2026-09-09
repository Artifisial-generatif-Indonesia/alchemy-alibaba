import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import * as ECS from "../ecs/index.ts";
import * as RDS from "../rds/index.ts";
import * as Tair from "../tair/index.ts";
import { withProtocolHarness, withTempDir } from "./harness.ts";
import {
  deployProtocol,
  destroyProtocol,
  protocolMakeOptions,
  protocolStack,
} from "./stack.ts";

const base = {
  imageId: "img-linux",
  instanceType: "ecs.small",
  vSwitchId: "vsw-test",
  securityGroupIds: ["sg-test"],
};

describe("ECS real SDK lifecycle", { timeout: 30_000 }, () => {
  it("preserves an independent disk across VM replacement and imports only a public key", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = (revision: number) =>
          protocolStack(
            "EcsPersistentDisk",
            options,
            Effect.gen(function* () {
              const key = yield* ECS.KeyPair("key", {
                publicKey:
                  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKeyOnly test",
                tags: revision ? {} : { remove: "yes" },
              });
              const disk = yield* ECS.Disk("data", {
                zoneId: "ap-southeast-5a",
                size: revision ? 80 : 40,
                tags: revision ? {} : { remove: "yes" },
              });
              const vm = yield* ECS.Instance("vm", {
                ...base,
                imageId: revision ? "img-new" : "img-linux",
                keyPairName: key.name,
              });
              yield* ECS.DiskAttachment("mount", {
                diskId: disk.diskId,
                instanceId: vm.instanceId,
              });
              return { disk: disk.diskId, vm: vm.instanceId, key: key.name };
            }),
          );
        const first = await deployProtocol(options, stack(0));
        const second = await deployProtocol(options, stack(1));
        expect(second.disk).toBe(first.disk);
        expect(second.key).toBe(first.key);
        expect(second.vm).not.toBe(first.vm);
        expect(world.ecs.disks.get(first.disk)).toMatchObject({
          Size: 80,
          InstanceId: second.vm,
          DeleteWithInstance: false,
        });
        expect(
          world.ecs.requests.filter((r) => r.action === "CreateDisk"),
        ).toHaveLength(1);
        await destroyProtocol(options, stack(1));
        expect(
          world.ecs.disks.size +
            world.ecs.keyPairs.size +
            world.ecs.instances.size,
        ).toBe(0);
      }),
    );
  });

  it("resizes in place and changes group membership with IPv6 egress and group ingress", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = (revision: number) =>
          protocolStack(
            "EcsResize",
            options,
            Effect.gen(function* () {
              const first = yield* ECS.SecurityGroup("first", {
                vpcId: "vpc-test",
              });
              const second = yield* ECS.SecurityGroup("second", {
                vpcId: "vpc-test",
              });
              yield* ECS.SecurityGroupIngress("internal", {
                securityGroupId: first.securityGroupId,
                sourceGroupId: second.securityGroupId,
                ipProtocol: "tcp",
                portRange: "5432/5432",
              });
              yield* ECS.SecurityGroupEgress("outbound", {
                securityGroupId: first.securityGroupId,
                ipv6DestCidrIp: "2001:db8::/32",
                ipProtocol: "tcp",
                portRange: "443/443",
              });
              return yield* ECS.Instance("vm", {
                ...base,
                instanceType: revision ? "ecs.large" : "ecs.small",
                securityGroupIds: [
                  revision ? second.securityGroupId : first.securityGroupId,
                ],
              });
            }),
          );
        const first = await deployProtocol(options, stack(0));
        const second = await deployProtocol(options, stack(1));
        expect(second.instanceId).toBe(first.instanceId);
        expect(world.ecs.instances.get(first.instanceId)?.InstanceType).toBe(
          "ecs.large",
        );
        expect(
          world.ecs.requests.filter((r) => r.action === "RunInstances"),
        ).toHaveLength(1);
        const actions = world.ecs.requests.map((r) => r.action);
        expect(actions.indexOf("JoinSecurityGroup")).toBeLessThan(
          actions.indexOf("LeaveSecurityGroup"),
        );
        expect(actions.indexOf("StopInstance")).toBeLessThan(
          actions.indexOf("ModifyInstanceSpec"),
        );
        expect(
          [...world.ecs.rules.values()].some(
            (r) =>
              r.rule.Direction === "egress" &&
              r.rule.Ipv6DestCidrIp === "2001:db8::/32",
          ),
        ).toBe(true);
        await destroyProtocol(options, stack(1));
        expect(
          world.ecs.rules.size +
            world.ecs.instances.size +
            world.ecs.groups.size,
        ).toBe(0);
      }),
    );
  });

  it("persists a VM, ingress and private database access; updates, then removes children before the VM", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = (revision: number) =>
          protocolStack(
            "EcsPrivateDev",
            options,
            Effect.gen(function* () {
              const group = yield* ECS.SecurityGroup("group", {
                vpcId: "vpc-test",
                description: `revision-${revision}`,
                tags: { owner: "dev", ...(revision ? {} : { remove: "yes" }) },
              });
              yield* ECS.SecurityGroupIngress("ssh", {
                securityGroupId: group.securityGroupId,
                ipProtocol: "tcp",
                portRange: "22/22",
                sourceCidrIp: "192.0.2.1/32",
              });
              const vm = yield* ECS.Instance("vm", {
                ...base,
                securityGroupIds: [group.securityGroupId],
                userData: Redacted.make(
                  "#!/bin/sh\necho ProtocolCloudInitSecret",
                ),
                internetMaxBandwidthOut: 1,
                description: `revision-${revision}`,
                deletionProtection: false,
                autoReleaseTime: revision ? "" : "2030-01-01T00:00:00Z",
                tags: revision ? { revision: "1" } : { remove: "yes" },
              });
              yield* RDS.SecurityIpGroup("rds-access", {
                instanceId: "rds-existing",
                name: "ecsdev",
                securityIps: [Output.interpolate`${vm.privateIp}/32`],
              });
              yield* Tair.SecurityIpGroup("tair-access", {
                instanceId: "tair-existing",
                name: "ecsdev",
                securityIps: [Output.interpolate`${vm.privateIp}/32`],
              });
              return {
                instanceId: vm.instanceId,
                privateIp: vm.privateIp,
                publicIp: vm.publicIp,
              };
            }),
          );
        const first = await deployProtocol(options, stack(0));
        expect(first).toMatchObject({
          privateIp: "10.40.1.10",
          publicIp: "192.0.2.10",
        });
        const mutations = () =>
          world.ecs.requests.filter((r) => !r.action.startsWith("Describe"));
        const count = mutations().length;
        expect(await deployProtocol(options, stack(0))).toEqual(first);
        expect(mutations()).toHaveLength(count);
        expect(await deployProtocol(options, stack(1))).toEqual(first);
        const vm = [...world.ecs.instances.values()][0]!;
        expect(vm.Description).toBe("revision-1");
        expect(vm.AutoReleaseTime).toBe("");
        expect(vm.Tags.Tag.some((t) => t.TagKey === "remove")).toBe(false);
        expect(
          [...world.resources.groups.values()].every(
            (g) => g.ips === "10.40.1.10/32",
          ),
        ).toBe(true);
        const create = world.ecs.requests.find(
          (r) => r.action === "RunInstances",
        )!.params;
        expect(create).toMatchObject({
          Amount: "1",
          MinAmount: "1",
          InstanceChargeType: "PostPaid",
          RegionId: "ap-southeast-5",
          "SystemDisk.Size": "40",
          UserData: "[present]",
        });
        expect(create.ClientToken).toMatch(/^create-/);
        expect(JSON.stringify(world.ecs.requests)).not.toContain(
          "ProtocolCloudInitSecret",
        );
        await destroyProtocol(options, stack(1));
        expect(world.ecs.instances.size).toBe(0);
        expect(world.ecs.groups.size).toBe(0);
        expect(world.ecs.rules.size).toBe(0);
        const actions = world.actions();
        expect(actions.lastIndexOf("ModifySecurityIps")).toBeLessThan(
          actions.indexOf("DeleteInstance"),
        );
        expect(actions.indexOf("StopInstance")).toBeLessThan(
          actions.indexOf("DeleteInstance"),
        );
        expect(actions.indexOf("DeleteInstance")).toBeLessThan(
          actions.indexOf("DeleteSecurityGroup"),
        );
        expect(
          world.ecs.requests.find((r) => r.action === "StopInstance")?.params
            .ForceStop,
        ).toBe("false");
        expect(
          world.ecs.requests.find((r) => r.action === "DeleteInstance")?.params
            .Force,
        ).toBe("false");
      }),
    );
  });

  it.each(["RunInstances", "CreateSecurityGroup"])(
    "recovers accepted %s failures without duplicate resources",
    async (action) => {
      await withTempDir((directory) =>
        withProtocolHarness(async ({ server, world }) => {
          world.script({
            action,
            code: "InvalidConcurrentOperate",
            accept: true,
            times: 1,
          });
          const options = protocolMakeOptions(server.host, directory);
          const stack = protocolStack(
            "EcsRecovery",
            options,
            Effect.gen(function* () {
              const group = yield* ECS.SecurityGroup("group", {
                vpcId: "vpc-test",
              });
              return yield* ECS.Instance("vm", {
                ...base,
                securityGroupIds: [group.securityGroupId],
              });
            }),
          );
          const value = await deployProtocol(options, stack);
          expect(value.privateIp).toBe("10.40.1.10");
          expect(world.ecs.instances.size).toBe(1);
          expect(world.ecs.groups.size).toBe(1);
          const tokens = world.ecs.requests
            .filter((r) => r.action === action)
            .map((r) => r.params.ClientToken);
          expect(new Set(tokens).size).toBe(1);
          await destroyProtocol(options, stack);
        }),
      );
    },
  );

  it("blocks protected deletion and recovers using the persisted graph", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = (protectedVm: boolean) =>
          protocolStack(
            "EcsProtection",
            options,
            Effect.gen(function* () {
              const group = yield* ECS.SecurityGroup("group", {
                vpcId: "vpc-test",
              });
              return yield* ECS.Instance("vm", {
                ...base,
                securityGroupIds: [group.securityGroupId],
                deletionProtection: protectedVm,
              });
            }),
          );
        const initial = await deployProtocol(options, stack(true));
        await expect(destroyProtocol(options, stack(true))).rejects.toThrow(
          /deletion protection/i,
        );
        expect(
          world.ecs.requests.some(
            (r) =>
              r.action === "StopInstance" || r.action === "DeleteSecurityGroup",
          ),
        ).toBe(false);
        expect((await deployProtocol(options, stack(false))).instanceId).toBe(
          initial.instanceId,
        );
        await destroyProtocol(options, stack(false));
        expect(world.ecs.instances.size).toBe(0);
      }),
    );
  });

  it("keeps state and parents when deletion is denied, then retries successfully", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = protocolStack(
          "EcsDeleteFailure",
          options,
          Effect.gen(function* () {
            const group = yield* ECS.SecurityGroup("group", {
              vpcId: "vpc-test",
            });
            return yield* ECS.Instance("vm", {
              ...base,
              securityGroupIds: [group.securityGroupId],
            });
          }),
        );
        await deployProtocol(options, stack);
        world.script({
          action: "DeleteInstance",
          code: "Forbidden",
          statusCode: 403,
        });
        await expect(destroyProtocol(options, stack)).rejects.toThrow();
        expect(world.ecs.instances.size).toBe(1);
        expect(world.ecs.groups.size).toBe(1);
        await destroyProtocol(options, stack);
        expect(world.ecs.instances.size).toBe(0);
      }),
    );
  });

  it("fails closed on malformed inventories and generic 404s", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = protocolStack(
          "EcsBadInventory",
          options,
          ECS.Instance("vm", base),
        );
        world.ecs.malformedInventory = true;
        await expect(deployProtocol(options, stack)).rejects.toThrow(
          /inventory is missing/,
        );
        expect(world.ecs.instances.size).toBe(0);
        world.ecs.malformedInventory = false;
        world.script({
          action: "DescribeInstances",
          code: "NotFound",
          statusCode: 404,
        });
        await expect(deployProtocol(options, stack)).rejects.toThrow();
        expect(world.ecs.instances.size).toBe(0);
      }),
    );
  });

  it("restarts stopped instances, and uses a fresh purchase token after teardown", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = protocolStack(
          "EcsRestart",
          options,
          ECS.Instance("vm", base),
        );
        const initial = await deployProtocol(options, stack);
        world.ecs.instances.get(initial.instanceId)!.Status = "Stopped";
        expect((await deployProtocol(options, stack)).instanceId).toBe(
          initial.instanceId,
        );
        expect(world.ecs.instances.get(initial.instanceId)!.Status).toBe(
          "Running",
        );
        await destroyProtocol(options, stack);
        const second = await deployProtocol(options, stack);
        expect(second.instanceId).not.toBe(initial.instanceId);
        const tokens = world.ecs.requests
          .filter((r) => r.action === "RunInstances")
          .map((r) => r.params.ClientToken);
        expect(new Set(tokens).size).toBe(2);
        await destroyProtocol(options, stack);
      }),
    );
  });

  it("paginates ingress observation and deletes only its rule id", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = protocolStack(
          "EcsRules",
          options,
          Effect.gen(function* () {
            const group = yield* ECS.SecurityGroup("group", {
              vpcId: "vpc-test",
            });
            return yield* ECS.SecurityGroupIngress("rule", {
              securityGroupId: group.securityGroupId,
              ipProtocol: "tcp",
              portRange: "22/22",
              sourceCidrIp: "192.0.2.1/32",
            });
          }),
        );
        const rule = await deployProtocol(options, stack);
        const current = world.ecs.rules.get(rule.securityGroupRuleId)!;
        world.ecs.rules.clear();
        world.ecs.rules.set("sgr-unmanaged", {
          group: current.group,
          rule: {
            ...current.rule,
            SecurityGroupRuleId: "sgr-unmanaged",
            PortRange: "443/443",
          },
        });
        world.ecs.rules.set(rule.securityGroupRuleId, current);
        world.ecs.permissionPageSize = 1;
        expect(await deployProtocol(options, stack)).toEqual(rule);
        await destroyProtocol(options, stack);
        expect(
          world.ecs.requests.find((r) => r.action === "RevokeSecurityGroup")
            ?.params["SecurityGroupRuleId.1"],
        ).toBe(rule.securityGroupRuleId);
        expect(
          world.ecs.requests.filter((r) => r.action === "RevokeSecurityGroup"),
        ).toHaveLength(1);
      }),
    );
  });
  it("replaces immutable settings without adopting the old same-named VM", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = (imageId: string) =>
          protocolStack(
            "EcsReplacement",
            options,
            Effect.gen(function* () {
              const vm = yield* ECS.Instance("vm", { ...base, imageId });
              yield* RDS.SecurityIpGroup("rds-access", {
                instanceId: "rds-existing",
                name: "replacevm",
                securityIps: [Output.interpolate`${vm.privateIp}/32`],
              });
              yield* Tair.SecurityIpGroup("tair-access", {
                instanceId: "tair-existing",
                name: "replacevm",
                securityIps: [Output.interpolate`${vm.privateIp}/32`],
              });
              return { instanceId: vm.instanceId, privateIp: vm.privateIp };
            }),
          );
        const first = await deployProtocol(options, stack("img-first"));
        world.ecs.privateIp = "10.40.1.11";
        const second = await deployProtocol(options, stack("img-second"));
        expect(second.instanceId).not.toBe(first.instanceId);
        expect(second.privateIp).toBe("10.40.1.11");
        expect(
          [...world.resources.groups.values()].every(
            (group) => group.ips === "10.40.1.11/32",
          ),
        ).toBe(true);
        expect(world.ecs.instances.size).toBe(1);
        const actions = world.ecs.requests.map((r) => r.action);
        expect(actions.indexOf("DeleteInstance")).toBeLessThan(
          actions.lastIndexOf("RunInstances"),
        );
        await destroyProtocol(options, stack("img-second"));
      }),
    );
  });

  it("recreates an expired VM with a fresh generation instead of replaying its old token", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = protocolStack(
          "EcsExpiry",
          options,
          ECS.Instance("vm", base),
        );
        const first = await deployProtocol(options, stack);
        world.ecs.instances.delete(first.instanceId);
        const next = await deployProtocol(options, stack);
        expect(next.instanceId).not.toBe(first.instanceId);
        expect(world.ecs.instances.size).toBe(1);
        await destroyProtocol(options, stack);
      }),
    );
  });

  it("does not buy a VM without security groups", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = protocolStack(
          "EcsInvalid",
          options,
          ECS.Instance("vm", { ...base, securityGroupIds: [] }),
        );
        await expect(deployProtocol(options, stack)).rejects.toThrow(
          /security group/i,
        );
        expect(
          world.ecs.requests.some((r) => r.action === "RunInstances"),
        ).toBe(false);
      }),
    );
  });
  it("fails closed when a saved ingress rule is edited externally", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = protocolStack(
          "EcsRuleDrift",
          options,
          Effect.gen(function* () {
            const group = yield* ECS.SecurityGroup("group", {
              vpcId: "vpc-test",
            });
            return yield* ECS.SecurityGroupIngress("rule", {
              securityGroupId: group.securityGroupId,
              ipProtocol: "tcp",
              portRange: "22/22",
              sourceCidrIp: "192.0.2.1/32",
            });
          }),
        );
        const rule = await deployProtocol(options, stack);
        world.ecs.rules.get(rule.securityGroupRuleId)!.rule.SourceCidrIp =
          "0.0.0.0/0";
        await expect(deployProtocol(options, stack)).rejects.toThrow(
          /changed externally/,
        );
        expect(world.ecs.rules.size).toBe(1);
        world.ecs.rules.get(rule.securityGroupRuleId)!.rule.SourceCidrIp =
          "192.0.2.1/32";
        await destroyProtocol(options, stack);
      }),
    );
  });

  it("continues teardown after an accepted stop returns an error", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = protocolStack(
          "EcsStopRecovery",
          options,
          ECS.Instance("vm", base),
        );
        await deployProtocol(options, stack);
        world.script({
          action: "StopInstance",
          code: "IncorrectInstanceStatus",
          accept: true,
        });
        await destroyProtocol(options, stack);
        expect(world.ecs.instances.size).toBe(0);
      }),
    );
  });
});
