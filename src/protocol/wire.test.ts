import * as Tair from "@alicloud/r-kvstore20150101";
import * as RDS from "@alicloud/rds20140815";
import * as VPC from "@alicloud/vpc20160428";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { installLoopbackGuard, LoopbackEscapeError } from "./loopback-guard.ts";
import { assertNoSecrets } from "./redaction.ts";
import { withProtocolHarness } from "./harness.ts";

describe("Alibaba protocol wire capture", { timeout: 15_000 }, () => {
  it("serializes VPC ClientToken, region, tags, and pagination against loopback", async () => {
    await withProtocolHarness(async ({ clients, world, server, guard }) => {
      expect(server.host.startsWith("127.0.0.1:")).toBe(true);
      await clients.vpc.createVpc(
        new VPC.CreateVpcRequest({
          regionId: "ap-southeast-5",
          vpcName: "protocol-vpc-a",
          cidrBlock: "10.40.0.0/16",
          clientToken: "vpc-token-1",
          tag: [{ key: "environment", value: "protocol" }],
        }),
      );
      await clients.vpc.createVpc(
        new VPC.CreateVpcRequest({
          regionId: "ap-southeast-5",
          vpcName: "protocol-vpc-b",
          cidrBlock: "10.41.0.0/16",
          clientToken: "vpc-token-2",
        }),
      );
      await clients.vpc.describeVpcs(
        new VPC.DescribeVpcsRequest({
          regionId: "ap-southeast-5",
          pageNumber: 2,
          pageSize: 1,
        }),
      );
      const create = world.captured.find((item) => item.action === "CreateVpc");
      const describe = world.captured.find(
        (item) => item.action === "DescribeVpcs" && item.pageNumber === "2",
      );
      expect(create).toMatchObject({
        method: "POST",
        pathname: "/",
        regionId: "ap-southeast-5",
        clientToken: "vpc-token-1",
        hasPassword: false,
      });
      expect(create?.tagKeys).toContain("environment");
      expect(create?.token).toBeUndefined();
      expect(describe).toMatchObject({
        pageNumber: "2",
        pageSize: "1",
        regionId: "ap-southeast-5",
      });
      expect(guard.escaped()).toBe(0);
      assertNoSecrets(world.captured, "vpc-wire");
    });
  });

  it("serializes Tair Token, identity, password presence, and SSL without snapshotting secrets", async () => {
    await withProtocolHarness(async ({ clients, world }) => {
      const created = await clients.tair.createInstance(
        new Tair.CreateInstanceRequest({
          regionId: "ap-southeast-5",
          instanceName: "protocol-tair",
          instanceClass: "redis.shard.small.2.ce",
          instanceType: "Redis",
          engineVersion: "7.0",
          networkType: "VPC",
          vpcId: "vpc-test",
          vSwitchId: "vsw-test",
          password: "ProtocolPass1!",
          token: "tair-create-token",
          tag: [{ key: "owner", value: "protocol" }],
        }),
      );
      await clients.tair.modifyInstanceSSL(
        new Tair.ModifyInstanceSSLRequest({
          instanceId: created.body?.instanceId,
          SSLEnabled: "Enable",
        }),
      );
      const create = world.captured.find(
        (item) => item.action === "CreateInstance",
      );
      const ssl = world.captured.find(
        (item) => item.action === "ModifyInstanceSSL",
      );
      expect(create).toMatchObject({
        regionId: "ap-southeast-5",
        vpcId: "vpc-test",
        vSwitchId: "vsw-test",
        instanceName: "protocol-tair",
        token: "tair-create-token",
        hasPassword: true,
      });
      expect(create?.clientToken).toBeUndefined();
      expect(create?.tagKeys).toContain("owner");
      expect(ssl).toMatchObject({
        action: "ModifyInstanceSSL",
        sslEnabled: "Enable",
        instanceId: created.body?.instanceId,
      });
      assertNoSecrets(world.captured, "tair-wire");
      assertNoSecrets(JSON.stringify(world.captured), "tair-wire-json");
    });
  });

  it("serializes RDS ClientToken separately from Tair Token", async () => {
    await withProtocolHarness(async ({ clients, world }) => {
      await clients.rds.createDBInstance(
        new RDS.CreateDBInstanceRequest({
          regionId: "ap-southeast-5",
          engine: "PostgreSQL",
          engineVersion: "16.0",
          DBInstanceClass: "pg.n2.small.1",
          DBInstanceStorage: 20,
          DBInstanceNetType: "Intranet",
          DBInstanceDescription: "protocol-rds",
          payType: "Postpaid",
          VPCId: "vpc-test",
          vSwitchId: "vsw-test",
          securityIPList: "127.0.0.1",
          clientToken: "rds-create-token",
        }),
      );
      const create = world.captured.find(
        (item) => item.action === "CreateDBInstance",
      );
      expect(create).toMatchObject({
        clientToken: "rds-create-token",
        dbInstanceDescription: "protocol-rds",
        vpcId: "vpc-test",
        vSwitchId: "vsw-test",
      });
      expect(create?.token).toBeUndefined();
    });
  });

  it("decodes paginated regional RDS inventory without treating missing tokens as identical", async () => {
    await withProtocolHarness(async ({ clients, world }) => {
      for (const regionId of [
        "ap-southeast-5",
        "ap-southeast-5",
        "cn-hangzhou",
      ]) {
        await clients.rds.createDBInstance(
          new RDS.CreateDBInstanceRequest({
            regionId,
            DBInstanceDescription: "same-description",
            engine: "PostgreSQL",
            engineVersion: "16.0",
            DBInstanceClass: "test-class",
            DBInstanceStorage: 20,
            DBInstanceNetType: "Intranet",
            payType: "Postpaid",
            securityIPList: "127.0.0.1",
          }),
        );
      }
      expect(world.rds.size).toBe(3);
      const second = await clients.rds.describeDBInstances(
        new RDS.DescribeDBInstancesRequest({
          regionId: "ap-southeast-5",
          searchKey: "same-description",
          pageNumber: 2,
          pageSize: 1,
        }),
      );
      expect(second.body?.totalRecordCount).toBe(2);
      expect(
        second.body?.items?.DBInstance?.map((x) => x.DBInstanceId),
      ).toEqual([[...world.rds.keys()][1]]);
      const end = await clients.rds.describeDBInstances(
        new RDS.DescribeDBInstancesRequest({
          regionId: "ap-southeast-5",
          pageNumber: 3,
          pageSize: 1,
        }),
      );
      expect(end.body?.items?.DBInstance).toEqual([]);
    });
  });

  it("decodes Alibaba error envelopes including request IDs", async () => {
    await withProtocolHarness(async ({ clients, world }) => {
      world.script({ action: "DescribeVpcs", code: "Throttling", times: 1 });
      await expect(
        clients.vpc.describeVpcs(
          new VPC.DescribeVpcsRequest({ regionId: "ap-southeast-5" }),
        ),
      ).rejects.toMatchObject({
        code: "Throttling",
        statusCode: 400,
      });
      const failed = world.captured.find(
        (item) => item.action === "DescribeVpcs",
      );
      expect(failed?.regionId).toBe("ap-southeast-5");
    });
  });

  it("fails the suite if a request escapes loopback", () => {
    const guard = installLoopbackGuard();
    try {
      expect(() => http.get("http://example.com")).toThrow(LoopbackEscapeError);
      expect(guard.escaped()).toBe(1);
    } finally {
      guard.uninstall();
    }
  });
});
