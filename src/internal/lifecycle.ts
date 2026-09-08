import { createPhysicalName } from "alchemy/PhysicalName";
import { createInternalTags, stripInternalTags } from "alchemy/Tags";
import * as Duration from "effect/Duration";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  AlibabaInvariantError,
  AlibabaPaginationLimitError,
  AlibabaWaitTimeoutError,
  isRetryableObservation,
  type AlibabaProviderError,
  type AlibabaService,
} from "../error.ts";

export interface WaitOptions {
  readonly attempts?: number;
  readonly interval?: Duration.Input;
}

export const defaultWaitOptions: Required<WaitOptions> = {
  attempts: 120,
  interval: Duration.seconds(10),
};

export const physicalName = (
  id: string,
  requested: string | undefined,
  maxLength: number,
) =>
  requested === undefined
    ? createPhysicalName({ id, maxLength, lowercase: true })
    : Effect.succeed(requested);

export const desiredTags = Effect.fn(function* (
  id: string,
  tags: Readonly<Record<string, string>> | undefined,
) {
  return { ...tags, ...(yield* createInternalTags(id)) };
});

export const userTags = (
  tags: Readonly<Record<string, string>> | undefined,
): Record<string, string> => stripInternalTags({ ...tags });

export const tagsEqual = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean => {
  const leftEntries = Object.entries(left);
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(([key, value]) => right[key] === value)
  );
};

export type WaitResult<Value> = Data.TaggedEnum<{
  Completed: {
    readonly value: Value;
    readonly attempts: number;
    readonly intervalMs: number;
  };
  Exhausted: {
    readonly value: Value;
    readonly attempts: number;
    readonly intervalMs: number;
  };
}>;

/**
 * Observe an Effect until its predicate succeeds, preserving the final value.
 *
 * A read that fails `retryRead` aborts the observation immediately; a read
 * that satisfies it consumes one attempt and the loop continues, so a
 * transient API failure costs an interval rather than the entire wait. When
 * the budget runs out while the most recent read was still failing, that
 * error surfaces — a persistent outage reports the real cause instead of a
 * generic readiness timeout.
 */
export const observeUntil = <Value, Error, Requirements>(options: {
  readonly read: Effect.Effect<Value, Error, Requirements>;
  readonly ready: (value: Value) => boolean;
  readonly wait?: WaitOptions;
  /**
   * Errors treated as an unusable observation instead of a fatal read.
   * Defaults to Alibaba transport/throttling failures and an exhausted
   * per-call retry budget; pass `() => false` to restore abort-on-failure
   * for loops whose `read` already encodes rejection as a value.
   */
  readonly retryRead?: (error: Error) => boolean;
}): Effect.Effect<WaitResult<Value>, Error, Requirements> => {
  const wait = { ...defaultWaitOptions, ...options.wait };
  const attempts = Math.max(1, Math.trunc(wait.attempts));
  const retryRead = options.retryRead ?? isRetryableObservation;
  type Observation = Data.TaggedEnum<{
    Pending: { readonly value: Value };
    Ready: { readonly value: Value };
    Failed: { readonly error: Error };
  }>;
  const Observation = Data.taggedEnum<Observation>();
  const Result = Data.taggedEnum<WaitResult<Value>>();
  return options.read.pipe(
    Effect.map((value) =>
      options.ready(value)
        ? Observation.Ready({ value })
        : Observation.Pending({ value }),
    ),
    Effect.catchIf(retryRead, (error) =>
      Effect.succeed(Observation.Failed({ error })),
    ),
    Effect.repeat({
      schedule: Schedule.spaced(wait.interval),
      times: attempts - 1,
      until: Observation.$is("Ready"),
    }),
    // `until` is a type guard, so `repeat` narrows its success type to
    // `Ready`. That is only true when the predicate is what stopped the
    // loop: exhausting `times` yields the last observation, whatever it was.
    Effect.flatMap((observation: Observation) => {
      // The budget expired with the read still failing: report the cause
      // rather than claiming the resource never became ready.
      if (Observation.$is("Failed")(observation)) {
        return Effect.fail(observation.error);
      }
      const fields = {
        value: observation.value,
        attempts,
        intervalMs: Duration.toMillis(wait.interval),
      };
      return Effect.succeed(
        Observation.$is("Ready")(observation)
          ? Result.Completed(fields)
          : Result.Exhausted(fields),
      );
    }),
  );
};

/**
 * Drains a page-numbered Alibaba list API exhaustively.
 *
 * `list` powers account-wide teardown, so a silently truncated first page is
 * worse than no implementation at all: it would report an orphan as absent.
 * Stops on a short page or once the reported total is reached, and bounds the
 * loop so a control plane that keeps answering with full pages cannot spin
 * forever.
 */
export const paginate = <Item, Error, Requirements>(options: {
  readonly service: AlibabaService;
  readonly operation: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly page: (input: {
    readonly pageNumber: number;
    readonly pageSize: number;
  }) => Effect.Effect<
    { readonly items: readonly Item[]; readonly totalCount?: number },
    Error,
    Requirements
  >;
}): Effect.Effect<
  Item[],
  Error | AlibabaPaginationLimitError,
  Requirements
> =>
  Effect.gen(function* () {
    const pageSize = options.pageSize ?? 50;
    const maxPages = options.maxPages ?? 200;
    const items: Item[] = [];
    let reportedTotal: number | undefined;
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = yield* options.page({ pageNumber, pageSize });
      items.push(...page.items);
      reportedTotal = page.totalCount ?? reportedTotal;
      const reachedReportedTotal =
        reportedTotal !== undefined && items.length >= reportedTotal;
      const reachedShortPage =
        reportedTotal === undefined && page.items.length < pageSize;
      if (reachedReportedTotal || reachedShortPage) {
        return items;
      }
    }
    return yield* new AlibabaPaginationLimitError({
      service: options.service,
      operation: options.operation,
      pageSize,
      maxPages,
      observedItems: items.length,
      reportedTotal,
      message: `${options.service} ${options.operation} did not prove inventory completion after ${maxPages} pages`,
    });
  });

export const requireValue = <Value>(
  value: Value | null | undefined,
  resourceType: string,
  operation: string,
  message: string,
): Effect.Effect<Value, AlibabaInvariantError> =>
  value === undefined || value === null
    ? Effect.fail(
        new AlibabaInvariantError({ resourceType, operation, message }),
      )
    : Effect.succeed(value);

export const waitFor = <Value, Error, Requirements>(options: {
  readonly service: AlibabaService;
  readonly resourceType?: string;
  readonly operation: string;
  readonly read: Effect.Effect<Value, Error, Requirements>;
  readonly ready: (value: Value) => boolean;
  /** A bounded, credential-free description included in timeout diagnostics. */
  readonly describe?: (value: Value) => string;
  readonly wait?: WaitOptions;
}): Effect.Effect<Value, Error | AlibabaWaitTimeoutError, Requirements> => {
  const wait = { ...defaultWaitOptions, ...options.wait };
  return observeUntil({
    read: options.read,
    ready: options.ready,
    wait,
  }).pipe(
    Effect.flatMap((result) => {
      if (result._tag === "Completed") return Effect.succeed(result.value);
      const resourceType = options.resourceType ?? `Alibaba.${options.service}`;
      return Effect.fail(
        new AlibabaWaitTimeoutError({
          service: options.service,
          resourceType,
          operation: options.operation,
          attempts: result.attempts,
          intervalMs: result.intervalMs,
          lastObservation: options.describe?.(result.value) ?? "not-ready",
          message: `${resourceType} did not reach the requested state after ${result.attempts} observations`,
        }),
      );
    }),
  );
};

/** Polls through an eventually-consistent not-found window until present. */
export const waitForPresent = <Value, Error, Requirements>(options: {
  readonly service: AlibabaService;
  readonly resourceType?: string;
  readonly operation: string;
  readonly read: Effect.Effect<Value | undefined, Error, Requirements>;
  readonly ready: (value: Value) => boolean;
  readonly describe?: (value: Value | undefined) => string;
  readonly wait?: WaitOptions;
}): Effect.Effect<Value, Error | AlibabaWaitTimeoutError, Requirements> => {
  const wait = { ...defaultWaitOptions, ...options.wait };
  const ready = (value: Value | undefined): value is Value =>
    value !== undefined && options.ready(value);
  return observeUntil({ read: options.read, ready, wait }).pipe(
    Effect.flatMap((result) => {
      if (result._tag === "Completed" && result.value !== undefined) {
        return Effect.succeed(result.value);
      }
      const resourceType = options.resourceType ?? `Alibaba.${options.service}`;
      return Effect.fail(
        new AlibabaWaitTimeoutError({
          service: options.service,
          resourceType,
          operation: options.operation,
          attempts: result.attempts,
          intervalMs: result.intervalMs,
          lastObservation:
            options.describe?.(result.value) ??
            (result.value === undefined ? "absent" : "not-ready"),
          message: `${resourceType} was not present and ready after ${result.attempts} observations`,
        }),
      );
    }),
  );
};

/** Polls until a resource can no longer be observed. */
export const waitForAbsent = <Value, Error, Requirements>(options: {
  readonly service: AlibabaService;
  readonly resourceType?: string;
  readonly operation: string;
  readonly read: Effect.Effect<Value | undefined, Error, Requirements>;
  readonly wait?: WaitOptions;
}): Effect.Effect<void, Error | AlibabaWaitTimeoutError, Requirements> =>
  waitFor({
    ...options,
    ready: (value) => value === undefined,
    describe: (value) => (value === undefined ? "absent" : "present"),
  }).pipe(Effect.asVoid);

/**
 * Repeats a mutating request until Alibaba accepts it. Timeouts surface the
 * last retryable provider error instead of a generic readiness invariant.
 */
export const waitUntilAccepted = <Result, Requirements>(options: {
  readonly service: AlibabaService;
  readonly operation: string;
  readonly request: Effect.Effect<Result, AlibabaProviderError, Requirements>;
  readonly retryIf: (error: AlibabaProviderError) => boolean;
  readonly wait?: WaitOptions;
}): Effect.Effect<Result, AlibabaProviderError, Requirements> => {
  type Acceptance = Data.TaggedEnum<{
    Rejected: { readonly error: AlibabaProviderError };
    Accepted: { readonly result: Result };
  }>;
  const Acceptance = Data.taggedEnum<Acceptance>();
  const request = Effect.matchEffect(options.request, {
    onFailure: (error) => {
      if (!options.retryIf(error)) return Effect.fail(error);
      return Effect.succeed(Acceptance.Rejected({ error }));
    },
    onSuccess: (result) => Effect.succeed(Acceptance.Accepted({ result })),
  });
  return observeUntil({
    read: request,
    ready: Acceptance.$is("Accepted"),
    wait: options.wait,
    // `retryIf` is the caller's complete classification of what may be
    // repeated; anything it rejects must stay fatal.
    retryRead: () => false,
  }).pipe(
    Effect.flatMap((result) =>
      Acceptance.$match(result.value, {
        Accepted: ({ result }) => Effect.succeed(result),
        Rejected: ({ error }) => Effect.fail(error),
      }),
    ),
  );
};

/**
 * Sends one asynchronous delete request, but treats an error as accepted when
 * a fresh read proves that the resource is already gone or deleting. This is
 * the restart/race boundary for providers whose delete endpoints reject a
 * second request while the first request is still in flight.
 */
export const requestOrContinueDelete = <
  Result,
  Value,
  RequestError,
  ReadError,
  RequestRequirements,
  ReadRequirements,
>(options: {
  readonly request: Effect.Effect<Result, RequestError, RequestRequirements>;
  readonly read: Effect.Effect<Value | undefined, ReadError, ReadRequirements>;
  readonly deleting: (value: Value) => boolean;
}): Effect.Effect<
  Result | undefined,
  RequestError | ReadError,
  RequestRequirements | ReadRequirements
> =>
  Effect.matchEffect(options.request, {
    onFailure: (requestError) =>
      options.read.pipe(
        Effect.flatMap((value) =>
          value === undefined || options.deleting(value)
            ? Effect.succeed(undefined)
            : Effect.fail(requestError),
        ),
      ),
    onSuccess: Effect.succeed,
  });
