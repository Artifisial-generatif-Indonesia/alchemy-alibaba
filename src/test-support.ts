import ACRClient from "@alicloud/cr20181201";
import ACKClient from "@alicloud/cs20151215";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import TairClient from "@alicloud/r-kvstore20150101";
import RDSClient from "@alicloud/rds20140815";
import VPCClient from "@alicloud/vpc20160428";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AlibabaClientSet } from "./clients.ts";

export const testConfig = () =>
  new $OpenApiUtil.Config({
    accessKeyId: "test-access-key",
    accessKeySecret: "test-access-secret",
    regionId: "ap-southeast-5",
  });

export const testSession: ScopedPlanStatusSession = {
  emit: () => Effect.void,
  note: () => Effect.void,
  done: () => Effect.void,
};

export const alchemyTestRuntime = Layer.mergeAll(
  Layer.succeed(Stage, "test"),
  Layer.succeed(Stack, {
    name: "provider-tests",
    stage: "test",
    resources: {},
    bindings: {},
    actions: {},
  }),
);

export const testClientSet = (overrides: {
  readonly ack?: ACKClient;
  readonly acr?: ACRClient;
  readonly tair?: TairClient;
  readonly rds?: RDSClient;
  readonly vpc?: VPCClient;
}): AlibabaClientSet => ({
  ack: overrides.ack ?? new ACKClient(testConfig()),
  acr: overrides.acr ?? new ACRClient(testConfig()),
  tair: overrides.tair ?? new TairClient(testConfig()),
  rds: overrides.rds ?? new RDSClient(testConfig()),
  vpc: overrides.vpc ?? new VPCClient(testConfig()),
  regionId: "ap-southeast-5",
});

export const resourceBase = (id: string) => ({
  id,
  fqn: id,
  instanceId: `provider-test-${id}`,
  session: testSession,
  bindings: [],
});

/** Plans SDK-style connection failures without changing provider state. */
export class TestTransientFailures {
  readonly #remaining = new Map<string, number>();

  failNext(operation: string, times = 1): void {
    this.#remaining.set(operation, times);
  }

  throwIfPlanned(operation: string): void {
    const remaining = this.#remaining.get(operation) ?? 0;
    if (remaining === 0) return;
    if (remaining === 1) this.#remaining.delete(operation);
    else this.#remaining.set(operation, remaining - 1);
    throw Object.assign(
      new Error(
        `ConnectTimeout: Connect HTTPS://provider.example/${operation} failed`,
      ),
      { code: "ConnectTimeout" },
    );
  }
}
