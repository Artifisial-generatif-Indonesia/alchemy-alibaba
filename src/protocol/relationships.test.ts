import * as ACK from "@alicloud/cs20151215";
import * as RDS from "@alicloud/rds20140815";
import * as VPC from "@alicloud/vpc20160428";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import * as ACR from "../acr/index.ts";
import * as AlibabaACK from "../ack/index.ts";
import * as AlibabaRDS from "../rds/index.ts";
import * as VPCResources from "../vpc/index.ts";
import { withProtocolHarness, withTempDir } from "./harness.ts";
import {
  deployProtocol,
  destroyProtocol,
  protocolMakeOptions,
  protocolStack,
} from "./stack.ts";

describe("Example relationship protocol coverage", { timeout: 30_000 }, () => {
  it("rejects concurrent vSwitch creation in the same VPC", async () => {
    await withProtocolHarness(async ({ clients, world }) => {
      const vpc = await clients.vpc.createVpc(
        new VPC.CreateVpcRequest({
          regionId: "ap-southeast-5",
          vpcName: "protocol-concurrent-vpc",
          cidrBlock: "10.40.0.0/16",
        }),
      );
      world.createVSwitchBusy = true;
      await expect(
        clients.vpc.createVSwitch(
          new VPC.CreateVSwitchRequest({
            regionId: "ap-southeast-5",
            vpcId: vpc.body?.vpcId,
            vSwitchName: "protocol-vsw-a",
            cidrBlock: "10.40.1.0/24",
            zoneId: "ap-southeast-5a",
          }),
        ),
      ).rejects.toMatchObject({ code: "IncorrectVSwitchStatus" });
      world.createVSwitchBusy = false;
      const created = await clients.vpc.createVSwitch(
        new VPC.CreateVSwitchRequest({
          regionId: "ap-southeast-5",
          vpcId: vpc.body?.vpcId,
          vSwitchName: "protocol-vsw-a",
          cidrBlock: "10.40.1.0/24",
          zoneId: "ap-southeast-5a",
        }),
      );
      expect(created.body?.vSwitchId).toMatch(/^vsw-test/);
    });
  });

  it("recovers an ambiguous RDS create and refuses delete while Creating", async () => {
    await withTempDir(async (directory) => {
      await withProtocolHarness(
        async ({ server, world }) => {
          world.script({
            action: "CreateDBInstance",
            code: "InvalidConcurrentOperate",
            accept: true,
          });
          const options = protocolMakeOptions(server.host, directory);
          const stack = protocolStack(
            "ExampleProtocolRds",
            options,
            Effect.gen(function* () {
              const network = yield* VPCResources.Network("vpc", {
                name: "protocol-rds-vpc",
                cidrBlock: "10.40.0.0/16",
              });
              const vswitch = yield* VPCResources.VSwitch("vsw", {
                vpcId: network.vpcId,
                name: "protocol-rds-vsw",
                cidrBlock: "10.40.1.0/24",
                zoneId: "ap-southeast-5b",
              });
              const rds = yield* AlibabaRDS.Instance("rds", {
                name: "protocol-rds",
                create: {
                  engine: "PostgreSQL",
                  engineVersion: "16.0",
                  DBInstanceClass: "pg.n2.small.1",
                  DBInstanceNetType: "Intranet",
                  DBInstanceStorage: 20,
                  payType: "Postpaid",
                  securityIPList: "127.0.0.1",
                  VPCId: network.vpcId,
                  vSwitchId: vswitch.vSwitchId,
                },
              });
              return {
                instanceId: rds.instanceId,
                vswitchId: vswitch.vSwitchId,
              };
            }),
          );
          const created = await deployProtocol(options, stack);
          expect(created.instanceId).toMatch(/^rm-test/);
          expect(
            world.captured.filter((item) => item.action === "CreateDBInstance"),
          ).toHaveLength(1);
          await destroyProtocol(options, stack);
          expect(world.rds.size).toBe(0);
          expect(world.eniDependencyRejections).toBeGreaterThan(0);
        },
        { rdsDescribesUntilRunning: 3 },
      );
    });
  });

  it("rejects DeleteDBInstance while the instance is still Creating", async () => {
    await withProtocolHarness(
      async ({ clients }) => {
        const created = await clients.rds.createDBInstance(
          new RDS.CreateDBInstanceRequest({
            regionId: "ap-southeast-5",
            engine: "PostgreSQL",
            engineVersion: "16.0",
            DBInstanceClass: "pg.n2.small.1",
            DBInstanceStorage: 20,
            DBInstanceNetType: "Intranet",
            DBInstanceDescription: "protocol-rds-creating",
            payType: "Postpaid",
            securityIPList: "127.0.0.1",
          }),
        );
        await expect(
          clients.rds.deleteDBInstance(
            new RDS.DeleteDBInstanceRequest({
              DBInstanceId: created.body?.DBInstanceId,
            }),
          ),
        ).rejects.toMatchObject({ code: "IncorrectDBInstanceState" });
      },
      { rdsDescribesUntilRunning: 99 },
    );
  });

  it("leaves managed ENIs after ACK deletion and links ACR to the vSwitch", async () => {
    await withTempDir(async (directory) => {
      await withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = protocolStack(
          "ExampleProtocolAckAcr",
          options,
          Effect.gen(function* () {
            const network = yield* VPCResources.Network("vpc", {
              name: "protocol-ack-vpc",
              cidrBlock: "10.40.0.0/16",
            });
            const vswitch = yield* VPCResources.VSwitch("vsw", {
              vpcId: network.vpcId,
              name: "protocol-ack-vsw",
              cidrBlock: "10.40.1.0/24",
              zoneId: "ap-southeast-5b",
            });
            const cluster = yield* AlibabaACK.ManagedCluster("cluster", {
              name: "protocol-ack",
              create: {
                clusterType: "ManagedKubernetes",
                clusterSpec: "ack.pro.small",
                profile: "Default",
                addons: [{ name: "flannel" }],
                vpcid: network.vpcId,
                vswitchIds: [vswitch.vSwitchId],
                containerCidr: "172.20.0.0/16",
                serviceCidr: "172.21.0.0/20",
              },
            });
            const registry = yield* ACR.InstanceReference("registry", {
              instanceId: "cri-retained",
            });
            const link = yield* ACR.VpcEndpointLink("link", {
              instanceId: registry.instanceId,
              vpcId: network.vpcId,
              vswitchId: vswitch.vSwitchId,
              enablePrivateZoneRecord: true,
            });
            return {
              clusterId: cluster.clusterId,
              vpcId: network.vpcId,
              vswitchId: vswitch.vSwitchId,
              linkStatus: link.status,
            };
          }),
        );
        const created = await deployProtocol(options, stack);
        expect(created.clusterId).toMatch(/^c-test/);
        expect(created.linkStatus).toBe("RUNNING");
        expect(
          world.captured.find(
            (x) => x.action === "CreateInstanceVpcEndpointLinkedVpc",
          )?.enablePrivateZoneRecord,
        ).toBe("true");
        await destroyProtocol(options, stack);
        expect(world.ack.size).toBe(0);
        expect(world.acrLinks).toHaveLength(0);
        expect(world.eniDependencyRejections).toBeGreaterThan(0);
        expect(world.vswitches.size).toBe(0);
      });
    });
  });

  it("creates ACK clusters through the real ROA client and leaves ENIs after delete", async () => {
    await withProtocolHarness(async ({ clients, world }) => {
      const created = await clients.ack.createCluster(
        new ACK.CreateClusterRequest({
          name: "protocol-ack-direct",
          clusterType: "ManagedKubernetes",
          vpcid: "vpc-test",
          vswitchIds: ["vsw-test"],
        }),
      );
      expect(created.body?.clusterId).toMatch(/^c-test/);
      await clients.ack.deleteCluster(
        created.body?.clusterId ?? "",
        new ACK.DeleteClusterRequest({}),
      );
      expect(world.ack.size).toBe(0);
      expect(world.enis.some((item) => item.reason === "ack")).toBe(true);
    });
  });
});
