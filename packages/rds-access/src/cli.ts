import { Config, Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { planAccess, refreshAccess, revokeAccess } from "./access.ts";
import { rdsApiLayer } from "./alibaba.ts";
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

export const makeCommand = (createLayer: typeof rdsApiLayer = rdsApiLayer) => {
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

  return Command.make("rds-access").pipe(
    Command.withDescription("Manage laptop IP access to Alibaba Cloud RDS"),
    Command.withSubcommands([refresh, revoke, plan]),
  );
};

export const command = makeCommand();

export const run = Command.run(command, { version: "0.1.0" }).pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
);
