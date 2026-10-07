import CredentialImport, { CLIProfileCredentialsProvider } from "@alicloud/credentials";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import RdsClientImport, * as RDS from "@alicloud/rds20140815";
import StsClientImport from "@alicloud/sts20150401";
import { Context, Data, Effect, Layer, Predicate, Schema } from "effect";
import { AccessError, Group, type Target } from "./model.ts";

// Native ESM sees the generated SDKs' CommonJS default as a nested export.
const interopDefault = <T>(value: T | { readonly default: T }): T =>
  typeof value === "object" && value !== null && "default" in value ? value.default : value;
const RdsClient = interopDefault(RdsClientImport);
const StsClient = interopDefault(StsClientImport);
const Credential = interopDefault(CredentialImport);

export interface RdsSdk {
  describeDBInstanceAttribute(request: RDS.DescribeDBInstanceAttributeRequest): Promise<unknown>;
  describeDBInstanceIPArrayList(
    request: RDS.DescribeDBInstanceIPArrayListRequest,
  ): Promise<unknown>;
  modifySecurityIps(request: RDS.ModifySecurityIpsRequest): Promise<unknown>;
  /** sts:GetCallerIdentity, used only to name the caller; failures are ignored. */
  getCallerIdentity?(): Promise<unknown>;
}

/** Where the credentials came from, so failures can name the identity that was used. */
export type CredentialSource =
  | { readonly kind: "flag"; readonly profile: string }
  | { readonly kind: "environment"; readonly profile: string }
  | { readonly kind: "named"; readonly profile: string }
  | { readonly kind: "default" };

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g;
const SECRET =
  /\b(access[_-]?key[_-]?(?:id|secret)|secret|signature|security[_-]?token|token|password|EncodedDiagnosticMessage)\b(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const ACCESS_KEY_ID = /\bLTAI[0-9A-Za-z]{8,}\b/g;

/** Printable, single-line, bounded text with credential-like values redacted. */
const sanitize = (value: unknown, max = 300): string | undefined => {
  if (!Predicate.isString(value)) return undefined;
  const text = value
    .replace(CONTROL, " ")
    .replace(SECRET, "$1$2[redacted]")
    .replace(ACCESS_KEY_ID, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "" || text === "undefined" || text === "null") return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const token = (value: unknown, pattern = /^[A-Za-z0-9][A-Za-z0-9_.:/*-]{0,127}$/) =>
  Predicate.isString(value) && value !== "undefined" && value !== "null" && pattern.test(value)
    ? value
    : undefined;

const field = (source: unknown, ...keys: ReadonlyArray<string>): unknown => {
  if (!Predicate.isObject(source)) return undefined;
  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
};

export const describeCredentials = (source: CredentialSource): string => {
  if (source.kind === "default") return "SDK default credential chain";
  const name = `profile "${sanitize(source.profile, 64) ?? ""}"`;
  return source.kind === "flag"
    ? `${name} (--profile)`
    : source.kind === "environment"
      ? `${name} (ALIBABA_CLOUD_PROFILE)`
      : name;
};

/** Only the RAM user or role name; account and principal IDs are not printed. */
export const callerName = (response: unknown): string | undefined => {
  const arn = field(field(response, "body") ?? response, "arn", "Arn");
  if (!Predicate.isString(arn)) return undefined;
  const [type, name] = arn.split(":").slice(4).join(":").split("/");
  if (type === "root") return "account root identity";
  const valid = token(name, /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/);
  if (valid === undefined) return undefined;
  if (type === "user") return `RAM user ${valid}`;
  if (type === "assumed-role" || type === "role") return `RAM role ${valid}`;
  return undefined;
};

// ResponseError renders "<Code>: code: <status>, <Message> request id: <RequestId>".
const SDK_MESSAGE = /^(?:[A-Za-z][A-Za-z0-9_.-]*: )?code: \d{3}, ([\s\S]*?)(?: request id: \S*)?$/;

/** Reads the SDK's ClientError/ServerError shape without retaining the raw payload. */
const diagnose = (cause: unknown) => {
  const data = field(cause, "data");
  const denied =
    field(cause, "accessDeniedDetail") ?? field(data, "AccessDeniedDetail", "accessDeniedDetail");
  const rawMessage = field(cause, "message");
  return {
    code:
      token(field(cause, "code"), /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/) ??
      token(field(data, "Code", "code"), /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
    serviceMessage:
      sanitize(field(data, "Message", "message")) ??
      (Predicate.isString(rawMessage)
        ? sanitize(SDK_MESSAGE.exec(rawMessage)?.[1] ?? rawMessage)
        : undefined),
    requestId: token(field(cause, "requestId") ?? field(data, "RequestId", "requestId")),
    authAction: token(field(denied, "AuthAction", "authAction")),
    noPermissionType: token(field(denied, "NoPermissionType", "noPermissionType")),
    policyType: token(field(denied, "PolicyType", "policyType")),
  };
};

const isPermissionDenied = (code: string | undefined) =>
  code !== undefined && /^(?:Forbidden|NoPermission)/.test(code);

class SdkRejection extends Data.TaggedError("SdkRejection")<{ readonly reason: unknown }> {}

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
    /** Best-effort RAM user/role name of the caller; never fails. */
    readonly caller?: Effect.Effect<string | undefined>;
  }
>()("alibaba-rds-access/RdsApi") {}

/** SDK injection supports offline tests without loading profiles or credentials. */
export const rdsApiLayer = (options: {
  readonly regionId: string;
  readonly profile?: string;
  /** Names the credential source in errors; defaults to the profile or the SDK chain. */
  readonly credentials?: CredentialSource;
  readonly sdk?: RdsSdk;
}) =>
  Layer.effect(
    RdsApi,
    Effect.gen(function* () {
      const credentials = describeCredentials(
        options.credentials ??
          (options.profile === undefined
            ? { kind: "default" }
            : { kind: "named", profile: options.profile }),
      );
      const sdk: RdsSdk =
        options.sdk ??
        (yield* Effect.try({
          try: () => {
            const credential =
              options.profile === undefined
                ? new Credential()
                : new Credential(
                    null,
                    CLIProfileCredentialsProvider.builder()
                      .withProfileName(options.profile)
                      .build(),
                  );
            const config = () =>
              new $OpenApiUtil.Config({
                regionId: options.regionId,
                credential,
                connectTimeout: 5_000,
                readTimeout: 20_000,
                userAgent: "alibaba-rds-access/0.1.1",
              });
            const rds = new RdsClient(config());
            return {
              describeDBInstanceAttribute: (request) => rds.describeDBInstanceAttribute(request),
              describeDBInstanceIPArrayList: (request) =>
                rds.describeDBInstanceIPArrayList(request),
              modifySecurityIps: (request) => rds.modifySecurityIps(request),
              // Created on demand: only failures and plan use the STS endpoint.
              getCallerIdentity: async () => new StsClient(config()).getCallerIdentity(),
            } satisfies RdsSdk;
          },
          catch: () =>
            new AccessError({
              message: `Could not load Alibaba credentials from the ${credentials}. Check ALIBABA_CLOUD_PROFILE or --profile.`,
              credentials,
            }),
        }));

      const lookup = sdk.getCallerIdentity?.bind(sdk);
      const caller: Effect.Effect<string | undefined> =
        lookup === undefined
          ? Effect.succeed(undefined)
          : Effect.tryPromise(lookup).pipe(
              Effect.map(callerName),
              Effect.timeout("5 seconds"),
              Effect.catchCause(() => Effect.succeed(undefined)),
            );

      const explainFailure = Effect.fn("RdsApi.explainFailure")(function* (
        operation: string,
        instanceId: string,
        cause: unknown,
      ) {
        const diagnostics = diagnose(cause);
        const denied = isPermissionDenied(diagnostics.code);
        const name = denied ? yield* caller : undefined;
        const action = diagnostics.authAction ?? `rds:${operation}`;
        const why = [
          diagnostics.noPermissionType && `NoPermissionType ${diagnostics.noPermissionType}`,
          diagnostics.policyType && `PolicyType ${diagnostics.policyType}`,
        ].filter(Predicate.isString);
        const lines = [
          `${operation} failed${diagnostics.code ? ` (${diagnostics.code})` : ""}` +
            (diagnostics.serviceMessage ? `: ${diagnostics.serviceMessage}` : "."),
          ...(diagnostics.requestId ? [`RequestId: ${diagnostics.requestId}`] : []),
          ...(denied && (diagnostics.authAction || why.length > 0)
            ? [`Denied action: ${action}${why.length > 0 ? ` (${why.join(", ")})` : ""}`]
            : []),
          `Credentials: ${credentials}${name ? `, ${name}` : ""}`,
          denied
            ? `This identity lacks ${action} on ${instanceId}; use a profile that has it.`
            : operation === "ModifySecurityIps"
              ? "Run plan to inspect the entry before retrying."
              : "Check the Alibaba profile and instance permissions.",
        ];
        return new AccessError({
          operation,
          message: lines.join("\n"),
          ...diagnostics,
          credentials,
          ...(name === undefined ? {} : { caller: name }),
        });
      });

      const sdkCall = <A>(operation: string, instanceId: string, call: () => Promise<A>) =>
        Effect.tryPromise({ try: call, catch: (reason) => new SdkRejection({ reason }) }).pipe(
          Effect.timeoutOrElse({
            duration: "25 seconds",
            orElse: () =>
              Effect.fail(
                new AccessError({
                  operation,
                  credentials,
                  message: `${operation} timed out. Run plan to inspect the current entry before retrying.`,
                }),
              ),
          }),
          Effect.catchTag("SdkRejection", ({ reason }) =>
            explainFailure(operation, instanceId, reason).pipe(Effect.flatMap(Effect.fail)),
          ),
        );

      return RdsApi.of({
        caller,
        verifyInstance: Effect.fn("RdsApi.verifyInstance")(function* (target) {
          if (target.regionId !== options.regionId) {
            return yield* new AccessError({
              message: "The client region does not match the requested region.",
            });
          }
          const response = yield* sdkCall("DescribeDBInstanceAttribute", target.instanceId, () =>
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
          const response = yield* sdkCall("DescribeDBInstanceIPArrayList", instanceId, () =>
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
          yield* sdkCall("ModifySecurityIps", target.instanceId, () =>
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
