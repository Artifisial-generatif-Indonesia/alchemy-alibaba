import { Effect } from "effect";
import { AccessError } from "../model.ts";
import type {
  ConnectivityPlan,
  PeerConnectionInfo,
  PeeringAction,
  RouteEntryInfo,
  RoutePlan,
} from "./model.ts";

export interface ConnectivitySide {
  readonly vpcId: string;
  readonly vSwitchId: string;
  readonly routeTableId: string;
  readonly privateIp: string;
  readonly vpcCidr: string | undefined;
}

export interface ConnectivityInput {
  readonly gateway: ConnectivitySide;
  readonly rds: ConnectivitySide;
  readonly peerings: ReadonlyArray<PeerConnectionInfo>;
  readonly gatewayRoutes: ReadonlyArray<RouteEntryInfo>;
  readonly rdsRoutes: ReadonlyArray<RouteEntryInfo>;
  /** When false, a missing peering is an error instead of a planned creation. */
  readonly createPeering: boolean;
  readonly peeringName: string;
}

const TERMINAL_FAILURE = new Set(["Rejected", "Expired", "Deleted", "Deleting"]);

const ipv4ToInt = (value: string): number | undefined => {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    result = result * 256 + octet;
  }
  return result >>> 0;
};

const parseCidr = (
  cidr: string,
): { readonly start: number; readonly end: number; readonly prefix: number } | undefined => {
  const [address, prefixText] = cidr.trim().split("/");
  const addressInt = ipv4ToInt(address ?? "");
  if (addressInt === undefined) return undefined;
  const prefix = prefixText === undefined ? 32 : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return undefined;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = (addressInt & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;
  return { start, end, prefix };
};

/** True when `cidr` contains the host address `ip`. */
export const cidrContains = (cidr: string, ip: string): boolean => {
  const range = parseCidr(cidr);
  const value = ipv4ToInt(ip);
  return range !== undefined && value !== undefined && value >= range.start && value <= range.end;
};

/** True when two IPv4 CIDR blocks share any address. */
export const cidrOverlaps = (left: string, right: string): boolean => {
  const a = parseCidr(left);
  const b = parseCidr(right);
  return a !== undefined && b !== undefined && a.start <= b.end && b.start <= a.end;
};

const hostRoute = (ip: string): string => `${ip.trim().replace(/\/32$/, "")}/32`;

const pairMatches = (peering: PeerConnectionInfo, a: string, b: string): boolean =>
  (peering.requesterVpcId === a && peering.acceptingVpcId === b) ||
  (peering.requesterVpcId === b && peering.acceptingVpcId === a);

const routeUsesPeering = (route: RouteEntryInfo, peeringId: string | undefined): boolean =>
  peeringId !== undefined && route.nextHopId === peeringId;

/**
 * Plans one direction of connectivity using longest-prefix routing. Only the
 * most specific covering route matters: a peering route may win over a default
 * NAT or a wider route. A more specific route through another next hop is a
 * conflict; equal-prefix routes via different next hops are ambiguous. When a
 * route must be created, a host /32 is used so it cannot shadow unrelated
 * traffic.
 */
const planRoute = (
  routes: ReadonlyArray<RouteEntryInfo>,
  routeTableId: string,
  peerHost: string,
  peeringId: string | undefined,
  description: string,
): Effect.Effect<RoutePlan, AccessError> => {
  const covering = routes
    .map((route) => ({ route, parsed: parseCidr(route.destinationCidrBlock) }))
    .filter(
      (item): item is { route: RouteEntryInfo; parsed: { start: number; end: number; prefix: number } } =>
        item.parsed !== undefined && cidrContains(item.route.destinationCidrBlock, peerHost),
    );
  if (covering.length === 0) {
    return Effect.succeed({
      routeTableId,
      destinationCidrBlock: hostRoute(peerHost),
      nextHopId: peeringId ?? "pending-peering",
      nextHopType: "VpcPeer",
      description,
      exists: false,
      changed: true,
    });
  }
  const maxPrefix = Math.max(...covering.map((item) => item.parsed.prefix));
  const mostSpecific = covering.filter((item) => item.parsed.prefix === maxPrefix);
  const viaPeering = mostSpecific.filter((item) => routeUsesPeering(item.route, peeringId));
  const foreign = mostSpecific.filter((item) => !routeUsesPeering(item.route, peeringId));
  // A default route (0.0.0.0/0, typically NAT) is not a path to the database;
  // a host /32 is strictly more specific and safe to add. Any more specific
  // foreign private route still blocks creation.
  if (viaPeering.length === 0 && foreign.every((item) => item.parsed.prefix === 0)) {
    return Effect.succeed({
      routeTableId,
      destinationCidrBlock: hostRoute(peerHost),
      nextHopId: peeringId ?? "pending-peering",
      nextHopType: "VpcPeer",
      description,
      exists: false,
      changed: true,
    });
  }
  if (foreign.length > 0) {
    const reason =
      viaPeering.length > 0
        ? `both the peering and ${foreign[0]!.route.nextHopType ?? "another next hop"} (${foreign[0]!.route.nextHopId ?? "unknown"})`
        : `${foreign[0]!.route.nextHopType ?? "another next hop"} (${foreign[0]!.route.nextHopId ?? "unknown"})`;
    return Effect.fail(
      new AccessError({
        message:
          `Route table ${routeTableId} reaches ${peerHost} most specifically through ${reason} ` +
          `via ${foreign[0]!.route.destinationCidrBlock}. Refusing to shadow an existing path; ` +
          "resolve the connectivity manually.",
      }),
    );
  }
  return Effect.succeed({
    routeTableId,
    destinationCidrBlock: viaPeering[0]!.route.destinationCidrBlock,
    nextHopId: peeringId!,
    nextHopType: "VpcPeer",
    description,
    exists: true,
    changed: false,
  });
};

const planPeering = (
  input: ConnectivityInput,
): Effect.Effect<PeeringAction, AccessError> => {
  const matches = input.peerings.filter(
    (peering) =>
      pairMatches(peering, input.gateway.vpcId, input.rds.vpcId) &&
      peering.status !== undefined &&
      !TERMINAL_FAILURE.has(peering.status),
  );
  if (matches.length > 1) {
    return Effect.fail(
      new AccessError({
        message:
          `Found ${matches.length} VPC peerings between ${input.gateway.vpcId} and ${input.rds.vpcId}. ` +
          "Refusing to choose; keep only the intended peering or onboard manually.",
      }),
    );
  }
  const peering = matches[0];
  if (peering !== undefined) {
    if (peering.status === "Activated") {
      return Effect.succeed({ kind: "reuse", peeringId: peering.peeringId });
    }
    if (["Creating", "Accepting", "Updating"].includes(peering.status)) {
      return Effect.succeed({ kind: "accept", peeringId: peering.peeringId });
    }
    return Effect.fail(
      new AccessError({
        message:
          `VPC peering ${peering.peeringId} is ${peering.status}; it cannot be reused or repaired automatically.`,
      }),
    );
  }
  if (!input.createPeering) {
    return Effect.fail(
      new AccessError({
        message:
          `No VPC peering connects ${input.gateway.vpcId} to ${input.rds.vpcId}. ` +
          "Pass --create-peering to plan its creation, or connect the VPCs manually.",
      }),
    );
  }
  return Effect.succeed({ kind: "create", name: input.peeringName });
};

/**
 * Plans cross-VPC connectivity under one supported topology: same-region VPC
 * peering with explicit route entries. Same-VPC deployments need nothing.
 */
export const planConnectivity = (
  input: ConnectivityInput,
): Effect.Effect<ConnectivityPlan, AccessError> => {
  if (input.gateway.vpcId === input.rds.vpcId) {
    return Effect.succeed({
      kind: "connectivity",
      changed: false,
      summary: "The gateway and the database share one VPC; no peering or routes are needed.",
      sameVpc: true,
      gatewayVpcId: input.gateway.vpcId,
      rdsVpcId: input.rds.vpcId,
      gatewayPrivateIp: input.gateway.privateIp,
      rdsPrivateIp: input.rds.privateIp,
      peering: { kind: "none" },
      routes: [],
    });
  }
  if (input.gateway.vpcCidr === undefined || input.rds.vpcCidr === undefined) {
    return Effect.fail(
      new AccessError({
        message:
          "Could not read both VPC CIDR blocks; cross-VPC routing cannot be planned safely.",
      }),
    );
  }
  if (cidrOverlaps(input.gateway.vpcCidr, input.rds.vpcCidr)) {
    return Effect.fail(
      new AccessError({
        message:
          `VPC CIDRs ${input.gateway.vpcCidr} and ${input.rds.vpcCidr} overlap; ` +
          "overlapping networks are not supported.",
      }),
    );
  }
  return Effect.gen(function* () {
    const peering = yield* planPeering(input);
    const peeringId = "peeringId" in peering ? peering.peeringId : undefined;
    const gatewayRoute = yield* planRoute(
      input.gatewayRoutes,
      input.gateway.routeTableId,
      input.rds.privateIp,
      peeringId,
      `route ${input.gateway.vpcId} to the database host`,
    );
    const rdsRoute = yield* planRoute(
      input.rdsRoutes,
      input.rds.routeTableId,
      input.gateway.privateIp,
      peeringId,
      `route ${input.rds.vpcId} to the gateway host`,
    );
    const routes = [gatewayRoute, rdsRoute];
    const changed =
      peering.kind === "create" || peering.kind === "accept" || routes.some((route) => route.changed);
    const summary =
      peering.kind === "create"
        ? `Create peering ${input.peeringName} between ${input.gateway.vpcId} and ${input.rds.vpcId} and add both routes.`
        : peering.kind === "accept"
          ? `Accept peering ${peeringId} and add any missing routes.`
          : routes.some((route) => route.changed)
            ? `Reuse peering ${peeringId} and add ${routes.filter((route) => route.changed).length} missing route(s).`
            : `Reuse peering ${peeringId}; both routes already exist.`;
    return {
      kind: "connectivity",
      changed,
      summary,
      sameVpc: false,
      gatewayVpcId: input.gateway.vpcId,
      rdsVpcId: input.rds.vpcId,
      gatewayPrivateIp: input.gateway.privateIp,
      rdsPrivateIp: input.rds.privateIp,
      peering,
      routes,
    } satisfies ConnectivityPlan;
  });
};
