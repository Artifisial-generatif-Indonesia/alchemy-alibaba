import { Config, Console, Effect, Option, Redacted } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { planAccess, refreshAccess, revokeAccess } from "./access.ts";
import { rdsApiLayer } from "./alibaba.ts";
import { gatewayApiLayer as createGatewayApiLayer } from "./gateway/alibaba.ts";
import { SqlIdentifier } from "./gateway/model.ts";
import type { GatewayOnboardingInput, GatewayOnboardingPlan } from "./gateway/model.ts";
import {
  applyGatewayOnboarding,
  generatePassword,
  planGatewayOnboarding,
} from "./gateway/onboard.ts";
import { ensurePasswordFile, readPasswordFile } from "./gateway/secret-file.ts";
import { postgresLayer } from "./gateway/sql-runner.ts";
import { DEFAULT_IP_SERVICE_URL, detectIPv4 } from "./ip.ts";
import { AccessError, Developer, HostIPv4, Target, type AccessPlan } from "./model.ts";

const targetFlags = {
  instanceId: Flag.string("instance").pipe(
    Flag.withFallbackConfig(Config.string("RDS_ACCESS_INSTANCE_ID")),
    Flag.withSchema(Target.fields.instanceId),
    Flag.withDescription("RDS instance ID (or RDS_ACCESS_INSTANCE_ID)"),
  ),
  regionId: Flag.string("region").pipe(
    Flag.withFallbackConfig(Config.string("ALIBABA_CLOUD_REGION")),
    Flag.withSchema(Target.fields.regionId),
    Flag.withDescription("Alibaba region (or ALIBABA_CLOUD_REGION)"),
  ),
  developer: Flag.string("developer").pipe(
    Flag.withFallbackConfig(Config.string("RDS_ACCESS_DEVELOPER")),
    Flag.withSchema(Developer),
    Flag.withDescription("Stable personal ID, such as your work email (or RDS_ACCESS_DEVELOPER)"),
  ),
  profile: Flag.string("profile").pipe(
    Flag.withFallbackConfig(Config.string("ALIBABA_CLOUD_PROFILE")),
    Flag.optional,
    Flag.withDescription("Named aliyun CLI profile; otherwise use the SDK credential chain"),
  ),
  networkType: Flag.choice("network-type", ["MIX", "VPC", "Classic"]).pipe(
    Flag.withDefault("MIX"),
    Flag.withDescription("Whitelist mode; use MIX for PostgreSQL on cloud disks"),
  ),
  json: Flag.boolean("json").pipe(Flag.withDefault(false)),
};
const ipFlag = Flag.string("ip").pipe(
  Flag.withSchema(HostIPv4),
  Flag.optional,
  Flag.withDescription(
    "Override auto-detection with one source IPv4 address (also supports private VPN addresses)",
  ),
);

const printPlan = (plan: AccessPlan, json: boolean, applied: boolean) =>
  Console.log(
    json
      ? JSON.stringify({ ...plan, applied })
      : `${plan.instanceId} (${plan.regionId}) / ${plan.groupName}\n` +
          `${plan.previous.join(", ") || "absent"} → ${plan.desired.join(", ") || "absent"}\n` +
          (applied
            ? plan.changed
              ? "RDS confirmed the allowlist update."
              : "Already up to date."
            : "Preview only; no changes made."),
  );

const slugify = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 64);
  return /^[a-z]/.test(slug) ? slug : `db_${slug}`.slice(0, 64);
};

const gatewayFlags = {
  instanceId: Flag.string("instance").pipe(
    Flag.withFallbackConfig(Config.string("RDS_ACCESS_INSTANCE_ID")),
    Flag.withSchema(Target.fields.instanceId),
    Flag.withDescription("RDS instance ID (or RDS_ACCESS_INSTANCE_ID)"),
  ),
  regionId: Flag.string("region").pipe(
    Flag.withFallbackConfig(Config.string("ALIBABA_CLOUD_REGION")),
    Flag.withSchema(Target.fields.regionId),
    Flag.withDescription("Alibaba region (or ALIBABA_CLOUD_REGION)"),
  ),
  database: Flag.string("database").pipe(
    Flag.withFallbackConfig(Config.string("RDS_ACCESS_DATABASE")),
    Flag.withSchema(SqlIdentifier),
    Flag.withDescription("Existing database name; never created or dropped"),
  ),
  name: Flag.string("name").pipe(
    Flag.withFallbackConfig(Config.string("RDS_ACCESS_NAME")),
    Flag.withDescription("Display name shown by the gateway UI (or RDS_ACCESS_NAME)"),
  ),
  alias: Flag.string("alias").pipe(
    Flag.optional,
    Flag.withDescription("Browser-facing connection alias; defaults to a slug of --name"),
  ),
  account: Flag.string("account").pipe(
    Flag.withFallbackConfig(Config.string("RDS_ACCESS_ACCOUNT")),
    Flag.withDefault("gateway_ro"),
    Flag.withSchema(SqlIdentifier),
    Flag.withDescription("Dedicated read-only account (default gateway_ro)"),
  ),
  whitelistGroup: Flag.string("whitelist-group").pipe(
    Flag.withDefault("gateway"),
    Flag.withDescription("Dedicated RDS allowlist group (default gateway)"),
  ),
  schema: Flag.atLeast(Flag.string("schema"), 0).pipe(
    Flag.withDescription("Schema to grant read-only access to; repeatable (default public)"),
  ),
  ownerRole: Flag.atLeast(Flag.string("owner-role"), 0).pipe(
    Flag.withDescription(
      "Role that creates future tables; repeatable. Adds default SELECT privileges.",
    ),
  ),
  gatewayInstanceId: Flag.string("gateway-instance-id").pipe(
    Flag.withFallbackConfig(Config.string("RDS_ACCESS_GATEWAY_INSTANCE_ID")),
    Flag.optional,
    Flag.withDescription("Gateway ECS instance; otherwise discovered by application tag"),
  ),
  profile: Flag.string("profile").pipe(
    Flag.withFallbackConfig(Config.string("ALIBABA_CLOUD_PROFILE")),
    Flag.optional,
    Flag.withDescription("Named aliyun CLI profile; otherwise use the SDK credential chain"),
  ),
  accountPasswordFile: Flag.string("account-password-file").pipe(
    Flag.withFallbackConfig(Config.string("RDS_ACCESS_ACCOUNT_PASSWORD_FILE")),
    Flag.optional,
    Flag.withDescription(
      "0600 file holding the database account password; generated during apply when absent",
    ),
  ),
  adminAccount: Flag.string("admin-account").pipe(
    Flag.withFallbackConfig(Config.string("RDS_ACCESS_ADMIN_ACCOUNT")),
    Flag.optional,
    Flag.withDescription("Privileged account used only to apply missing read-only grants"),
  ),
  adminPasswordFile: Flag.string("admin-password-file").pipe(
    Flag.withFallbackConfig(Config.string("RDS_ACCESS_ADMIN_PASSWORD_FILE")),
    Flag.optional,
    Flag.withDescription("0600 file holding the privileged account password"),
  ),
  createPeering: Flag.boolean("create-peering").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Plan or create a same-region VPC peering when none connects the VPCs"),
  ),
  networkType: Flag.choice("network-type", ["MIX", "VPC", "Classic"]).pipe(
    Flag.withDefault("MIX"),
    Flag.withDescription("Whitelist mode; use MIX for PostgreSQL on cloud disks"),
  ),
  json: Flag.boolean("json").pipe(Flag.withDefault(false)),
};

interface GatewayArgs {
  readonly instanceId: string;
  readonly regionId: string;
  readonly database: string;
  readonly name: string;
  readonly alias: Option.Option<string>;
  readonly account: string;
  readonly whitelistGroup: string;
  readonly schema: ReadonlyArray<string>;
  readonly ownerRole: ReadonlyArray<string>;
  readonly gatewayInstanceId: Option.Option<string>;
  readonly profile: Option.Option<string>;
  readonly accountPasswordFile: Option.Option<string>;
  readonly adminAccount: Option.Option<string>;
  readonly adminPasswordFile: Option.Option<string>;
  readonly createPeering: boolean;
  readonly networkType: Target["networkType"];
  readonly json: boolean;
}

const gatewayInput = (args: GatewayArgs): GatewayOnboardingInput => ({
  instanceId: args.instanceId,
  regionId: args.regionId,
  database: args.database,
  displayName: args.name,
  alias: Option.getOrElse(args.alias, () => slugify(args.name) || args.database),
  account: args.account,
  whitelistGroup: args.whitelistGroup,
  schemas: args.schema.length === 0 ? ["public"] : [...args.schema],
  ownerRoles: [...args.ownerRole],
  networkType: args.networkType,
  ...(Option.isSome(args.gatewayInstanceId)
    ? { gatewayInstanceId: args.gatewayInstanceId.value }
    : {}),
  ...(Option.isSome(args.profile) ? { profile: args.profile.value } : {}),
});

interface GatewayCommandLayers {
  readonly gateway?: typeof createGatewayApiLayer;
  readonly postgres?: typeof postgresLayer;
}

const gatewayLayer = (
  args: GatewayArgs,
  layers: GatewayCommandLayers,
): {
  readonly gateway: ReturnType<typeof createGatewayApiLayer>;
  readonly postgres: ReturnType<typeof postgresLayer>;
} => ({
  gateway: (layers.gateway ?? createGatewayApiLayer)({
    regionId: args.regionId,
    profile: Option.getOrUndefined(args.profile),
  }),
  postgres: (layers.postgres ?? postgresLayer)(),
});

const adminOptions = (args: GatewayArgs) =>
  Effect.gen(function* () {
    if (Option.isSome(args.adminPasswordFile)) {
      if (Option.isNone(args.adminAccount)) {
        return yield* new AccessError({
          message: "--admin-password-file requires --admin-account.",
        });
      }
      const password = yield* readPasswordFile(args.adminPasswordFile.value);
      if (Option.isNone(password)) {
        return yield* new AccessError({
          message: `Admin password file ${args.adminPasswordFile.value} is missing or empty.`,
        });
      }
      return { account: args.adminAccount.value, password: password.value };
    }
    if (Option.isSome(args.adminAccount)) {
      return yield* new AccessError({
        message: "--admin-account requires --admin-password-file.",
      });
    }
    return undefined;
  });

const summaryOf = (step: GatewayOnboardingPlan["steps"][number]): string => {
  switch (step.kind) {
    case "connectivity":
      return step.summary;
    case "whitelist":
      return `${step.groupName}: ${step.previous.join(", ") || "absent"} → ${
        step.desired.join(", ") || "absent"
      } (${step.networkType})`;
    case "account":
      return step.exists ? `reuse ${step.accountName}` : `create ${step.accountName} (Normal)`;
    case "grants":
      return step.verification === "verified"
        ? "read-only permissions already verified"
        : step.statements.map((item) => item.description).join("; ");
  }
};

const printGatewayPlan = (plan: GatewayOnboardingPlan, json: boolean) => {
  if (json) return Console.log(JSON.stringify(plan));
  return Console.log(
    [
      `${plan.displayName} (${plan.alias}) → ${plan.endpoint.host}:${plan.endpoint.port}/${plan.endpoint.database}`,
      ...plan.steps.map(
        (step) => `  [${step.changed ? "change" : "keep  "}] ${step.kind}: ${summaryOf(step)}`,
      ),
      ...plan.warnings.map((warning) => `  ! ${warning}`),
      "Preview only; no changes made.",
    ].join("\n"),
  );
};

const printGatewayResult = (
  result: import("./gateway/model.ts").GatewayOnboardingResult,
  json: boolean,
) => {
  if (json) return Console.log(JSON.stringify({ ...result, applied: true }));
  return Console.log(
    [
      ...result.steps.map(
        (step) =>
          `  [${step.applied ? "applied" : step.changed ? "planned" : "kept   "}] ${step.kind}: ${step.summary}`,
      ),
      "Applied. Register the connection and Worker allowlist entry from the gateway repository.",
    ].join("\n"),
  );
};

const makeGatewayPlan = (layers: GatewayCommandLayers) =>
  Command.make(
    "plan",
    gatewayFlags,
    Effect.fn(function* (args) {
      const layer = gatewayLayer(args, layers);
      const accountPassword = Option.isSome(args.accountPasswordFile)
        ? yield* readPasswordFile(args.accountPasswordFile.value)
        : Option.none<Redacted.Redacted<string>>();
      const plan = yield* planGatewayOnboarding(gatewayInput(args), {
        createPeering: args.createPeering,
        ...(Option.isSome(accountPassword) ? { accountPassword: accountPassword.value } : {}),
      }).pipe(Effect.provide(layer.gateway), Effect.provide(layer.postgres));
      yield* printGatewayPlan(plan, args.json);
    }),
  ).pipe(
    Command.withDescription(
      "Preview connectivity, allowlist, account and read-only grant changes",
    ),
  );

const makeGatewayApply = (layers: GatewayCommandLayers) =>
  Command.make(
    "apply",
    gatewayFlags,
    Effect.fn(function* (args) {
      const layer = gatewayLayer(args, layers);
      if (Option.isNone(args.accountPasswordFile)) {
        return yield* new AccessError({
          message:
            "--account-password-file is required for apply. The file is created with mode 0600 " +
            "and a generated password when it does not exist; the password is never passed on the command line.",
        });
      }
      const password = yield* ensurePasswordFile(args.accountPasswordFile.value, generatePassword);
      const admin = yield* adminOptions(args);
      const result = yield* applyGatewayOnboarding(gatewayInput(args), {
        createPeering: args.createPeering,
        accountPassword: password,
        ...(admin === undefined ? {} : { admin }),
      }).pipe(Effect.provide(layer.gateway), Effect.provide(layer.postgres));
      yield* printGatewayResult(result, args.json);
    }),
  ).pipe(
    Command.withDescription(
      "Apply the planned changes; safe to rerun after partial failures",
    ),
  );

export const makeCommand = (
  layers: {
    readonly rds?: typeof rdsApiLayer;
    readonly gateway?: typeof createGatewayApiLayer;
    readonly postgres?: typeof postgresLayer;
  } = {},
) => {
  const createLayer = layers.rds ?? rdsApiLayer;
  const refresh = Command.make(
    "refresh",
    { ...targetFlags, ip: ipFlag },
    Effect.fn(function* (args) {
      const ip = Option.isSome(args.ip) ? args.ip.value : yield* detectIPv4(DEFAULT_IP_SERVICE_URL);
      const plan = yield* refreshAccess(args, ip).pipe(
        Effect.provide(
          createLayer({
            regionId: args.regionId,
            profile: Option.getOrUndefined(args.profile),
          }),
        ),
      );
      yield* printPlan(plan, args.json, true);
    }),
  ).pipe(
    Command.withDescription(
      "Replace your developer allowlist entry with this laptop's current IPv4 address",
    ),
  );

  const revoke = Command.make(
    "revoke",
    targetFlags,
    Effect.fn(function* (args) {
      const plan = yield* revokeAccess(args).pipe(
        Effect.provide(
          createLayer({
            regionId: args.regionId,
            profile: Option.getOrUndefined(args.profile),
          }),
        ),
      );
      yield* printPlan(plan, args.json, true);
    }),
  ).pipe(Command.withDescription("Remove remote access granted by your developer group"));

  const plan = Command.make(
    "plan",
    { ...targetFlags, ip: ipFlag, revoke: Flag.boolean("revoke").pipe(Flag.withDefault(false)) },
    Effect.fn(function* (args) {
      if (args.revoke && Option.isSome(args.ip)) {
        return yield* new AccessError({ message: "Use --revoke or --ip, not both." });
      }
      const ip = args.revoke
        ? undefined
        : Option.isSome(args.ip)
          ? args.ip.value
          : yield* detectIPv4(DEFAULT_IP_SERVICE_URL);
      const result = yield* planAccess(args, ip).pipe(
        Effect.provide(
          createLayer({
            regionId: args.regionId,
            profile: Option.getOrUndefined(args.profile),
          }),
        ),
      );
      yield* printPlan(result, args.json, false);
    }),
  ).pipe(
    Command.withDescription("Preview a refresh, or a revoke with --revoke, without changing RDS"),
  );

  const gateway = Command.make("gateway").pipe(
    Command.withDescription("Onboard an existing RDS database into the read-only gateway"),
    Command.withSubcommands([makeGatewayPlan(layers), makeGatewayApply(layers)]),
  );

  return Command.make("rds-access").pipe(
    Command.withDescription("Manage developer and gateway access to Alibaba Cloud RDS"),
    Command.withSubcommands([refresh, revoke, plan, gateway]),
  );
};

export const command = makeCommand();

export const run = Command.run(command, { version: "0.1.0" }).pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
);
