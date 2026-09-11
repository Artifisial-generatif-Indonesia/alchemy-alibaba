import { randomBytes } from "node:crypto";
import { Effect, Redacted, Schema } from "effect";
import { AccessError } from "../model.ts";
import { GatewayApi } from "./alibaba.ts";
import { planConnectivity, type ConnectivityInput } from "./connectivity.ts";
import { buildGrantStatements, buildVerificationQueries, interpretVerification } from "./grants.ts";
import { planAccount, planWhitelist } from "./planners.ts";
import type {
  AccountPlan,
  ConnectivityPlan,
  GatewayOnboardingPlan,
  GatewayOnboardingResult,
  GrantsPlan,
  RdsInstanceInfo,
  GatewayTopology,
  OnboardingStep,
  WhitelistPlan,
} from "./model.ts";
import { GatewayOnboardingInput } from "./model.ts";
import { Postgres } from "./sql-runner.ts";

export interface OnboardingOptions {
  /** Plan peering creation when no peering connects the two VPCs. */
  readonly createPeering: boolean;
  /** Explicit appliance instance; otherwise discovered by application tag. */
  readonly gatewayInstanceId?: string;
  /** Password for the gateway database account, when already known. */
  readonly accountPassword?: Redacted.Redacted<string>;
  /** Privileged database account used only to apply missing grants. */
  readonly admin?: {
    readonly account: string;
    readonly password: Redacted.Redacted<string>;
  };
}

interface Discovery {
  readonly instance: RdsInstanceInfo;
  readonly topology: GatewayTopology;
  readonly connectivity: ConnectivityPlan;
  readonly whitelist: WhitelistPlan;
  readonly account: AccountPlan;
  readonly grants: GrantsPlan;
}

const validateInput = (input: GatewayOnboardingInput) =>
  Schema.decodeUnknownEffect(GatewayOnboardingInput)(input).pipe(
    Effect.mapError(
      () =>
        new AccessError({
          message:
            "Invalid onboarding input. Check the instance, database, name, alias, account and schema identifiers.",
        }),
    ),
  );

const postgresUrl = (
  account: string,
  password: Redacted.Redacted<string>,
  host: string,
  port: number,
  database: string,
): Redacted.Redacted<string> =>
  Redacted.make(
    `postgres://${encodeURIComponent(account)}:${encodeURIComponent(
      Redacted.value(password),
    )}@${host}:${port}/${encodeURIComponent(database)}`,
  );

const grantOptionsOf = (input: GatewayOnboardingInput) => ({
  database: input.database,
  account: input.account,
  schemas: input.schemas,
  ownerRoles: input.ownerRoles,
});

const verifyGrants = Effect.fn("verifyGrants")(function* (
  input: GatewayOnboardingInput,
  instance: RdsInstanceInfo,
  password: Redacted.Redacted<string>,
): Effect.fn.Return<GrantsPlan, AccessError, Postgres> {
  const postgres = yield* Postgres;
  const options = grantOptionsOf(input);
  const url = postgresUrl(
    input.account,
    password,
    instance.endpoint.host,
    instance.endpoint.port,
    input.database,
  );
  const queries = buildVerificationQueries(options);
  const identity = yield* postgres.query(url, queries.identity);
  const defaultRows =
    queries.defaultPrivileges === undefined
      ? []
      : (yield* postgres.query(url, queries.defaultPrivileges)).rows;
  const verification = interpretVerification(options, identity.rows, defaultRows);
  const statements = buildGrantStatements(options);
  return {
    kind: "grants",
    changed: !verification.verified,
    verification: verification.verified ? "verified" : "pending",
    issues: verification.issues,
    statements: verification.verified ? [] : statements,
  };
});

const discover = Effect.fn("discover")(function* (
  input: GatewayOnboardingInput,
  options: OnboardingOptions,
): Effect.fn.Return<Discovery, AccessError, GatewayApi | Postgres> {
  const api = yield* GatewayApi;
  const rds = yield* api.instance(input.instanceId);
  if (!rds.databases.includes(input.database)) {
    return yield* new AccessError({
      message:
        `Database ${input.database} does not exist on ${input.instanceId}. ` +
        "Create it outside this tool; onboarding never creates or drops databases.",
    });
  }
  const gateway = yield* api.topology(input.gatewayInstanceId ?? options.gatewayInstanceId);
  const rdsVpc = yield* api.vpc(rds.vpcId);
  if (
    gateway.vpc.ownerId !== undefined &&
    rdsVpc.ownerId !== undefined &&
    gateway.vpc.ownerId !== rdsVpc.ownerId
  ) {
    return yield* new AccessError({
      message:
        "The gateway and database VPCs belong to different Alibaba Cloud accounts; " +
        "cross-account peering is not supported by this tool.",
    });
  }
  if (rdsVpc.regionId !== gateway.vpc.regionId) {
    return yield* new AccessError({
      message:
        `The gateway VPC is in ${gateway.vpc.regionId} and the database VPC is in ${rdsVpc.regionId}; ` +
        "cross-region onboarding is not supported.",
    });
  }
  const rdsSwitch = yield* api.vSwitch(rds.vSwitchId);
  const peerings = yield* api.peerings([gateway.vpc.vpcId, rds.vpcId]);
  const [gatewayRoutes, rdsRoutes] = yield* Effect.all([
    api.routes(gateway.vSwitch.routeTableId),
    api.routes(rdsSwitch.routeTableId),
  ]);
  const connectivity = yield* planConnectivity({
    gateway: {
      vpcId: gateway.vpc.vpcId,
      vSwitchId: gateway.vSwitch.vSwitchId,
      routeTableId: gateway.vSwitch.routeTableId,
      privateIp: gateway.instance.privateIp,
      vpcCidr: gateway.vpc.cidrBlock,
    },
    rds: {
      vpcId: rds.vpcId,
      vSwitchId: rds.vSwitchId,
      routeTableId: rdsSwitch.routeTableId,
      privateIp: rds.endpoint.ipAddress,
      vpcCidr: rdsVpc.cidrBlock,
    },
    peerings,
    gatewayRoutes,
    rdsRoutes,
    createPeering: options.createPeering,
    peeringName: `gateway-${input.database}-${input.instanceId}`.slice(0, 128),
  } satisfies ConnectivityInput);

  const groupsResult = yield* api.groups(input.instanceId, input.networkType);
  const whitelist = yield* planWhitelist({
    groups: groupsResult.all,
    networkGroups: groupsResult.network,
    groupName: input.whitelistGroup,
    networkType: input.networkType,
    gatewayIp: gateway.instance.privateIp,
  });
  const account = yield* planAccount({
    accounts: rds.accounts,
    accountName: input.account,
  });

  const statements = buildGrantStatements(grantOptionsOf(input));
  const grants: GrantsPlan =
    options.accountPassword === undefined
      ? {
          kind: "grants",
          changed: true,
          verification: "skipped",
          issues: ["account password was not provided; permissions were not verified"],
          statements,
        }
      : account.exists
        ? yield* verifyGrants(input, rds, options.accountPassword).pipe(
            // Connectivity or credentials may not be ready yet on a first run;
            // record the problem and let the plan repair it instead of failing.
            Effect.catchTag("AccessError", (error) =>
              Effect.succeed({
                kind: "grants",
                changed: true,
                verification: "pending",
                issues: [`permission verification was unavailable: ${error.message}`],
                statements,
              } satisfies GrantsPlan),
            ),
          )
        : {
            kind: "grants",
            changed: true,
            verification: "pending",
            issues: [`account ${input.account} does not exist yet`],
            statements,
          };

  return { instance: rds, topology: gateway, connectivity, whitelist, account, grants };
});

const buildPlan = (
  input: GatewayOnboardingInput,
  discovery: Discovery,
): GatewayOnboardingPlan => {
  const steps: OnboardingStep[] = [
    discovery.connectivity,
    discovery.whitelist,
    discovery.account,
    discovery.grants,
  ];
  const warnings: string[] = [];
  if (input.ownerRoles.length === 0) {
    warnings.push(
      "No owner roles were provided; SELECT will be granted on existing tables only. " +
        "Pass --owner-role for each role that creates future tables.",
    );
  }
  if (discovery.grants.verification === "skipped") {
    warnings.push(
      "The account password was not available; permission verification and grants were not planned against PostgreSQL.",
    );
  }
  return {
    instanceId: input.instanceId,
    regionId: input.regionId,
    displayName: input.displayName,
    alias: input.alias,
    changed: steps.some((step) => step.changed),
    endpoint: {
      host: discovery.instance.endpoint.host,
      port: discovery.instance.endpoint.port,
      database: input.database,
      account: input.account,
      dialect: "postgresql",
    },
    steps,
    warnings,
  };
};

export const planGatewayOnboarding = Effect.fn("planGatewayOnboarding")(function* (
  rawInput: GatewayOnboardingInput,
  options: OnboardingOptions,
): Effect.fn.Return<GatewayOnboardingPlan, AccessError, GatewayApi | Postgres> {
  const input = yield* validateInput(rawInput);
  const discovery = yield* discover(input, options);
  return buildPlan(input, discovery);
});

const attempts = { routes: 30, peering: 60, account: 30, whitelist: 30 } as const;
const interval = "2 seconds";

const waitFor = <A, R>(
  label: string,
  effect: Effect.Effect<A, AccessError, R>,
  predicate: (value: A) => boolean,
  maxAttempts: number,
): Effect.Effect<A, AccessError, R> =>
  Effect.gen(function* () {
    let latest = yield* effect;
    for (let attempt = 1; attempt < maxAttempts && !predicate(latest); attempt++) {
      yield* Effect.sleep(interval);
      latest = yield* effect;
    }
    if (!predicate(latest)) {
      return yield* new AccessError({
        message: `${label} did not converge in time. Rerun to inspect the current state; every step is safe to repeat.`,
      });
    }
    return latest;
  });

const pairMatches = (requester: string, accepting: string, a: string, b: string): boolean =>
  (requester === a && accepting === b) || (requester === b && accepting === a);

const applyConnectivity = Effect.fn("applyConnectivity")(function* (
  plan: ConnectivityPlan,
  options: OnboardingOptions,
): Effect.fn.Return<boolean, AccessError, GatewayApi> {
  const api = yield* GatewayApi;
  let changed = false;
  const action = plan.peering;
  if (plan.sameVpc || action.kind === "none") {
    return changed;
  }
  if (action.kind === "create") {
    const rdsVpc = yield* api.vpc(plan.rdsVpcId);
    const created = yield* api.createPeering({
      name: action.name,
      gatewayVpcId: plan.gatewayVpcId,
      rdsVpcId: plan.rdsVpcId,
      acceptingAliUid: rdsVpc.ownerId,
    });
    changed = true;
    yield* waitFor(
      `VPC peering ${created}`,
      api.peerings([plan.gatewayVpcId, plan.rdsVpcId]),
      (peerings) =>
        peerings.some(
          (peering) =>
            peering.peeringId === created &&
            peering.status === "Activated" &&
            pairMatches(peering.requesterVpcId, peering.acceptingVpcId, plan.gatewayVpcId, plan.rdsVpcId),
        ),
      attempts.peering,
    );
  } else if (action.kind === "accept") {
    yield* api.acceptPeering(action.peeringId);
    changed = true;
    yield* waitFor(
      `VPC peering ${action.peeringId}`,
      api.peerings([plan.gatewayVpcId, plan.rdsVpcId]),
      (peerings) =>
        peerings.some(
          (peering) => peering.peeringId === action.peeringId && peering.status === "Activated",
        ),
      attempts.peering,
    );
  }
  const peerings = yield* api.peerings([plan.gatewayVpcId, plan.rdsVpcId]);
  const activated = peerings.find(
    (peering) =>
      peering.status === "Activated" &&
      pairMatches(peering.requesterVpcId, peering.acceptingVpcId, plan.gatewayVpcId, plan.rdsVpcId),
  );
  const peeringId =
    action.kind === "reuse" || action.kind === "accept" ? action.peeringId : activated?.peeringId;
  if (peeringId === undefined) {
    return yield* new AccessError({
      message: "The VPC peering is not activated; routes were not created.",
    });
  }
  for (const route of plan.routes) {
    if (!route.changed) continue;
    yield* api.createRoute({ ...route, nextHopId: peeringId });
    changed = true;
  }
  for (const route of plan.routes) {
    if (!route.changed) continue;
    yield* waitFor(
      `Route ${route.destinationCidrBlock} in ${route.routeTableId}`,
      api.routes(route.routeTableId),
      (routes) =>
        routes.some(
          (entry) =>
            entry.destinationCidrBlock === route.destinationCidrBlock &&
            entry.nextHopId === peeringId,
        ),
      attempts.routes,
    );
  }
  return changed;
});

const applyWhitelist = Effect.fn("applyWhitelist")(function* (
  input: GatewayOnboardingInput,
  expectedIp: string,
  plan: WhitelistPlan,
): Effect.fn.Return<boolean, AccessError, GatewayApi> {
  if (!plan.changed) return false;
  const api = yield* GatewayApi;
  yield* api.setWhitelistGroup({
    instanceId: input.instanceId,
    groupName: plan.groupName,
    ip: expectedIp,
    networkType: input.networkType,
  });
  yield* waitFor(
    `Allowlist group ${plan.groupName}`,
    api.groups(input.instanceId, input.networkType),
    (result) =>
      result.network.some(
        (group) =>
          group.DBInstanceIPArrayName.toLowerCase() === plan.groupName.toLowerCase() &&
          group.securityIPList.trim().replace(/\/32$/, "") === expectedIp,
      ),
    attempts.whitelist,
  );
  return true;
});

const applyAccount = Effect.fn("applyAccount")(function* (
  input: GatewayOnboardingInput,
  password: Redacted.Redacted<string>,
  plan: AccountPlan,
): Effect.fn.Return<boolean, AccessError, GatewayApi> {
  if (!plan.changed) return false;
  const api = yield* GatewayApi;
  yield* api.createAccount({
    instanceId: input.instanceId,
    accountName: plan.accountName,
    password,
  });
  yield* waitFor(
    `Account ${plan.accountName}`,
    api.instance(input.instanceId),
    (instance) =>
      instance.accounts.some(
        (account) => account.name.toLowerCase() === plan.accountName.toLowerCase(),
      ),
    attempts.account,
  );
  return true;
});

const applyGrants = Effect.fn("applyGrants")(function* (
  input: GatewayOnboardingInput,
  options: OnboardingOptions,
  password: Redacted.Redacted<string>,
  before: GrantsPlan,
): Effect.fn.Return<GrantsPlan, AccessError, GatewayApi | Postgres> {
  if (before.verification === "verified") return before;
  if (options.admin === undefined) {
    return yield* new AccessError({
      message:
        "Read-only grants are missing and no privileged database account was provided. " +
        "Pass --admin-account with --admin-password-file, then rerun.",
    });
  }
  const api = yield* GatewayApi;
  const postgres = yield* Postgres;
  const instance = yield* api.instance(input.instanceId);
  const optionsGrant = grantOptionsOf(input);
  const adminUrl = postgresUrl(
    options.admin.account,
    options.admin.password,
    instance.endpoint.host,
    instance.endpoint.port,
    input.database,
  );
  yield* postgres.run(adminUrl, buildGrantStatements(optionsGrant).map((item) => item.statement));
  const verified = yield* waitFor(
    `Read-only grants for ${input.account}`,
    verifyGrants(input, instance, password),
    (grants) => grants.verification === "verified",
    attempts.routes,
  );
  return { ...verified, changed: true };
});

export const applyGatewayOnboarding = Effect.fn("applyGatewayOnboarding")(function* (
  rawInput: GatewayOnboardingInput,
  options: OnboardingOptions,
): Effect.fn.Return<GatewayOnboardingResult, AccessError, GatewayApi | Postgres> {
  const input = yield* validateInput(rawInput);
  const before = yield* discover(input, options);
  if (options.accountPassword === undefined) {
    return yield* new AccessError({
      message:
        "No account password was provided. Pass --account-password-file " +
        "(the file is created with mode 0600 and a generated password when absent), then rerun.",
    });
  }
  const password = options.accountPassword;
  const steps: Array<GatewayOnboardingResult["steps"][number]> = [];

  const connectivityChanged = yield* applyConnectivity(before.connectivity, options);
  steps.push({
    kind: "connectivity",
    changed: before.connectivity.changed,
    applied: connectivityChanged,
    summary: before.connectivity.summary,
  });

  const whitelistChanged = yield* applyWhitelist(
    input,
    before.topology.instance.privateIp,
    before.whitelist,
  );
  steps.push({
    kind: "whitelist",
    changed: before.whitelist.changed,
    applied: whitelistChanged,
    summary: `${before.whitelist.groupName}: ${before.whitelist.previous.join(", ") || "absent"} -> ${
      before.whitelist.desired.join(", ") || "absent"
    }`,
  });

  const accountChanged = yield* applyAccount(input, password, before.account);
  steps.push({
    kind: "account",
    changed: before.account.changed,
    applied: accountChanged,
    summary: before.account.exists
      ? `Reused ${before.account.accountName}`
      : `Created ${before.account.accountName}`,
  });

  const grants = yield* applyGrants(input, options, password, before.grants);
  steps.push({
    kind: "grants",
    changed: before.grants.changed,
    applied: before.grants.verification !== "verified",
    summary:
      grants.issues.length === 0
        ? `Verified read-only permissions for ${input.account}`
        : `Applied read-only grants; outstanding: ${grants.issues.join("; ")}`,
  });

  return {
    applied: steps.some((step) => step.applied),
    plan: buildPlan(input, before),
    steps,
  };
});

const PASSWORD_SPECIALS = "!@#$%^&*_-+=";

/** 24-character password meeting RDS complexity rules (at least three classes). */
export const generatePassword = (): string => {
  const pick = (source: string) => source[randomBytes(1)[0]! % source.length]!;
  const classes = [
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "abcdefghijkmnopqrstuvwxyz",
    "23456789",
    PASSWORD_SPECIALS,
  ];
  const characters = [pick(classes[0]!), pick(classes[1]!), pick(classes[2]!), pick(classes[3]!)];
  while (characters.length < 24) {
    characters.push(pick(classes[characters.length % classes.length]!));
  }
  for (let index = characters.length - 1; index > 0; index--) {
    const swap = randomBytes(1)[0]! % (index + 1);
    [characters[index], characters[swap]] = [characters[swap]!, characters[index]!];
  }
  return characters.join("");
};
