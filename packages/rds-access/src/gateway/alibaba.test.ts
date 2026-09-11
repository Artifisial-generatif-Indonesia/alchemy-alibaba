import { Effect, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import { gatewayApiLayer, GatewayApi, type GatewaySdk } from "./alibaba.ts";

const regionId = "ap-southeast-5";
const instanceId = "pgm-example";

const describeAttribute = () => ({
  body: {
    items: {
      DBInstanceAttribute: [
        {
          DBInstanceId: instanceId,
          regionId,
          engine: "PostgreSQL",
          engineVersion: "18.0",
          vpcId: "vpc-rds",
          vSwitchId: "vsw-rds",
        },
      ],
    },
  },
});
const describeNetInfo = () => ({
  body: {
    DBInstanceNetInfos: {
      DBInstanceNetInfo: [
        {
          connectionStringType: "Normal",
          IPType: "Public",
          connectionString: `${instanceId}.public.rds.aliyuncs.com`,
          IPAddress: "203.0.113.9",
          port: "5432",
        },
        {
          connectionStringType: "Normal",
          IPType: "Private",
          connectionString: `${instanceId}.pgsql.ap-southeast-5.rds.aliyuncs.com`,
          IPAddress: "172.30.192.10",
          port: "5432",
        },
      ],
    },
  },
});
const describeDatabases = () => ({
  body: { databases: { Database: [{ DBName: "odin" }] } },
});
const describeAccounts = () => ({
  body: { accounts: { DBInstanceAccount: [{ accountName: "gateway_ro", accountType: "Normal" }] } },
});

function harness(overrides: Partial<GatewaySdk> = {}) {
  const sdk: GatewaySdk = {
    describeDBInstanceAttribute: vi.fn(async () => describeAttribute()),
    describeDBInstanceNetInfo: vi.fn(async () => describeNetInfo()),
    describeDatabases: vi.fn(async () => describeDatabases()),
    describeAccounts: vi.fn(async () => describeAccounts()),
    describeDBInstanceIPArrayList: vi.fn(async () => ({
      body: {
        items: {
          DBInstanceIPArray: [
            {
              DBInstanceIPArrayName: "gateway",
              securityIPList: "10.20.1.151",
              securityIPType: "IPv4",
            },
          ],
        },
      },
    })),
    createAccount: vi.fn(async () => ({ body: {} })),
    modifySecurityIps: vi.fn(async () => ({ body: {} })),
    describeInstances: vi.fn(async () => ({
      body: {
        instances: {
          instance: [
            {
              instanceId: "i-gateway",
              status: "Running",
              vpcAttributes: {
                vpcId: "vpc-gw",
                vSwitchId: "vsw-gw",
                privateIpAddress: { ipAddress: ["10.20.1.151"] },
              },
            },
          ],
        },
      },
    })),
    describeVSwitchAttributes: vi.fn(async () => ({
      body: { vSwitchId: "vsw-gw", vpcId: "vpc-gw", routeTable: { routeTableId: "vtb-gw" } },
    })),
    describeVpcs: vi.fn(async () => ({
      body: {
        vpcs: {
          vpc: [
            { vpcId: "vpc-gw", cidrBlock: "10.20.0.0/16", regionId, ownerId: 123 },
          ],
        },
      },
    })),
    describeRouteEntryList: vi.fn(async () => ({
      body: {
        routeEntrys: {
          routeEntry: [
            {
              routeEntryId: "rte-1",
              destinationCidrBlock: "172.30.192.0/20",
              status: "Available",
              nextHops: { nextHop: [{ nextHopId: "pcc-1", nextHopType: "VpcPeer" }] },
            },
          ],
        },
      },
    })),
    createRouteEntry: vi.fn(async () => ({ body: {} })),
    listVpcPeerConnections: vi.fn(async () => ({
      body: {
        vpcPeerConnects: [
          {
            instanceId: "pcc-1",
            name: "gateway-odin",
            status: "Activated",
            acceptingRegionId: regionId,
            acceptingOwnerUid: 123,
            vpc: { vpcId: "vpc-gw", ipv4Cidrs: ["10.20.0.0/16"] },
            acceptingVpc: { vpcId: "vpc-rds", ipv4Cidrs: ["172.30.192.0/20"] },
          },
        ],
      },
    })),
    createVpcPeerConnection: vi.fn(async () => ({ body: { instanceId: "pcc-new" } })),
    acceptVpcPeerConnection: vi.fn(async () => ({ body: {} })),
    ...overrides,
  };
  const layer = gatewayApiLayer({ regionId, sdk });
  const run = <A, E>(effect: Effect.Effect<A, E, GatewayApi>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  return { sdk, run };
}

describe("gateway SDK layer", () => {
  it("decodes instance details and prefers the private endpoint", async () => {
    const h = harness();
    const info = await h.run(
      Effect.gen(function* () {
        const api = yield* GatewayApi;
        return yield* api.instance(instanceId);
      }),
    );
    expect(info).toMatchObject({
      instanceId,
      vpcId: "vpc-rds",
      vSwitchId: "vsw-rds",
      endpoint: {
        host: `${instanceId}.pgsql.ap-southeast-5.rds.aliyuncs.com`,
        port: 5432,
        ipAddress: "172.30.192.10",
      },
      databases: ["odin"],
      accounts: [{ name: "gateway_ro", type: "Normal" }],
    });
  });

  it("refuses an instance without a private endpoint", async () => {
    const h = harness({
      describeDBInstanceNetInfo: async () => ({
        body: {
          DBInstanceNetInfos: {
            DBInstanceNetInfo: [
              {
                connectionStringType: "Normal",
                IPType: "Public",
                connectionString: "public.example",
                IPAddress: "203.0.113.9",
                port: "5432",
              },
            ],
          },
        },
      }),
    });
    await expect(
      h.run(
        Effect.gen(function* () {
          const api = yield* GatewayApi;
          return yield* api.instance(instanceId);
        }),
      ),
    ).rejects.toThrow("private endpoint");
  });

  it("refuses an instance mismatch", async () => {
    const h = harness({
      describeDBInstanceAttribute: async () => ({
        body: {
          items: {
            DBInstanceAttribute: [
              {
                DBInstanceId: "pgm-other",
                regionId,
                engine: "PostgreSQL",
                vpcId: "vpc-rds",
                vSwitchId: "vsw-rds",
              },
            ],
          },
        },
      }),
    });
    await expect(
      h.run(
        Effect.gen(function* () {
          const api = yield* GatewayApi;
          return yield* api.instance(instanceId);
        }),
      ),
    ).rejects.toThrow("identity or region did not match");
  });

  it("discovers the gateway topology by tag and resolves its route table", async () => {
    const h = harness();
    const topology = await h.run(
      Effect.gen(function* () {
        const api = yield* GatewayApi;
        return yield* api.topology();
      }),
    );
    expect(topology).toMatchObject({
      instance: { instanceId: "i-gateway", privateIp: "10.20.1.151" },
      vpc: { vpcId: "vpc-gw", cidrBlock: "10.20.0.0/16", ownerId: 123 },
      vSwitch: { routeTableId: "vtb-gw" },
    });
  });

  it("refuses ambiguous appliances", async () => {
    const h = harness({
      describeInstances: async () => ({
        body: {
          instances: {
            instance: [
              {
                instanceId: "i-1",
                status: "Running",
                vpcAttributes: {
                  vpcId: "vpc-gw",
                  vSwitchId: "vsw-gw",
                  privateIpAddress: { ipAddress: ["10.20.1.151"] },
                },
              },
              {
                instanceId: "i-2",
                status: "Running",
                vpcAttributes: {
                  vpcId: "vpc-gw",
                  vSwitchId: "vsw-gw",
                  privateIpAddress: { ipAddress: ["10.20.1.152"] },
                },
              },
            ],
          },
        },
      }),
    });
    await expect(
      h.run(
        Effect.gen(function* () {
          const api = yield* GatewayApi;
          return yield* api.topology();
        }),
      ),
    ).rejects.toThrow("pass --gateway-instance-id");
  });

  it("maps peerings and route entries", async () => {
    const h = harness();
    const [peerings, routes] = await h.run(
      Effect.gen(function* () {
        const api = yield* GatewayApi;
        return yield* Effect.all([api.peerings(["vpc-gw", "vpc-rds"]), api.routes("vtb-gw")]);
      }),
    );
    expect(peerings[0]).toMatchObject({
      peeringId: "pcc-1",
      requesterVpcId: "vpc-gw",
      acceptingVpcId: "vpc-rds",
      acceptingOwnerUid: 123,
      status: "Activated",
    });
    expect(routes[0]).toMatchObject({
      destinationCidrBlock: "172.30.192.0/20",
      nextHopId: "pcc-1",
      nextHopType: "VpcPeer",
    });
  });

  it("sends an exact-cover allowlist update and a Normal account", async () => {
    const h = harness();
    await h.run(
      Effect.gen(function* () {
        const api = yield* GatewayApi;
        yield* api.setWhitelistGroup({
          instanceId,
          groupName: "gateway",
          ip: "10.20.1.151",
          networkType: "MIX",
        });
        yield* api.createAccount({
          instanceId,
          accountName: "gateway_ro",
          password: Redacted.make("s3cret"),
        });
      }),
    );
    const modify = vi.mocked(h.sdk.modifySecurityIps).mock.calls[0]![0];
    expect(modify).toMatchObject({
      DBInstanceId: instanceId,
      DBInstanceIPArrayName: "gateway",
      securityIps: "10.20.1.151",
      modifyMode: "Cover",
      securityIPType: "IPv4",
      whitelistNetworkType: "MIX",
    });
    const account = vi.mocked(h.sdk.createAccount).mock.calls[0]![0];
    expect(account).toMatchObject({
      DBInstanceId: instanceId,
      accountName: "gateway_ro",
      accountPassword: "s3cret",
      accountType: "Normal",
    });
  });

  it("sanitizes SDK failures", async () => {
    const h = harness({
      describeDBInstanceAttribute: async () => {
        throw { code: "Throttling", message: "accessKeySecret=do-not-log" };
      },
    });
    try {
      await h.run(
        Effect.gen(function* () {
          const api = yield* GatewayApi;
          return yield* api.instance(instanceId);
        }),
      );
      expect.fail("Expected failure");
    } catch (error) {
      expect(String(error)).toContain("Throttling");
      expect(String(error)).not.toContain("do-not-log");
    }
  });
});
