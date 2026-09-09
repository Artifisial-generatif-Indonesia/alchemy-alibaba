import CredentialImport, { CLIProfileCredentialsProvider } from "@alicloud/credentials";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import RdsClientImport, * as RDS from "@alicloud/rds20140815";
import { Context, Effect, Layer, Predicate, Schema } from "effect";
import { AccessError, Group, type Target } from "./model.ts";

// Native ESM sees the generated SDKs' CommonJS default as a nested export.
const interopDefault = <T>(value: T | { readonly default: T }): T =>
  typeof value === "object" && value !== null && "default" in value ? value.default : value;
const RdsClient = interopDefault(RdsClientImport);
const Credential = interopDefault(CredentialImport);

export interface RdsSdk {
  describeDBInstanceAttribute(request: RDS.DescribeDBInstanceAttributeRequest): Promise<unknown>;
  describeDBInstanceIPArrayList(
    request: RDS.DescribeDBInstanceIPArrayListRequest,
  ): Promise<unknown>;
  modifySecurityIps(request: RDS.ModifySecurityIpsRequest): Promise<unknown>;
}

const InstanceResponse = Schema.Struct({
  body: Schema.Struct({
    items: Schema.Struct({
      DBInstanceAttribute: Schema.Array(
        Schema.Struct({ DBInstanceId: Schema.String, regionId: Schema.String }),
      ),
    }),
  }),
});
const GroupsResponse = Schema.Struct({
  body: Schema.Struct({
    items: Schema.Struct({
      DBInstanceIPArray: Schema.Array(Group),
    }),
  }),
});

const sdkCall = <A>(operation: string, call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) => {
      const candidate = Predicate.isObject(cause) ? cause.code : undefined;
      const code =
        typeof candidate === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(candidate)
          ? candidate
          : undefined;
      return new AccessError({
        operation,
        code,
        message:
          `${operation} failed${code ? ` (${code})` : ""}. ` +
          (operation === "ModifySecurityIps"
            ? "Run plan to inspect the entry before retrying. If access was denied, check the profile's instance permissions."
            : "Check the Alibaba profile and instance permissions."),
      });
    },
  }).pipe(
    Effect.timeoutOrElse({
      duration: "25 seconds",
      orElse: () =>
        Effect.fail(
          new AccessError({
            operation,
            message: `${operation} timed out. Run plan to inspect the current entry before retrying.`,
          }),
        ),
    }),
  );

export class RdsApi extends Context.Service<
  RdsApi,
  {
    readonly verifyInstance: (target: Target) => Effect.Effect<void, AccessError>;
    /** Omit networkType to read all networks; otherwise filter on the server. */
    readonly groups: (
      instanceId: string,
      networkType?: Target["networkType"],
    ) => Effect.Effect<ReadonlyArray<Group>, AccessError>;
    readonly setGroup: (
      target: Target,
      groupName: string,
      ip: string,
    ) => Effect.Effect<void, AccessError>;
  }
>()("alibaba-rds-access/RdsApi") {}

/** SDK injection supports offline tests without loading profiles or credentials. */
export const rdsApiLayer = (options: {
  readonly regionId: string;
  readonly profile?: string;
  readonly sdk?: RdsSdk;
}) =>
  Layer.effect(
    RdsApi,
    Effect.gen(function* () {
      const sdk =
        options.sdk ??
        (yield* Effect.try({
          try: () =>
            new RdsClient(
              new $OpenApiUtil.Config({
                regionId: options.regionId,
                credential:
                  options.profile === undefined
                    ? new Credential()
                    : new Credential(
                        null,
                        CLIProfileCredentialsProvider.builder()
                          .withProfileName(options.profile)
                          .build(),
                      ),
                connectTimeout: 5_000,
                readTimeout: 20_000,
                userAgent: "alibaba-rds-access/0.1.0",
              }),
            ),
          catch: () =>
            new AccessError({
              message:
                "Could not load Alibaba credentials. Check ALIBABA_CLOUD_PROFILE or --profile.",
            }),
        }));
      return RdsApi.of({
        verifyInstance: Effect.fn("RdsApi.verifyInstance")(function* (target) {
          if (target.regionId !== options.regionId) {
            return yield* new AccessError({
              message: "The client region does not match the requested region.",
            });
          }
          const response = yield* sdkCall("DescribeDBInstanceAttribute", () =>
            sdk.describeDBInstanceAttribute(
              new RDS.DescribeDBInstanceAttributeRequest({ DBInstanceId: target.instanceId }),
            ),
          );
          const decoded = yield* Schema.decodeUnknownEffect(InstanceResponse)(response).pipe(
            Effect.mapError(
              () =>
                new AccessError({
                  message: "RDS returned incomplete instance details; access was not changed.",
                }),
            ),
          );
          const instances = decoded.body.items.DBInstanceAttribute;
          if (
            instances.length !== 1 ||
            instances[0].DBInstanceId !== target.instanceId ||
            instances[0].regionId !== target.regionId
          ) {
            return yield* new AccessError({
              message: "RDS instance identity or region did not match; access was not changed.",
            });
          }
        }),
        groups: Effect.fn("RdsApi.groups")(function* (instanceId, networkType) {
          const response = yield* sdkCall("DescribeDBInstanceIPArrayList", () =>
            sdk.describeDBInstanceIPArrayList(
              new RDS.DescribeDBInstanceIPArrayListRequest({
                DBInstanceId: instanceId,
                whitelistNetworkType: networkType,
              }),
            ),
          );
          const decoded = yield* Schema.decodeUnknownEffect(GroupsResponse)(response).pipe(
            Effect.mapError(
              () =>
                new AccessError({
                  message:
                    "RDS returned an incomplete allowlist; access was not changed by this read.",
                }),
            ),
          );
          return decoded.body.items.DBInstanceIPArray;
        }),
        setGroup: Effect.fn("RdsApi.setGroup")(function* (target, groupName, ip) {
          // Exactly one named group. Do not retry an ambiguous write automatically.
          yield* sdkCall("ModifySecurityIps", () =>
            sdk.modifySecurityIps(
              new RDS.ModifySecurityIpsRequest({
                DBInstanceId: target.instanceId,
                DBInstanceIPArrayName: groupName,
                securityIps: ip,
                modifyMode: "Cover",
                securityIPType: "IPv4",
                whitelistNetworkType: target.networkType,
              }),
            ),
          );
        }),
      });
    }),
  );
