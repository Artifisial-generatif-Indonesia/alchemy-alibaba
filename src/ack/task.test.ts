import ACKClient, * as ACK from "@alicloud/cs20151215";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { testConfig } from "../test-support.ts";
import { waitForTask } from "./task.ts";

class TaskACKClient extends ACKClient {
  reads = 0;

  constructor(
    private readonly states: readonly ACK.DescribeTaskInfoResponseBody[],
  ) {
    super(testConfig());
  }

  override async describeTaskInfo(
    _taskId: string,
  ): Promise<ACK.DescribeTaskInfoResponse> {
    const state = this.states[Math.min(this.reads, this.states.length - 1)];
    this.reads += 1;
    return new ACK.DescribeTaskInfoResponse({ statusCode: 200, body: state });
  }
}

describe("ACK asynchronous tasks", () => {
  it("waits until the task reports success", async () => {
    const client = new TaskACKClient([
      new ACK.DescribeTaskInfoResponseBody({ state: "running" }),
      new ACK.DescribeTaskInfoResponseBody({ state: "success" }),
    ]);

    await expect(
      Effect.runPromise(
        waitForTask({
          client,
          operation: "CreateCluster",
          taskId: "T-success",
          wait: { attempts: 2, interval: 0 },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(client.reads).toBe(2);
  });

  it("surfaces the task error without waiting for a timeout", async () => {
    const client = new TaskACKClient([
      new ACK.DescribeTaskInfoResponseBody({
        state: "fail",
        error: new ACK.DescribeTaskInfoResponseBodyError({
          code: "InvalidCIDR",
          message: "pod CIDR overlaps the VPC",
        }),
      }),
    ]);

    await expect(
      Effect.runPromise(
        waitForTask({
          client,
          operation: "CreateCluster",
          taskId: "T-failed",
          wait: { attempts: 2, interval: 0 },
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "AlibabaInvariantError",
      operation: "CreateCluster",
      message: "T-failed (InvalidCIDR): ACK asynchronous task failed",
    });
    expect(client.reads).toBe(1);
  });
});
