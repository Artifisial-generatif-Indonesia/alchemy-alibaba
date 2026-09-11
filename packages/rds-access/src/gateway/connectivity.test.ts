import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  cidrContains,
  cidrOverlaps,
  planConnectivity,
  type ConnectivityInput,
} from "./connectivity.ts";
import type { PeerConnectionInfo, RouteEntryInfo } from "./model.ts";

const gateway = {
  vpcId: "vpc-gw",
  vSwitchId: "vsw-gw",
  routeTableId: "vtb-gw",
  privateIp: "10.20.1.151",
  vpcCidr: "10.20.0.0/16",
};
const rds = {
  vpcId: "vpc-rds",
  vSwitchId: "vsw-rds",
  routeTableId: "vtb-rds",
  privateIp: "172.30.192.10",
  vpcCidr: "172.30.192.0/20",
};

const peering = (status = "Activated"): PeerConnectionInfo => ({
  peeringId: "pcc-1",
  name: "gateway-odin",
  status,
  requesterVpcId: "vpc-gw",
  acceptingVpcId: "vpc-rds",
  acceptingRegionId: "ap-southeast-5",
  acceptingOwnerUid: 1,
  requesterCidrs: ["10.20.0.0/16"],
  acceptingCidrs: ["172.30.192.0/20"],
});

const route = (
  destinationCidrBlock: string,
  nextHopId = "pcc-1",
  nextHopType = "VpcPeer",
): RouteEntryInfo => ({
  routeEntryId: `rte-${destinationCidrBlock}`,
  destinationCidrBlock,
  nextHopId,
  nextHopType,
  status: "Available",
});

const input = (overrides: Partial<ConnectivityInput> = {}): ConnectivityInput => ({
  gateway,
  rds,
  peerings: [peering()],
  gatewayRoutes: [route("172.30.192.0/20")],
  rdsRoutes: [route("10.20.0.0/16")],
  createPeering: false,
  peeringName: "gateway-odin",
  ...overrides,
});

const run = (value: ConnectivityInput) => Effect.runPromise(planConnectivity(value));

describe("connectivity planning", () => {
  it("needs nothing when both sides share one VPC", async () => {
    const plan = await run(
      input({
        rds: { ...rds, vpcId: gateway.vpcId },
      }),
    );
    expect(plan).toMatchObject({ changed: false, sameVpc: true, peering: { kind: "none" } });
    expect(plan.routes).toEqual([]);
  });

  it("reuses an activated peering and existing routes", async () => {
    const plan = await run(input());
    expect(plan.peering).toEqual({ kind: "reuse", peeringId: "pcc-1" });
    expect(plan.changed).toBe(false);
    expect(plan.routes.every((item) => !item.changed)).toBe(true);
  });

  it("accepts a host route to the peer as satisfying the VPC route", async () => {
    const plan = await run(
      input({
        gatewayRoutes: [route("172.30.192.10/32")],
        rdsRoutes: [route("10.20.1.151/32")],
      }),
    );
    expect(plan.changed).toBe(false);
    expect(plan.routes.every((item) => item.exists)).toBe(true);
  });

  it("plans both missing routes while reusing the peering", async () => {
    const plan = await run(input({ gatewayRoutes: [], rdsRoutes: [] }));
    expect(plan.peering).toEqual({ kind: "reuse", peeringId: "pcc-1" });
    expect(plan.changed).toBe(true);
    expect(plan.routes).toEqual([
      expect.objectContaining({
        routeTableId: "vtb-gw",
        destinationCidrBlock: "172.30.192.10/32",
        nextHopId: "pcc-1",
        changed: true,
      }),
      expect.objectContaining({
        routeTableId: "vtb-rds",
        destinationCidrBlock: "10.20.1.151/32",
        nextHopId: "pcc-1",
        changed: true,
      }),
    ]);
  });

  it("reuses a narrower subnet route that covers the peer host", async () => {
    const plan = await run(
      input({
        gatewayRoutes: [route("172.30.192.0/20")],
        rdsRoutes: [route("10.20.1.0/24", "pcc-1")],
        rds: { ...rds, privateIp: "172.30.192.10" },
      }),
    );
    expect(plan.changed).toBe(false);
    expect(plan.routes[0]).toMatchObject({
      destinationCidrBlock: "172.30.192.0/20",
      exists: true,
      changed: false,
    });
    expect(plan.routes[1]).toMatchObject({
      destinationCidrBlock: "10.20.1.0/24",
      exists: true,
      changed: false,
    });
  });

  it("refuses a missing peering unless creation is requested", async () => {
    await expect(run(input({ peerings: [] }))).rejects.toThrow("--create-peering");
    const plan = await run(
      input({ peerings: [], gatewayRoutes: [], rdsRoutes: [], createPeering: true }),
    );
    expect(plan.peering).toEqual({ kind: "create", name: "gateway-odin" });
    expect(plan.changed).toBe(true);
  });

  it("plans acceptance for a pending peering", async () => {
    const plan = await run(input({ peerings: [peering("Accepting")] }));
    expect(plan.peering).toEqual({ kind: "accept", peeringId: "pcc-1" });
    expect(plan.changed).toBe(true);
  });

  it("refuses ambiguous peerings between the same VPCs", async () => {
    await expect(run(input({ peerings: [peering(), peering()] }))).rejects.toThrow(
      "2 VPC peerings",
    );
  });

  it("prefers a more specific peering route over a default NAT route", async () => {
    const plan = await run(
      input({
        gatewayRoutes: [route("0.0.0.0/0", "nat-1", "NatGateway"), route("172.30.192.0/20")],
        rdsRoutes: [route("0.0.0.0/0", "nat-2", "NatGateway"), route("10.20.1.0/24")],
      }),
    );
    expect(plan.changed).toBe(false);
    expect(plan.routes[0]).toMatchObject({
      destinationCidrBlock: "172.30.192.0/20",
      exists: true,
      changed: false,
    });
    expect(plan.routes[1]).toMatchObject({
      destinationCidrBlock: "10.20.1.0/24",
      exists: true,
      changed: false,
    });
  });

  it("allows creating the first private route alongside a default NAT route", async () => {
    const plan = await run(
      input({
        peerings: [],
        createPeering: true,
        gatewayRoutes: [route("0.0.0.0/0", "nat-1", "NatGateway")],
        rdsRoutes: [route("0.0.0.0/0", "nat-2", "NatGateway")],
      }),
    );
    expect(plan.peering).toEqual({ kind: "create", name: "gateway-odin" });
    expect(plan.changed).toBe(true);
    expect(plan.routes).toEqual([
      expect.objectContaining({
        destinationCidrBlock: "172.30.192.10/32",
        exists: false,
        changed: true,
      }),
      expect.objectContaining({
        destinationCidrBlock: "10.20.1.151/32",
        exists: false,
        changed: true,
      }),
    ]);
  });

  it("adds the missing private route when only NAT exists and the peering is active", async () => {
    const plan = await run(
      input({
        gatewayRoutes: [route("0.0.0.0/0", "nat-1", "NatGateway")],
        rdsRoutes: [route("0.0.0.0/0", "nat-2", "NatGateway")],
      }),
    );
    expect(plan.changed).toBe(true);
    expect(plan.routes.every((item) => item.changed && !item.exists)).toBe(true);
  });

  it("refuses when the most specific covering route uses another next hop", async () => {
    await expect(
      run(
        input({
          gatewayRoutes: [
            route("0.0.0.0/0", "nat-1", "NatGateway"),
            route("172.30.192.0/24", "cen-1", "CEN"),
          ],
        }),
      ),
    ).rejects.toThrow("most specifically");
  });

  it("refuses equal-prefix routes through different next hops", async () => {
    await expect(
      run(
        input({
          gatewayRoutes: [
            route("172.30.192.0/20"),
            route("172.30.192.0/20", "pcc-other", "VpcPeer"),
          ],
        }),
      ),
    ).rejects.toThrow("both the peering");
  });

  it("refuses rejected peerings and conflicting routes", async () => {
    await expect(run(input({ peerings: [peering("Rejected")] }))).rejects.toThrow(
      "--create-peering",
    );
    await expect(
      run(input({ gatewayRoutes: [route("172.30.192.0/20", "pcc-other", "VpcPeer")] })),
    ).rejects.toThrow("Refusing to shadow");
  });

  it("refuses overlapping or unknown CIDRs", async () => {
    await expect(
      run(input({ rds: { ...rds, vpcCidr: "10.20.0.0/16" } })),
    ).rejects.toThrow("overlapping");
    await expect(
      run(
        input({
          gateway: { ...gateway, vpcCidr: "10.0.0.0/8" },
          rds: { ...rds, vpcCidr: "10.20.0.0/16" },
        }),
      ),
    ).rejects.toThrow("overlapping");
    await expect(run(input({ rds: { ...rds, vpcCidr: undefined } }))).rejects.toThrow(
      "CIDR blocks",
    );
  });

  it("computes containment and overlap correctly", () => {
    expect(cidrContains("172.30.192.0/20", "172.30.192.10")).toBe(true);
    expect(cidrContains("172.30.192.0/20", "172.30.208.10")).toBe(false);
    expect(cidrContains("0.0.0.0/0", "203.0.113.5")).toBe(true);
    expect(cidrOverlaps("10.0.0.0/8", "10.20.0.0/16")).toBe(true);
    expect(cidrOverlaps("10.20.0.0/16", "172.16.0.0/12")).toBe(false);
    expect(cidrOverlaps("10.20.1.0/24", "10.20.1.151/32")).toBe(true);
  });
});
