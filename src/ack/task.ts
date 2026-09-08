import type ACKClient from "@alicloud/cs20151215";
import * as Effect from "effect/Effect";
import {
  AlibabaInvariantError,
  isNotFound,
  retryingSdkCall,
} from "../error.ts";
import { waitFor, type WaitOptions } from "../internal/lifecycle.ts";

export const waitForTask = (options: {
  readonly client: ACKClient;
  readonly operation: string;
  readonly taskId: string | undefined;
  readonly wait?: WaitOptions;
}) => {
  const taskId = options.taskId;
  if (taskId === undefined) return Effect.void;
  const read = retryingSdkCall("ACK", "DescribeTaskInfo", () =>
    options.client.describeTaskInfo(taskId),
  ).pipe(
    Effect.map((response) => response.body),
    Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
    Effect.flatMap((task) => {
      const state = task?.state?.toLowerCase();
      if (state !== "fail" && state !== "failed" && state !== "error") {
        return Effect.succeed(task);
      }
      // Task messages can contain echoed request data; retain only the code.
      const detail = "ACK asynchronous task failed";
      const rawCode = task?.error?.code;
      const code =
        rawCode !== undefined && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(rawCode)
          ? rawCode
          : undefined;
      return Effect.fail(
        new AlibabaInvariantError({
          resourceType: "Alibaba.ACK.Task",
          operation: options.operation,
          message: `${taskId}${code === undefined ? "" : ` (${code})`}: ${detail}`,
        }),
      );
    }),
  );
  return waitFor({
    service: "ACK",
    operation: options.operation,
    read,
    ready: (task) => task?.state?.toLowerCase() === "success",
    wait: options.wait,
  }).pipe(Effect.asVoid);
};
