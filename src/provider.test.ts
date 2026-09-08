import ACRClient, * as ACR from "@alicloud/cr20181201";
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
import * as Ref from "effect/Ref";
import { describe, expect, it } from "vitest";
import { Namespace, NamespaceProvider } from "./acr/namespace.ts";
import {
  ALIBABA_DEFAULT_CONNECT_TIMEOUT_MS,
  ALIBABA_DEFAULT_READ_TIMEOUT_MS,
  ALIBABA_RDS_DEFAULT_READ_TIMEOUT_MS,
  AlibabaClients,
  type AlibabaClientSet,
  makeClients,
} from "./clients.ts";
import {
  acrSdkCall,
  ALIBABA_SAFE_RETRY_BUDGET_MS,
  AlibabaWaitTimeoutError,
  fromSdkError,
  isAmbiguousCreate,
  isNotFound,
  isTransient,
  retryingAcrSdkCall,
  retryingSdkCall,
} from "./error.ts";
import { waitFor, waitForPresent } from "./internal/lifecycle.ts";
import { Providers, resourceProviders } from "./providers.ts";

const config = () =>
  new $OpenApiUtil.Config({
    accessKeyId: "test-access-key",
    accessKeySecret: "test-access-secret",
    regionId: "ap-southeast-5",
  });

class FakeACRClient extends ACRClient {
  namespace: ACR.GetNamespaceResponseBody | undefined;
  creates = 0;
  updates = 0;
  deletes = 0;

  constructor() {
    super(config());
  }

  override async getNamespace(
    request: ACR.GetNamespaceRequest,
  ): Promise<ACR.GetNamespaceResponse> {
    if (
      this.namespace === undefined ||
      this.namespace.instanceId !== request.instanceId ||
      this.namespace.namespaceName !== request.namespaceName
    ) {
      return new ACR.GetNamespaceResponse({ statusCode: 404 });
    }
    return new ACR.GetNamespaceResponse({
      statusCode: 200,
      body: this.namespace,
    });
  }

  override async createNamespace(
    request: ACR.CreateNamespaceRequest,
  ): Promise<ACR.CreateNamespaceResponse> {
    this.creates += 1;
    this.namespace = new ACR.GetNamespaceResponseBody({
      instanceId: request.instanceId,
      namespaceId: "crn-test",
      namespaceName: request.namespaceName,
      namespaceStatus: "NORMAL",
      autoCreateRepo: request.autoCreateRepo,
      defaultRepoType: request.defaultRepoType,
      defaultRepoConfiguration: request.defaultRepoConfiguration,
    });
    return new ACR.CreateNamespaceResponse({ statusCode: 200 });
  }

  override async updateNamespace(
    request: ACR.UpdateNamespaceRequest,
  ): Promise<ACR.UpdateNamespaceResponse> {
    this.updates += 1;
    this.namespace = new ACR.GetNamespaceResponseBody({
      ...this.namespace,
      instanceId: request.instanceId,
      namespaceName: request.namespaceName,
      autoCreateRepo: request.autoCreateRepo,
      defaultRepoType: request.defaultRepoType,
      defaultRepoConfiguration: request.defaultRepoConfiguration,
    });
    return new ACR.UpdateNamespaceResponse({ statusCode: 200 });
  }

  override async deleteNamespace(
    _request: ACR.DeleteNamespaceRequest,
  ): Promise<ACR.DeleteNamespaceResponse> {
    this.deletes += 1;
    this.namespace = undefined;
    return new ACR.DeleteNamespaceResponse({ statusCode: 200 });
  }
}

const session: ScopedPlanStatusSession = {
  emit: () => Effect.void,
  note: () => Effect.void,
  done: () => Effect.void,
};

const alchemyRuntime = Layer.mergeAll(
  Layer.succeed(Stage, "test"),
  Layer.succeed(Stack, {
    name: "provider-tests",
    stage: "test",
    resources: {},
    bindings: {},
    actions: {},
  }),
);

const clientSet = (acr: ACRClient): AlibabaClientSet => ({
  ack: new ACKClient(config()),
  acr,
  tair: new TairClient(config()),
  rds: new RDSClient(config()),
  vpc: new VPCClient(config()),
  regionId: "ap-southeast-5",
});

describe("Alibaba Alchemy provider", () => {
  it("registers every supported resource provider", async () => {
    const fake = new FakeACRClient();
    const program = Effect.gen(function* () {
      const collection = yield* Providers;
      return Object.keys(collection.providers).sort();
    }).pipe(
      Effect.provide(
        resourceProviders({ wait: { attempts: 1, interval: 0 } }).pipe(
          Layer.provide(Layer.succeed(AlibabaClients, clientSet(fake))),
        ),
      ),
      Effect.provide(alchemyRuntime),
    );

    await expect(Effect.runPromise(program)).resolves.toEqual([
      "Alibaba.ACK.Addon",
      "Alibaba.ACK.ManagedCluster",
      "Alibaba.ACK.NodePool",
      "Alibaba.ACR.EndpointAclEntry",
      "Alibaba.ACR.InstanceReference",
      "Alibaba.ACR.Namespace",
      "Alibaba.ACR.Repository",
      "Alibaba.ACR.VpcEndpointLink",
      "Alibaba.RDS.Account",
      "Alibaba.RDS.AccountPrivilege",
      "Alibaba.RDS.Database",
      "Alibaba.RDS.Instance",
      "Alibaba.RDS.SecurityIpGroup",
      "Alibaba.Tair.Account",
      "Alibaba.Tair.Instance",
      "Alibaba.Tair.SecurityIpGroup",
      "Alibaba.VPC.Network",
      "Alibaba.VPC.VSwitch",
    ]);
  });

  it("creates, observes, updates, and deletes an ACR namespace idempotently", async () => {
    const fake = new FakeACRClient();
    const layer = NamespaceProvider().pipe(
      Layer.provide(Layer.succeed(AlibabaClients, clientSet(fake))),
    );
    const base = {
      id: "images",
      fqn: "images",
      instanceId: "alchemy-instance",
      session,
      bindings: [],
    };
    const initial = {
      instanceId: "cri-test",
      name: "example",
      settings: { autoCreateRepo: false, defaultRepoType: "PRIVATE" },
    };

    const program = Effect.gen(function* () {
      const provider = yield* Namespace.Provider;
      const created = yield* provider.reconcile({
        ...base,
        news: initial,
        olds: undefined,
        output: undefined,
      });
      const unchanged = yield* provider.reconcile({
        ...base,
        news: initial,
        olds: initial,
        output: created,
      });
      const changed = {
        ...initial,
        settings: { autoCreateRepo: true, defaultRepoType: "PRIVATE" },
      };
      const updated = yield* provider.reconcile({
        ...base,
        news: changed,
        olds: initial,
        output: unchanged,
      });
      yield* provider.delete({
        ...base,
        olds: changed,
        output: updated,
      });
      return { created, unchanged, updated };
    }).pipe(Effect.provide(layer), Effect.provide(alchemyRuntime));

    const result = await Effect.runPromise(program);
    expect(result.created.name).toBe("example");
    expect(result.unchanged.autoCreateRepo).toBe(false);
    expect(result.updated.autoCreateRepo).toBe(true);
    expect(fake.creates).toBe(1);
    expect(fake.updates).toBe(1);
    expect(fake.deletes).toBe(1);
  });

  it("normalizes SDK failures without leaking request inputs", () => {
    const error = fromSdkError("RDS", "DescribeDBInstances", {
      code: "Throttling",
      message: "slow down",
      statusCode: 429,
      requestId: "request-1",
      accessKeySecret: "must-not-appear",
    });
    expect(error.service).toBe("RDS");
    expect(error.requestId).toBe("request-1");
    expect(isTransient(error)).toBe(true);
    expect(JSON.stringify(error)).not.toContain("must-not-appear");
    expect(
      isNotFound(
        fromSdkError("ACK", "DescribeCluster", {
          code: "Cluster.NotFound",
          message: "not found",
          statusCode: 404,
        }),
      ),
    ).toBe(true);
    expect(
      isTransient(
        fromSdkError("VPC", "DescribeVpcs", {
          code: "ConnectTimeout",
          message: "ConnectTimeout: Connect HTTPS://vpc.example failed",
        }),
      ),
    ).toBe(true);
    expect(
      isTransient(
        fromSdkError("RDS", "DescribeDBInstances", {
          message: "lookup rds.example: i/o timeout",
        }),
      ),
    ).toBe(true);
    expect(
      isTransient(
        fromSdkError("RDS", "DescribeDBInstances", {
          code: "InvalidParameter",
          message: "invalid page size",
          statusCode: 400,
        }),
      ),
    ).toBe(false);
  });

  it("bounds every generated client with explicit SDK timeouts", () => {
    const defaults = makeClients({ regionId: "ap-southeast-5" });
    const overrides = makeClients({
      regionId: "ap-southeast-5",
      connectTimeout: 1_234,
      readTimeout: 5_678,
    });
    const timeoutValues = (client: unknown) =>
      client as { _connectTimeout: number; _readTimeout: number };

    for (const client of [
      defaults.ack,
      defaults.acr,
      defaults.tair,
      defaults.vpc,
    ]) {
      expect(timeoutValues(client)).toMatchObject({
        _connectTimeout: ALIBABA_DEFAULT_CONNECT_TIMEOUT_MS,
        _readTimeout: ALIBABA_DEFAULT_READ_TIMEOUT_MS,
      });
    }
    expect(timeoutValues(defaults.rds)).toMatchObject({
      _connectTimeout: ALIBABA_DEFAULT_CONNECT_TIMEOUT_MS,
      _readTimeout: ALIBABA_RDS_DEFAULT_READ_TIMEOUT_MS,
    });
    expect(timeoutValues(overrides.vpc)).toMatchObject({
      _connectTimeout: 1_234,
      _readTimeout: 5_678,
    });
    expect(timeoutValues(overrides.rds)).toMatchObject({
      _connectTimeout: 1_234,
      _readTimeout: 5_678,
    });
  });

  it("classifies documented vSwitch task contention as transient", () => {
    expect(
      isTransient(
        fromSdkError("VPC", "CreateVSwitch", {
          code: "TaskConflict",
          message: "The operation is too frequent, TaskConflict.",
          statusCode: 400,
        }),
      ),
    ).toBe(true);
    expect(
      isTransient(
        fromSdkError("VPC", "CreateVSwitch", {
          code: "IncorrectVSwitchStatus",
          message: "VSwitch creation simultaneously is not supported.",
          statusCode: 400,
        }),
      ),
    ).toBe(true);
  });

  it("does not treat Tair lock responses as generic transients", () => {
    const lock = fromSdkError("Tair", "CreateInstance", {
      code: "CanNotAcquireLock",
      message: "Can't acquire lock for this operation.",
      statusCode: 400,
    });
    expect(isTransient(lock)).toBe(false);
    expect(isAmbiguousCreate(lock)).toBe(true);
  });

  it("retries a transient connection timeout and then returns the result", async () => {
    let attempts = 0;
    const result = await Effect.runPromise(
      retryingSdkCall("VPC", "DescribeVpcs", async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(
            new Error("ConnectTimeout: Connect HTTPS://vpc.example failed"),
            { code: "ConnectTimeout" },
          );
        }
        return "available";
      }),
    );

    expect(result).toBe("available");
    expect(attempts).toBe(2);
  });

  it("bounds the whole safe retry sequence by wall-clock time", async () => {
    const startedAt = Date.now();
    const error = await Effect.runPromise(
      Effect.flip(
        retryingSdkCall(
          "VPC",
          "DescribeVpcs",
          () => new Promise<never>(() => undefined),
          { budget: 25 },
        ),
      ),
    );

    expect(ALIBABA_SAFE_RETRY_BUDGET_MS).toBe(60_000);
    expect(error).toMatchObject({
      _tag: "AlibabaProviderError",
      service: "VPC",
      operation: "DescribeVpcs",
      code: "SafeRetryBudgetExceeded",
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("retries a transient ACR delete and validates the response envelope", async () => {
    let attempts = 0;
    const result = await Effect.runPromise(
      retryingAcrSdkCall("DeleteRepository", async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("ConnectTimeout while deleting"), {
            code: "ConnectTimeout",
          });
        }
        return new ACR.DeleteRepositoryResponse({
          statusCode: 200,
          body: new ACR.DeleteRepositoryResponseBody({
            isSuccess: true,
            code: "success",
          }),
        });
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(attempts).toBe(2);
  });

  it("preserves the SDK retry-after value in milliseconds", () => {
    const error = fromSdkError("ACR", "GetInstance", {
      code: "Throttling",
      message: "slow down",
      statusCode: 429,
      retryAfter: 1_500,
    });
    expect(error.retryAfterMs).toBe(1_500);
  });

  it("fails typed when ACR returns an unsuccessful HTTP 200 envelope", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        acrSdkCall("CreateNamespace", async () => ({
          statusCode: 200,
          body: {
            isSuccess: false,
            code: "NAMESPACE_NOT_EXIST",
            requestId: "request-acr-1",
          },
        })),
      ),
    );
    expect(error).toMatchObject({
      service: "ACR",
      operation: "CreateNamespace",
      code: "NAMESPACE_NOT_EXIST",
      requestId: "request-acr-1",
    });
    expect(isNotFound(error)).toBe(true);
  });

  it("fails typed when ACR omits IsSuccess on an HTTP 200 error", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        acrSdkCall("GetRepository", async () => ({
          statusCode: 200,
          body: {
            code: "REPO_NOT_EXIST",
            requestId: "request-acr-2",
          },
        })),
      ),
    );
    expect(error).toMatchObject({
      service: "ACR",
      operation: "GetRepository",
      code: "REPO_NOT_EXIST",
      requestId: "request-acr-2",
    });
    expect(isNotFound(error)).toBe(true);
  });

  it("fails bounded waiters with structured timeout context", async () => {
    const result = await Effect.runPromise(
      Effect.flip(
        waitFor({
          service: "Tair",
          operation: "test-wait",
          read: Effect.succeed("Creating"),
          ready: (state) => state === "Normal",
          wait: { attempts: 2, interval: 0 },
        }),
      ),
    );
    expect(result).toBeInstanceOf(AlibabaWaitTimeoutError);
    expect(result.operation).toBe("test-wait");
    expect(result).toMatchObject({
      attempts: 2,
      intervalMs: 0,
      lastObservation: "not-ready",
    });
  });

  it("polls through an eventually-consistent not-found window", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const observations = yield* Ref.make(0);
        return yield* waitForPresent({
          service: "ACK",
          operation: "eventual-read",
          read: Ref.updateAndGet(observations, (count) => count + 1).pipe(
            Effect.map((count) => (count < 3 ? undefined : "Running")),
          ),
          ready: (state) => state === "Running",
          wait: { attempts: 3, interval: 0 },
        });
      }),
    );
    expect(result).toBe("Running");
  });
});
