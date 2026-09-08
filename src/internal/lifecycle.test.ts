import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { fromSdkError } from "../error.ts";
import {
  observeUntil,
  paginate,
  waitFor,
  waitForAbsent,
  waitUntilAccepted,
} from "./lifecycle.ts";

describe("lifecycle observation", () => {
  it("preserves the final observation when a bounded wait is exhausted", async () => {
    let observation = 0;
    const result = await Effect.runPromise(
      observeUntil({
        read: Effect.sync(() => ++observation),
        ready: (value) => value >= 4,
        wait: { attempts: 3, interval: 0 },
      }),
    );

    expect(result).toMatchObject({
      _tag: "Exhausted",
      value: 3,
      attempts: 3,
      intervalMs: 0,
    });
  });

  it("reports structured timeout context without discarding the last state", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        waitFor({
          service: "ACK",
          resourceType: "Alibaba.ACK.ManagedCluster",
          operation: "WaitClusterReady",
          read: Effect.succeed("Creating"),
          ready: (status) => status === "Running",
          describe: (status) => `status:${status}`,
          wait: { attempts: 2, interval: 0 },
        }),
      ),
    );

    expect(error).toMatchObject({
      _tag: "AlibabaWaitTimeoutError",
      service: "ACK",
      resourceType: "Alibaba.ACK.ManagedCluster",
      operation: "WaitClusterReady",
      attempts: 2,
      intervalMs: 0,
      lastObservation: "status:Creating",
    });
  });

  it("spends one attempt on a retryable read failure and then completes", async () => {
    let observation = 0;
    const result = await Effect.runPromise(
      observeUntil({
        read: Effect.suspend(() => {
          observation += 1;
          return observation <= 2
            ? Effect.fail(
                fromSdkError("VPC", "DescribeVpcs", {
                  code: "SafeRetryBudgetExceeded",
                  message: "budget",
                }),
              )
            : Effect.succeed(observation);
        }),
        ready: (value) => value >= 3,
        wait: { attempts: 10, interval: 0 },
      }),
    );

    expect(result).toMatchObject({ _tag: "Completed", value: 3 });
  });

  it("reports the read failure rather than a timeout when the budget expires", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        waitFor({
          service: "VPC",
          operation: "WaitVpcReady",
          read: Effect.fail(
            fromSdkError("VPC", "DescribeVpcs", {
              code: "Throttling",
              message: "slow down",
            }),
          ),
          ready: () => true,
          wait: { attempts: 3, interval: 0 },
        }),
      ),
    );

    expect(error).toMatchObject({
      _tag: "AlibabaProviderError",
      code: "Throttling",
    });
  });

  it("aborts on a read failure that repeating cannot resolve", async () => {
    let observation = 0;
    const error = await Effect.runPromise(
      Effect.flip(
        waitFor({
          service: "VPC",
          operation: "WaitVpcReady",
          read: Effect.suspend(() => {
            observation += 1;
            return Effect.fail(
              fromSdkError("VPC", "DescribeVpcs", {
                code: "Forbidden",
                message: "denied",
              }),
            );
          }),
          ready: () => true,
          wait: { attempts: 50, interval: 0 },
        }),
      ),
    );

    expect(error).toMatchObject({ _tag: "AlibabaProviderError", code: "Forbidden" });
    expect(observation).toBe(1);
  });

  it("never mistakes a failing read for an absent resource", async () => {
    // The dangerous direction: absorbing read errors must not let a destroy
    // waiter conclude the resource is gone. Only a *successful* read of
    // `undefined` proves absence.
    let observation = 0;
    const error = await Effect.runPromise(
      Effect.flip(
        waitForAbsent({
          service: "Tair",
          resourceType: "Alibaba.Tair.Instance",
          operation: "DestroyInstance",
          read: Effect.suspend(() => {
            observation += 1;
            return Effect.fail(
              fromSdkError("Tair", "DescribeInstanceAttribute", {
                code: "SafeRetryBudgetExceeded",
                message: "budget",
              }),
            );
          }),
          wait: { attempts: 4, interval: 0 },
        }),
      ),
    );

    // Every attempt was spent, and the outcome is a failure — not a silent
    // "absent" that would drop the state row and strand the instance.
    expect(observation).toBe(4);
    expect(error).toMatchObject({
      _tag: "AlibabaProviderError",
      code: "SafeRetryBudgetExceeded",
    });
  });
});

describe("waitUntilAccepted", () => {
  it("retries incorrect instance state and then returns the accepted result", async () => {
    let attempts = 0;
    const result = await Effect.runPromise(
      waitUntilAccepted({
        service: "Tair",
        operation: "ModifyInstanceSSL",
        wait: { attempts: 4, interval: 0 },
        retryIf: (error) => error.code === "IncorrectDBInstanceState",
        request: Effect.suspend(() => {
          attempts += 1;
          return attempts < 3
            ? Effect.fail(
                fromSdkError("Tair", "ModifyInstanceSSL", {
                  code: "IncorrectDBInstanceState",
                  message: "The instance is not ready",
                  statusCode: 400,
                }),
              )
            : Effect.succeed("accepted");
        }),
      }),
    );
    expect(result).toBe("accepted");
    expect(attempts).toBe(3);
  });

  it("preserves the last retryable provider error when the wait is exhausted", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        waitUntilAccepted({
          service: "Tair",
          operation: "ModifyInstanceSSL",
          wait: { attempts: 2, interval: 0 },
          retryIf: (error) => error.code === "IncorrectDBInstanceState",
          request: Effect.fail(
            fromSdkError("Tair", "ModifyInstanceSSL", {
              code: "IncorrectDBInstanceState",
              message: "The instance is not ready",
              requestId: "ssl-timeout",
              statusCode: 400,
            }),
          ),
        }),
      ),
    );
    expect(error._tag).toBe("AlibabaProviderError");
    if (error._tag !== "AlibabaProviderError") return;
    expect(error.code).toBe("IncorrectDBInstanceState");
    expect(error.requestId).toBe("ssl-timeout");
  });
});

describe("pagination", () => {
  it("fails closed when the page bound is reached without proving completion", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        paginate({
          service: "VPC",
          operation: "DescribeVpcs",
          pageSize: 2,
          maxPages: 2,
          page: () =>
            Effect.succeed({ items: ["a", "b"], totalCount: 5 }),
        }),
      ),
    );

    expect(error).toMatchObject({
      _tag: "AlibabaPaginationLimitError",
      service: "VPC",
      operation: "DescribeVpcs",
      pageSize: 2,
      maxPages: 2,
      observedItems: 4,
      reportedTotal: 5,
    });
  });

  it("uses a short page as completion only when the API reports no total", async () => {
    let pageNumber = 0;
    const items = await Effect.runPromise(
      paginate({
        service: "ACK",
        operation: "DescribeClustersV1",
        pageSize: 2,
        maxPages: 3,
        page: () => {
          pageNumber += 1;
          return Effect.succeed({
            items: pageNumber === 1 ? ["a", "b"] : ["c"],
          });
        },
      }),
    );

    expect(items).toEqual(["a", "b", "c"]);
    expect(pageNumber).toBe(2);
  });
});
