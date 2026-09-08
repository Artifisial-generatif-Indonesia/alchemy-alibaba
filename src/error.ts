import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";

export const AlibabaService = Schema.Literals([
  "ECS",
  "ACK",
  "ACR",
  "Tair",
  "RDS",
  "VPC",
]);

export type AlibabaService = typeof AlibabaService.Type;

export class AlibabaProviderError extends Schema.TaggedError<AlibabaProviderError>()(
  "AlibabaProviderError",
  {
    service: AlibabaService,
    operation: Schema.String,
    message: Schema.String,
    code: Schema.optional(Schema.String),
    statusCode: Schema.optional(Schema.Number),
    requestId: Schema.optional(Schema.String),
    retryAfterMs: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
) {}

export class AlibabaInvariantError extends Schema.TaggedError<AlibabaInvariantError>()(
  "AlibabaInvariantError",
  {
    resourceType: Schema.String,
    operation: Schema.String,
    message: Schema.String,
  },
) {}

/** A bounded provider observation never reached its required state. */
export class AlibabaWaitTimeoutError extends Schema.TaggedError<AlibabaWaitTimeoutError>()(
  "AlibabaWaitTimeoutError",
  {
    service: AlibabaService,
    resourceType: Schema.String,
    operation: Schema.String,
    attempts: Schema.Number,
    intervalMs: Schema.Number,
    lastObservation: Schema.String,
    message: Schema.String,
  },
) {}

/** Independent Alibaba read models remained contradictory past the wait bound. */
export class AlibabaObservationConflictError extends Schema.TaggedError<AlibabaObservationConflictError>()(
  "AlibabaObservationConflictError",
  {
    service: AlibabaService,
    resourceType: Schema.String,
    operation: Schema.String,
    resourceId: Schema.String,
    observations: Schema.Array(Schema.String),
    attempts: Schema.Number,
    message: Schema.String,
  },
) {}

/** A paged inventory ended without proving that every resource was observed. */
export class AlibabaPaginationLimitError extends Schema.TaggedError<AlibabaPaginationLimitError>()(
  "AlibabaPaginationLimitError",
  {
    service: AlibabaService,
    operation: Schema.String,
    pageSize: Schema.Number,
    maxPages: Schema.Number,
    observedItems: Schema.Number,
    reportedTotal: Schema.optional(Schema.Number),
    message: Schema.String,
  },
) {}

/** A parent resource cannot be deleted while an opaque provider dependency remains. */
export class AlibabaDependencyBlockedError extends Schema.TaggedError<AlibabaDependencyBlockedError>()(
  "AlibabaDependencyBlockedError",
  {
    service: AlibabaService,
    resourceType: Schema.String,
    operation: Schema.String,
    resourceId: Schema.String,
    dependency: Schema.String,
    attempts: Schema.Number,
    providerCode: Schema.optional(Schema.String),
    requestId: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** A destructive lifecycle action was requested from a state that does not permit it. */
export class AlibabaUnsafeLifecycleTransitionError extends Schema.TaggedError<AlibabaUnsafeLifecycleTransitionError>()(
  "AlibabaUnsafeLifecycleTransitionError",
  {
    resourceType: Schema.String,
    operation: Schema.String,
    resourceId: Schema.String,
    fromState: Schema.String,
    allowedStates: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

const isRecord = Predicate.isObject;

const stringField = (
  value: Record<string, unknown>,
  key: string,
): string | undefined => {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
};

const numberField = (
  value: Record<string, unknown>,
  key: string,
): number | undefined => {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field)
    ? field
    : undefined;
};

const messageOf = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  if (isRecord(cause))
    return stringField(cause, "message") ?? "Alibaba Cloud API request failed";
  return "Alibaba Cloud API request failed";
};

export const fromSdkError = (
  service: AlibabaService,
  operation: string,
  cause: unknown,
): AlibabaProviderError => {
  const record = isRecord(cause) ? cause : {};
  // Darabonba's ResponseError.retryAfter and x-acs-retry-after are expressed
  // in milliseconds. This is also the unit consumed by its retry policy.
  const retryAfterMs = numberField(record, "retryAfter");
  // Preserve transport classification without retaining arbitrary SDK text:
  // SDK/credential error messages can embed request payloads and secrets.
  const transport =
    /ConnectTimeout|ReadTimeout|ResponseTimeout|RequestTimeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|temporary failure in name resolution|lookup .*i\/o timeout/i.test(
      messageOf(cause),
    );
  const candidateCode =
    stringField(record, "code") ??
    (transport ? "RequestTimeout" : stringField(record, "name"));
  const code =
    candidateCode !== undefined &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(candidateCode)
      ? candidateCode
      : undefined;
  const message = `${service} ${operation} failed${code === undefined ? "" : ` (${code})`}`;
  return new AlibabaProviderError({
    service,
    operation,
    message,
    code,
    statusCode: numberField(record, "statusCode"),
    requestId:
      stringField(record, "requestId") ?? stringField(record, "request_id"),
    retryAfterMs,
    // Alibaba error objects can contain a serialized request or credentials.
    // Preserve the safe diagnostic text, not the original enumerable object.
    cause: new Error(message),
  });
};

const transientCodes = new Set([
  "ConnectTimeout",
  "Conflict",
  "InternalError",
  "OperationConflict",
  "ReadTimeout",
  "RequestTimeout",
  "ResponseTimeout",
  "ServiceUnavailable",
  "TaskConflict",
  "Throttled",
  "Throttling",
  "Throttling.User",
  "TooManyRequests",
  // CreateVSwitch documents this code when another vSwitch in the same VPC
  // is still being created.
  "IncorrectVSwitchStatus",
]);

export const isTransient = (error: AlibabaProviderError): boolean =>
  error.statusCode === 408 ||
  error.statusCode === 409 ||
  error.statusCode === 429 ||
  (error.statusCode !== undefined && error.statusCode >= 500) ||
  (error.code !== undefined && transientCodes.has(error.code)) ||
  (error.code !== undefined &&
    /throttl|too.?many|internal|system.?error|service.?unavailable|operation.?conflict/i.test(
      error.code,
    )) ||
  /ConnectTimeout|ReadTimeout|ResponseTimeout|RequestTimeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|temporary failure in name resolution|lookup .*i\/o timeout/i.test(
    error.message,
  );

/**
 * A read that failed in a way a bounded observation loop should re-attempt
 * rather than abort on.
 *
 * `retryingSdkCall` already absorbs short transient failures, but its budget
 * (`ALIBABA_SAFE_RETRY_BUDGET_MS`) is measured per call, not per wait. A
 * readiness wait can legitimately run for the better part of an hour, so an
 * API blip that outlives one call's budget must consume an observation
 * attempt instead of destroying the whole wait — that is the difference
 * between a deploy that rides out a control-plane hiccup and one that strands
 * a half-built environment.
 *
 * Deliberately narrow: only Alibaba transport/throttling failures and an
 * exhausted per-call retry budget qualify. A rejected request (bad parameter,
 * unauthorized, dependency violation) still aborts immediately, because
 * repeating it cannot change the answer.
 */
export const isRetryableObservation = (error: unknown): boolean =>
  error instanceof AlibabaProviderError &&
  (isTransient(error) || error.code === "SafeRetryBudgetExceeded");

const absentResourceCodes: Record<AlibabaService, ReadonlySet<string>> = {
  ECS: new Set(["InvalidInstanceId.NotFound", "InvalidSecurityGroupId.NotFound", "InvalidSecurityGroupRuleId.NotFound"]),
  VPC: new Set([
    "InvalidVpcId.NotFound",
    "InvalidVSwitchId.NotFound",
    "InvalidVswitchId.NotFound",
  ]),
  RDS: new Set([
    "InvalidDBInstanceId.NotFound",
    "InvalidDBInstanceName.NotFound",
    "InvalidDBName.NotFound",
    "InvalidAccountName.NotFound",
    "InvalidAccount.NotFound",
    "InvalidDB.NotFound",
  ]),
  Tair: new Set([
    "InvalidInstanceId.NotFound",
    "InvalidAccountName.NotFound",
    "InvalidAccount.NotFound",
    "InvalidSecurityIpGroup.NotFound",
  ]),
  ACK: new Set([
    "NotFound",
    "Cluster.NotFound",
    "ErrorClusterNotFound",
    "NodePool.NotFound",
    "Nodepool.NotFound",
    "Addon.NotFound",
    "Task.NotFound",
  ]),
  ACR: new Set([
    "INSTANCE_NOT_EXIST",
    "NAMESPACE_NOT_EXIST",
    "REPO_NOT_EXIST",
    "REPOSITORY_NOT_EXIST",
    "ENDPOINT_NOT_EXIST",
    "VPC_NOT_EXIST",
  ]),
};

/** Only an explicit missing cloud-resource code proves absence. */
export const isNotFound = (error: AlibabaProviderError): boolean =>
  error.code !== undefined &&
  absentResourceCodes[error.service].has(error.code);

/** Create was rejected at the HTTP layer but may still have been accepted. */
export const isAmbiguousCreate = (error: AlibabaProviderError): boolean =>
  error.code === "CanNotAcquireLock" ||
  error.code === "InvalidConcurrentOperate" ||
  error.code === "SafeRetryBudgetExceeded" ||
  isTransient(error);

/** The instance exists but is not yet ready for the requested mutation. */
export const isIncorrectInstanceState = (
  error: AlibabaProviderError,
): boolean =>
  error.code === "IncorrectDBInstanceState" ||
  error.code === "IncorrectInstanceStatus";

/** Managed-service ENIs can outlive their parent briefly during teardown. */
export const isDependencyViolation = (error: AlibabaProviderError): boolean =>
  error.code === "DependencyViolation" ||
  error.code?.startsWith("DependencyViolation.") === true;

export const sdkCall = <Result>(
  service: AlibabaService,
  operation: string,
  call: () => Promise<Result>,
) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) => fromSdkError(service, operation, cause),
  });

interface AcrEnvelopeResponse {
  readonly statusCode?: number;
  readonly body?: {
    readonly isSuccess?: boolean;
    readonly code?: string;
    readonly requestId?: string;
  };
}

const validateAcrEnvelope = <Result extends AcrEnvelopeResponse>(
  operation: string,
  response: Result,
) => {
  const body = response.body;
  // ACR occasionally reports application errors with HTTP 200 and omits
  // IsSuccess entirely (for example Code=REPO_NOT_EXIST after deletion).
  // Only an absent code or the documented success code is a successful
  // envelope; otherwise waiters can poll a resource that is already gone.
  const codeIsSuccess =
    body?.code === undefined || body.code.toLowerCase() === "success";
  if (body?.isSuccess !== false && codeIsSuccess) {
    return Effect.succeed(response);
  }
  const code = body.code ?? "ACRRequestFailed";
  return Effect.fail(
    fromSdkError("ACR", operation, {
      code,
      message: `ACR API returned ${code}`,
      requestId: body.requestId,
      statusCode: response.statusCode,
    }),
  );
};

/** Validates ACR's application-level IsSuccess envelope as well as HTTP errors. */
export const acrSdkCall = <Result extends AcrEnvelopeResponse>(
  operation: string,
  call: () => Promise<Result>,
) =>
  sdkCall("ACR", operation, call).pipe(
    Effect.flatMap((response) => validateAcrEnvelope(operation, response)),
  );

const retrySchedule = Schedule.exponential(Duration.millis(250), 2).pipe(
  Schedule.jittered,
  Schedule.modifyDelay<Duration.Duration, AlibabaProviderError>(
    ({ duration, input }) =>
      Effect.succeed(
        Duration.millis(
          Math.max(Duration.toMillis(duration), input.retryAfterMs ?? 0),
        ),
      ),
  ),
);

export const ALIBABA_SAFE_RETRY_BUDGET_MS = 60_000;

export interface SafeRetryOptions {
  readonly budget?: Duration.Input;
}

const safeRetryBudgetError = (
  service: AlibabaService,
  operation: string,
): AlibabaProviderError =>
  fromSdkError(service, operation, {
    code: "SafeRetryBudgetExceeded",
    message: `${service} ${operation} exceeded its safe retry wall-clock budget`,
  });

/**
 * Bounds the whole retry sequence, including DNS work that can outlive the SDK's
 * socket timeouts. Use only for reads, idempotent mutations, and tokenized
 * creates because interrupting Effect cannot cancel every SDK promise.
 */
const withinSafeRetryBudget = <Result>(
  service: AlibabaService,
  operation: string,
  effect: Effect.Effect<Result, AlibabaProviderError>,
  options: SafeRetryOptions,
) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: options.budget ?? ALIBABA_SAFE_RETRY_BUDGET_MS,
      orElse: () => Effect.fail(safeRetryBudgetError(service, operation)),
    }),
  );

/** Retry only calls the provider has classified as safe to repeat. */
export const retryingSdkCall = <Result>(
  service: AlibabaService,
  operation: string,
  call: () => Promise<Result>,
  options: SafeRetryOptions = {},
) =>
  withinSafeRetryBudget(
    service,
    operation,
    sdkCall(service, operation, call).pipe(
      Effect.retry({
        while: isTransient,
        times: 6,
        schedule: retrySchedule,
      }),
    ),
    options,
  );

/** Retries safe ACR calls while validating the application-level envelope. */
export const retryingAcrSdkCall = <Result extends AcrEnvelopeResponse>(
  operation: string,
  call: () => Promise<Result>,
  options: SafeRetryOptions = {},
) =>
  withinSafeRetryBudget(
    "ACR",
    operation,
    acrSdkCall(operation, call).pipe(
      Effect.retry({
        while: isTransient,
        times: 6,
        schedule: retrySchedule,
      }),
    ),
    options,
  );
