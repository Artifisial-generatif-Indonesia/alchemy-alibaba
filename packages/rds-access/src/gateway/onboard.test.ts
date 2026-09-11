import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { AccessError, type Group } from "../model.ts";
import { GatewayApi } from "./alibaba.ts";
import type {
  GatewayOnboardingInput,
  GatewayTopology,
  PeerConnectionInfo,
  RdsInstanceInfo,
  RouteEntryInfo,
  RoutePlan,
  VpcInfo,
} from "./model.ts";
import { applyGatewayOnboarding, planGatewayOnboarding } from "./onboard.ts";
import { Postgres, type PostgresQueryResult } from "./sql-runner.ts";

const input: GatewayOnboardingInput = {
  instanceId: "pgm-example",
  regionId: "ap-southeast-5",
  database: "odin",
  displayName: "Odin staging",
  alias: "odin_staging",
  account: "gateway_ro",
  whitelistGroup: "gateway",
  schemas: ["public"],
  ownerRoles: ["odin_app"],
  networkType: "MIX",
};

const group = (name: string, ip: string): Group => ({
  DBInstanceIPArrayName: name,
  securityIPList: ip,
  securityIPType: "IPv4",
  whitelistNetworkType: "MIX",
});

interface HarnessOptions {
  readonly peering?: ReadonlyArray<PeerConnectionInfo>;
  readonly gatewayRoutes?: ReadonlyArray<RouteEntryInfo>;
  readonly rdsRoutes?: ReadonlyArray<RouteEntryInfo>;
  readonly groups?: ReadonlyArray<Group>;
  readonly accounts?: ReadonlyArray<{ readonly name: string; readonly type: string | undefined }>;
  readonly failFirstRoute?: boolean;
  readonly failVerification?: boolean;
}

const activePeering = (): PeerConnectionInfo => ({
  peeringId: "pcc-odin",
  name: "gateway-odin",
  status: "Activated",
  requesterVpcId: "vpc-gw",
  acceptingVpcId: "vpc-rds",
  acceptingRegionId: "ap-southeast-5",
  acceptingOwnerUid: 1,
  requesterCidrs: ["10.20.0.0/16"],
  acceptingCidrs: ["172.30.192.0/20"],
});

const route = (destinationCidrBlock: string): RouteEntryInfo => ({
  routeEntryId: `rte-${destinationCidrBlock}`,
  destinationCidrBlock,
  nextHopId: "pcc-odin",
  nextHopType: "VpcPeer",
  status: "Available",
});

function harness(options: HarnessOptions = {}) {
  const gatewayPrivateIp = "10.20.1.151";
  const rdsPrivateIp = "172.30.192.10";
  const gatewayVpcId = "vpc-gw";
  const rdsVpcId = "vpc-rds";
  const state = {
    groups: [
      ...(options.groups ?? [group("default", "127.0.0.1"), group("gateway", gatewayPrivateIp)]),
    ],
    accounts: [
      ...(options.accounts ?? [{ name: "gateway_ro", type: "Normal" as string | undefined }]),
    ],
    peerings: [...(options.peering ?? [])],
    routes: {
      "vtb-gw": [...(options.gatewayRoutes ?? [])],
      "vtb-rds": [...(options.rdsRoutes ?? [])],
    } as Record<string, RouteEntryInfo[]>,
    grantsApplied: false,
    adminStatements: [] as string[],
    queries: [] as string[],
    calls: [] as string[],
    failNextRoute: options.failFirstRoute === true,
    verificationFailures: options.failVerification === true ? 1 : 0,
  };
  const instanceInfo = (): RdsInstanceInfo => ({
    instanceId: input.instanceId,
    regionId: input.regionId,
    engine: "PostgreSQL",
    engineVersion: "18.0",
    vpcId: rdsVpcId,
    vSwitchId: "vsw-rds",
    endpoint: {
      host: "pgm-example.pgsql.ap-southeast-5.rds.aliyuncs.com",
      port: 5432,
      ipAddress: rdsPrivateIp,
    },
    databases: ["odin"],
    accounts: state.accounts,
  });
  const vpcs: Record<string, VpcInfo> = {
    [gatewayVpcId]: {
      vpcId: gatewayVpcId,
      cidrBlock: "10.20.0.0/16",
      regionId: input.regionId,
      ownerId: 1,
    },
    [rdsVpcId]: {
      vpcId: rdsVpcId,
      cidrBlock: "172.30.192.0/20",
      regionId: input.regionId,
      ownerId: 1,
    },
  };
  const topology: GatewayTopology = {
    instance: {
      instanceId: "i-gateway",
      privateIp: gatewayPrivateIp,
      vpcId: gatewayVpcId,
      vSwitchId: "vsw-gw",
      status: "Running",
    },
    vpc: vpcs[gatewayVpcId]!,
    vSwitch: { vSwitchId: "vsw-gw", vpcId: gatewayVpcId, routeTableId: "vtb-gw" },
  };
  const service: GatewayApi["Service"] = {
    instance: () => Effect.succeed(instanceInfo()),
    groups: () =>
      Effect.succeed({
        all: state.groups,
        network: state.groups.filter((item) => item.whitelistNetworkType === "MIX"),
      }),
    topology: () => Effect.succeed(topology),
    vpc: (vpcId) => Effect.succeed(vpcs[vpcId]!),
    vSwitch: (vSwitchId) =>
      Effect.succeed(
        vSwitchId === "vsw-gw"
          ? { vSwitchId, vpcId: gatewayVpcId, routeTableId: "vtb-gw" }
          : { vSwitchId, vpcId: rdsVpcId, routeTableId: "vtb-rds" },
      ),
    peerings: () => Effect.succeed(state.peerings),
    routes: (routeTableId) => Effect.succeed(state.routes[routeTableId] ?? []),
    createPeering: (request) => {
      state.calls.push("create-peering");
      state.peerings.push({ ...activePeering(), name: request.name, peeringId: "pcc-new" });
      return Effect.succeed("pcc-new");
    },
    acceptPeering: (peeringId) => {
      state.calls.push("accept-peering");
      state.peerings = state.peerings.map((item) =>
        item.peeringId === peeringId ? { ...item, status: "Activated" } : item,
      );
      return Effect.void;
    },
    createRoute: (plan: RoutePlan) => {
      state.calls.push("create-route");
      if (state.failNextRoute) {
        state.failNextRoute = false;
        return Effect.fail(
          new AccessError({ message: "simulated partial route failure" }),
        );
      }
      state.routes[plan.routeTableId] = [
        ...(state.routes[plan.routeTableId] ?? []),
        {
          routeEntryId: "rte-new",
          destinationCidrBlock: plan.destinationCidrBlock,
          nextHopId: plan.nextHopId,
          nextHopType: plan.nextHopType,
          status: "Available",
        },
      ];
      return Effect.void;
    },
    setWhitelistGroup: (request) => {
      state.calls.push("set-whitelist");
      const existing = state.groups.some(
        (item) => item.DBInstanceIPArrayName === request.groupName,
      );
      state.groups = existing
        ? state.groups.map((item) =>
            item.DBInstanceIPArrayName === request.groupName
              ? { ...item, securityIPList: request.ip }
              : item,
          )
        : [...state.groups, group(request.groupName, request.ip)];
      return Effect.void;
    },
    createAccount: (request) => {
      state.calls.push("create-account");
      state.accounts.push({ name: request.accountName, type: "Normal" });
      return Effect.void;
    },
  };
  const apiLayer = Layer.succeed(GatewayApi, service);
  const postgresService: Postgres["Service"] = {
    query: (_url, sql) => {
      state.queries.push(sql);
      if (state.verificationFailures > 0) {
        state.verificationFailures -= 1;
        return Effect.fail(
          new AccessError({
            message: "PostgreSQL request failed: connect ECONNREFUSED 172.30.192.10:5432",
          }),
        );
      }
      if (sql.includes("current_database")) {
        return Effect.succeed({
          rows: [
            {
              database: "odin",
              username: "gateway_ro",
              read_only: "on",
              schema_usage: state.grantsApplied,
              schema_create: false,
              can_read_all: state.grantsApplied,
              can_write_any: false,
            },
          ],
          rowCount: 1,
        } satisfies PostgresQueryResult);
      }
      if (sql.includes("pg_default_acl")) {
        return Effect.succeed({
          rows: [
            {
              owner_role: "odin_app",
              schema_name: "public",
              granted: state.grantsApplied,
            },
          ],
          rowCount: 1,
        });
      }
      return Effect.fail(new AccessError({ message: "unexpected query" }));
    },
    run: (_url, statements) => {
      state.grantsApplied = true;
      state.adminStatements.push(...statements);
      return Effect.succeed(
        statements.map(() => ({ rows: [], rowCount: 0 }) satisfies PostgresQueryResult),
      );
    },
  };
  const pgLayer = Layer.succeed(Postgres, postgresService);
  const runPlan = (
    value: GatewayOnboardingInput = input,
    overrides: { accountPassword?: Redacted.Redacted<string>; createPeering?: boolean } = {},
  ) =>
    Effect.runPromise(
      planGatewayOnboarding(value, {
        createPeering: overrides.createPeering ?? false,
        ...(overrides.accountPassword === undefined
          ? {}
          : { accountPassword: overrides.accountPassword }),
      }).pipe(Effect.provide(apiLayer), Effect.provide(pgLayer)),
    );
  const runApply = (
    value: GatewayOnboardingInput = input,
    overrides: { admin?: boolean; createPeering?: boolean; accountPassword?: boolean } = {},
  ) =>
    Effect.runPromise(
      applyGatewayOnboarding(value, {
        createPeering: overrides.createPeering ?? false,
        accountPassword:
          overrides.accountPassword === false ? undefined : Redacted.make("secret-password"),
        ...(overrides.admin === true
          ? { admin: { account: "odin_master", password: Redacted.make("admin-password") } }
          : {}),
      }).pipe(Effect.provide(apiLayer), Effect.provide(pgLayer)),
    );
  return { state, runPlan, runApply, apiLayer, pgLayer };
}

describe("gateway onboarding plan", () => {
  it("skips permission verification without an account password", async () => {
    const h = harness({
      peering: [activePeering()],
      gatewayRoutes: [route("172.30.192.0/20")],
      rdsRoutes: [route("10.20.0.0/16")],
    });
    const plan = await h.runPlan();
    expect(plan.changed).toBe(true);
    expect(plan.steps.find((step) => step.kind === "grants")).toMatchObject({
      verification: "skipped",
      changed: true,
    });
    expect(plan.warnings.some((warning) => warning.includes("account password"))).toBe(true);
    expect(plan.warnings.some((warning) => warning.includes("owner roles"))).toBe(false);
  });

  it("reports a fully converged database", async () => {
    const h = harness({
      peering: [activePeering()],
      gatewayRoutes: [route("172.30.192.0/20")],
      rdsRoutes: [route("10.20.0.0/16")],
    });
    h.state.grantsApplied = true;
    const plan = await h.runPlan(input, { accountPassword: Redacted.make("secret-password") });
    expect(plan.changed).toBe(false);
    expect(plan.steps.every((step) => !step.changed)).toBe(true);
  });

  it("plans read-only grants and warns about missing owner roles", async () => {
    const h = harness({
      peering: [activePeering()],
      gatewayRoutes: [route("172.30.192.0/20")],
      rdsRoutes: [route("10.20.0.0/16")],
    });
    const plan = await h.runPlan(
      { ...input, ownerRoles: [] },
      { accountPassword: Redacted.make("secret-password") },
    );
    const grants = plan.steps.find((step) => step.kind === "grants");
    expect(grants).toMatchObject({ verification: "pending", changed: true });
    expect(plan.warnings.some((warning) => warning.includes("owner roles"))).toBe(true);
    expect(h.state.adminStatements).toEqual([]);
  });

  it("does not query PostgreSQL while the account is missing", async () => {
    const h = harness({
      peering: [activePeering()],
      gatewayRoutes: [route("172.30.192.0/20")],
      rdsRoutes: [route("10.20.0.0/16")],
      accounts: [],
    });
    const plan = await h.runPlan(input, { accountPassword: Redacted.make("secret-password") });
    expect(plan.steps.find((step) => step.kind === "account")).toMatchObject({ changed: true });
    expect(plan.steps.find((step) => step.kind === "grants")).toMatchObject({
      verification: "pending",
    });
    expect(h.state.queries).toEqual([]);
  });

  it("continues planning when permission verification cannot connect yet", async () => {
    const h = harness({
      peering: [activePeering()],
      gatewayRoutes: [route("172.30.192.0/20")],
      rdsRoutes: [route("10.20.0.0/16")],
      failVerification: true,
    });
    const plan = await h.runPlan(input, { accountPassword: Redacted.make("secret-password") });
    const grants = plan.steps.find((step) => step.kind === "grants");
    expect(grants).toMatchObject({ verification: "pending", changed: true });
    expect(grants && "issues" in grants ? grants.issues.join(" ") : "").toContain(
      "permission verification was unavailable",
    );
  });

  it("refuses a missing peering unless creation is requested", async () => {
    const h = harness();
    await expect(h.runPlan()).rejects.toThrow("--create-peering");
  });

  it("refuses a database that does not exist", async () => {
    const h = harness();
    await expect(h.runPlan({ ...input, database: "missing" })).rejects.toThrow("does not exist");
  });
});

describe("gateway onboarding apply", () => {
  it("applies connectivity, whitelist, account and grants", async () => {
    const h = harness({
      peering: [],
      gatewayRoutes: [],
      rdsRoutes: [],
      groups: [group("default", "127.0.0.1")],
      accounts: [],
    });
    const result = await h.runApply(input, {
      admin: true,
      createPeering: true,
    });
    expect(result.applied).toBe(true);
    expect(h.state.calls).toEqual([
      "create-peering",
      "create-route",
      "create-route",
      "set-whitelist",
      "create-account",
    ]);
    expect(h.state.grantsApplied).toBe(true);
    expect(h.state.adminStatements.join("\n")).toContain("ALTER DEFAULT PRIVILEGES");
    expect(h.state.adminStatements.join("\n")).toContain("default_transaction_read_only");
    expect(h.state.adminStatements.join("\n")).not.toMatch(/secret-password|admin-password/);
  });

  it("is idempotent on a second run", async () => {
    const h = harness({
      peering: [activePeering()],
      gatewayRoutes: [route("172.30.192.0/20")],
      rdsRoutes: [route("10.20.0.0/16")],
    });
    h.state.grantsApplied = true;
    const result = await h.runApply();
    expect(result.applied).toBe(false);
    expect(h.state.calls).toEqual([]);
    expect(h.state.adminStatements).toEqual([]);
  });

  it("recovers from a partial route failure on rerun", async () => {
    const h = harness({
      peering: [activePeering()],
      gatewayRoutes: [],
      rdsRoutes: [],
      failFirstRoute: true,
    });
    await expect(h.runApply(input, { admin: true })).rejects.toThrow("simulated partial");
    const result = await h.runApply(input, { admin: true });
    expect(result.applied).toBe(true);
    expect(h.state.routes["vtb-gw"]).toHaveLength(1);
    expect(h.state.routes["vtb-rds"]).toHaveLength(1);
  });

  it("recovers when verification fails before connectivity is repaired", async () => {
    const h = harness({
      peering: [activePeering()],
      gatewayRoutes: [route("172.30.192.0/20")],
      rdsRoutes: [route("10.20.0.0/16")],
      failVerification: true,
    });
    const result = await h.runApply(input, { admin: true });
    expect(result.applied).toBe(true);
    expect(h.state.grantsApplied).toBe(true);
  });

  it("requires a privileged account when grants are missing", async () => {
    const h = harness({
      peering: [activePeering()],
      gatewayRoutes: [route("172.30.192.0/20")],
      rdsRoutes: [route("10.20.0.0/16")],
    });
    await expect(h.runApply()).rejects.toThrow("--admin-account");
  });

  it("requires an account password for apply", async () => {
    const h = harness({
      peering: [activePeering()],
      gatewayRoutes: [route("172.30.192.0/20")],
      rdsRoutes: [route("10.20.0.0/16")],
    });
    await expect(h.runApply(input, { accountPassword: false })).rejects.toThrow(
      "--account-password-file",
    );
  });
});
