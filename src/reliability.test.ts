import * as ACK from "@alicloud/cs20151215";
import * as ACR from "@alicloud/cr20181201";
import * as RDS from "@alicloud/rds20140815";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { InstanceId } from "alchemy/InstanceId";
import { expect, it } from "vitest";
import { AlibabaClients, type AlibabaClientSet } from "./clients.ts";
import { alchemyTestRuntime, resourceBase } from "./test-support.ts";
import {
  Instance,
  InstanceProvider,
  type InstanceProps,
} from "./rds/instance.ts";
import { Account, AccountProvider } from "./rds/account.ts";
import {
  Account as TairAccount,
  AccountProvider as TairAccountProvider,
} from "./tair/account.ts";
import {
  Instance as Tair,
  InstanceProvider as TairProvider,
} from "./tair/instance.ts";
import { Namespace, NamespaceProvider } from "./acr/namespace.ts";
import { Network, NetworkProvider } from "./vpc/network.ts";
import { VSwitch, VSwitchProvider } from "./vpc/vswitch.ts";
import {
  ManagedCluster,
  ManagedClusterProvider,
} from "./ack/managed-cluster.ts";
import { NodePool, NodePoolProvider } from "./ack/node-pool.ts";
import { Addon, AddonProvider } from "./ack/addon.ts";
import { fromSdkError, isNotFound, isTransient } from "./error.ts";
const base = resourceBase("reliability");
const wait = { attempts: 4, interval: 0 };
const tags = {
  "alchemy::stack": "provider-tests",
  "alchemy::stage": "test",
  "alchemy::id": base.id,
};
const tagList = Object.entries(tags).map(([key, value]) => ({ key, value }));
const create: InstanceProps = {
  engine: "PostgreSQL",
  engineVersion: "16.0",
  DBInstanceClass: "test-class",
  DBInstanceNetType: "Intranet",
  DBInstanceStorage: 20,
  payType: "Serverless",
  securityIPList: "127.0.0.1",
};
// Every SDK operation must be supplied explicitly. Unexpected calls throw;
// these fakes cannot delegate to an SDK or make network requests.
const strictClient = (methods: Record<string, unknown>) =>
  new Proxy(methods, {
    get(target, key) {
      if (typeof key !== "string" || key in target)
        return target[key as string];
      throw new Error(`Unexpected SDK operation: ${key}`);
    },
  });
const run = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  provider: Layer.Layer<any, any, any>,
  methods: Record<string, Record<string, unknown>>,
) => {
  const clients = Object.fromEntries(
    ["rds", "tair", "vpc", "ack", "acr"].map((name) => [
      name,
      strictClient(methods[name] ?? {}),
    ]),
  );
  const layer = provider.pipe(
    Layer.provide(
      Layer.succeed(AlibabaClients, {
        ...clients,
        regionId: "ap-southeast-5",
      } as unknown as AlibabaClientSet),
    ),
  );
  return Effect.runPromise(
    program.pipe(
      Effect.provide(layer),
      Effect.provide(alchemyTestRuntime),
      Effect.provideService(InstanceId, "00112233445566778899aabbccddeeff"),
    ) as Effect.Effect<A, E>,
  );
};
const rdsFake = () => {
  let exists = true;
  let busyReads = 0;
  const state =
    new RDS.DescribeDBInstanceAttributeResponseBodyItemsDBInstanceAttribute({
      DBInstanceId: "rm-test",
      DBInstanceDescription: "test-db",
      DBInstanceStatus: "Running",
      deletionProtection: false,
      DBInstanceClass: "test-class",
      engineVersion: "16.0",
      DBInstanceStorage: 20,
      serverlessConfig: { scaleMin: 1, scaleMax: 4, autoPause: false },
    });
  let ssl = new RDS.DescribeDBInstanceSSLResponseBody({
    SSLEnabled: "on",
    CAType: "custom",
    serverCert: "old-certificate",
  });
  const specs: RDS.ModifyDBInstanceSpecRequest[] = [];
  const sslRequests: RDS.ModifyDBInstanceSSLRequest[] = [];
  const protectionTokens = new Set<string>();
  const calls: string[] = [];
  const methods = {
    describeDBInstances: async () => ({ body: { items: { DBInstance: [] } } }),
    describeDBInstanceAttribute: async () => {
      calls.push("read");
      const value =
        new RDS.DescribeDBInstanceAttributeResponseBodyItemsDBInstanceAttribute(
          {
            ...state,
            DBInstanceStatus: busyReads-- > 0 ? "Modifying" : "Running",
          },
        );
      return {
        body: { items: { DBInstanceAttribute: exists ? [value] : [] } },
      };
    },
    describeDBInstanceSSL: async () => ({ body: ssl }),
    describeDBInstanceNetInfo: async () => ({
      body: {
        DBInstanceNetInfos: {
          DBInstanceNetInfo: [
            {
              connectionStringType: "Normal",
              IPType: "Private",
              connectionString: "synthetic.local",
              IPAddress: "10.0.0.2",
              port: "5432",
            },
          ],
        },
      },
    }),
    listTagResources: async () => ({
      body: {
        tagResources: {
          tagResource: Object.entries(tags).map(([tagKey, tagValue]) => ({
            tagKey,
            tagValue,
          })),
        },
      },
    }),
    modifyDBInstanceSpec: async (request: RDS.ModifyDBInstanceSpecRequest) => {
      calls.push("spec");
      specs.push(request);
      busyReads = 1;
      state.DBInstanceStorage =
        request.DBInstanceStorage ?? state.DBInstanceStorage;
      if (request.serverlessConfiguration)
        state.serverlessConfig =
          new RDS.DescribeDBInstanceAttributeResponseBodyItemsDBInstanceAttributeServerlessConfig(
            {
              scaleMin: request.serverlessConfiguration.minCapacity,
              scaleMax: request.serverlessConfiguration.maxCapacity,
              autoPause: request.serverlessConfiguration.autoPause,
            },
          );
      return {};
    },
    modifyDBInstanceSSL: async (request: RDS.ModifyDBInstanceSSLRequest) => {
      if (busyReads >= 0)
        throw Object.assign(new Error("Busy"), {
          code: "IncorrectDBInstanceState",
        });
      calls.push("ssl");
      sslRequests.push(request);
      ssl = new RDS.DescribeDBInstanceSSLResponseBody({
        ...ssl,
        ...request,
        SSLEnabled: request.SSLEnabled === 0 ? "off" : "on",
      });
      return {};
    },
    modifyDBInstanceDeletionProtection: async (
      request: RDS.ModifyDBInstanceDeletionProtectionRequest,
    ) => {
      if (
        request.clientToken === undefined ||
        !protectionTokens.has(request.clientToken)
      )
        state.deletionProtection = request.deletionProtection;
      if (request.clientToken) protectionTokens.add(request.clientToken);
      return {};
    },
    deleteDBInstance: async () => {
      exists = false;
      return {};
    },
  };
  return { state, specs, sslRequests, calls, methods };
};
it("rejects batch purchases before calling any SDK method", async () => {
  await expect(
    run(
      Effect.gen(function* () {
        const provider = yield* Instance.Provider;
        return yield* provider.reconcile({
          ...base,
          olds: undefined,
          output: undefined,
          news: {
            name: "test-db",
            ...create,
            amount: 2,
          } as unknown as InstanceProps,
        });
      }),
      InstanceProvider({ wait }),
      {},
    ),
  ).rejects.toMatchObject({
    _tag: "AlibabaInvariantError",
    operation: "CreateDBInstance",
  });
});
it("looks up RDS by region across every fuzzy-search page", async () => {
  const fake = rdsFake();
  const pages: number[] = [];
  const result = await run(
    Effect.gen(function* () {
      const provider = yield* Instance.Provider;
      return yield* provider.read!({
        ...base,
        olds: { name: "test-db", ...create },
        output: undefined,
      });
    }),
    InstanceProvider({ wait }),
    {
      rds: {
        ...fake.methods,
        describeDBInstances: async (
          request: RDS.DescribeDBInstancesRequest,
        ) => {
          expect(request.regionId).toBe("ap-southeast-5");
          pages.push(request.pageNumber!);
          return {
            body: {
              totalRecordCount: 51,
              items: {
                DBInstance:
                  request.pageNumber === 1
                    ? Array.from({ length: 50 }, (_, i) => ({
                        DBInstanceId: `rm-${i}`,
                        DBInstanceDescription: `test-db-${i}`,
                      }))
                    : [
                        {
                          DBInstanceId: "rm-test",
                          DBInstanceDescription: "test-db",
                        },
                      ],
              },
            },
          };
        },
      },
    },
  );
  expect(pages).toEqual([1, 2]);
  expect(result).toMatchObject({ instanceId: "rm-test" });
});
it("rotates SSL material after spec convergence and does not mutate on reapply", async () => {
  const fake = rdsFake();
  const olds: InstanceProps = {
    name: "test-db",
    ...create,
    ssl: { SSLEnabled: 1, CAType: "custom", serverCert: "old-certificate" },
    sslServerKey: Redacted.make("old-synthetic-key"),
  };
  const news: InstanceProps = {
    ...olds,
    serverlessConfig: {
      minCapacity: 2,
      maxCapacity: 8,
      autoPause: true,
    },
    ssl: { ...olds.ssl, serverCert: "new-certificate" },
    sslServerKey: Redacted.make("new-synthetic-key"),
  };
  await run(
    Effect.gen(function* () {
      const provider = yield* Instance.Provider;
      const output = yield* provider.reconcile({
        ...base,
        olds,
        news,
        output: { instanceId: "rm-test", name: "test-db" } as any,
      });
      yield* provider.reconcile({ ...base, olds: news, news, output });
    }),
    InstanceProvider({ wait }),
    { rds: fake.methods },
  );
  expect(fake.specs).toHaveLength(1);
  expect(fake.sslRequests).toHaveLength(1);
  expect(fake.sslRequests[0]?.serverKey).toBe("new-synthetic-key");
  expect(fake.state.serverlessConfig).toMatchObject({
    scaleMin: 2,
    scaleMax: 8,
    autoPause: true,
  });
  expect(fake.calls.indexOf("ssl")).toBeGreaterThan(
    fake.calls.indexOf("spec") + 1,
  );
});
it("can enable, disable, and re-enable RDS protection with an idempotency cache", async () => {
  const fake = rdsFake();
  await run(
    Effect.gen(function* () {
      const provider = yield* Instance.Provider;
      let output: any = { instanceId: "rm-test", name: "test-db" };
      for (const deletionProtection of [true, false, true]) {
        output = yield* provider.reconcile({
          ...base,
          olds: { name: "test-db", ...create },
          news: { name: "test-db", ...create, deletionProtection },
          output,
        });
        expect(fake.state.deletionProtection).toBe(deletionProtection);
      }
    }),
    InstanceProvider({ wait }),
    { rds: fake.methods },
  );
});
it.each(["RDS", "Tair", "ACK"])(
  "rejects mismatched %s regions before observing or mutating",
  async (service) => {
    const resource =
      service === "RDS" ? Instance : service === "Tair" ? Tair : ManagedCluster;
    const layer =
      service === "RDS"
        ? InstanceProvider({ wait })
        : service === "Tair"
          ? TairProvider({ wait })
          : ManagedClusterProvider({ wait });
    await expect(
      run(
        Effect.gen(function* () {
          const provider = yield* resource.Provider;
          return yield* provider.read!({
            ...base,
            olds: { name: "test", regionId: "cn-hangzhou" },
            output: undefined,
          } as any);
        }),
        layer,
        {},
      ),
    ).rejects.toMatchObject({
      _tag: "AlibabaInvariantError",
      operation: "ValidateRegion",
    });
  },
);
it.each([
  "RequiredParam.NotFound",
  "InvalidRegionId.NotFound",
  "InvalidClusterKms",
  "Error",
])("keeps %s failures out of the absence path", async (code) => {
  const error = fromSdkError("VPC", "DescribeVpcs", {
    code,
    statusCode: 404,
    message: "roleArn does not exist",
  });
  expect(isNotFound(error)).toBe(false);
  await expect(
    run(
      Effect.gen(function* () {
        const provider = yield* Network.Provider;
        yield* provider.delete({
          ...base,
          olds: { cidrBlock: "10.0.0.0/16" },
          output: { vpcId: "vpc-test" } as any,
        });
      }),
      NetworkProvider({ wait }),
      {
        vpc: {
          describeVpcs: async () => {
            throw error;
          },
        },
      },
    ),
  ).rejects.toMatchObject({ _tag: "AlibabaProviderError" });
});
it("does not serialize SDK message secrets and still recognizes transport failures", () => {
  const error = fromSdkError("RDS", "CreateDBInstance", {
    code: "ReadTimeout",
    message: "Password=synthetic-sensitive-value",
    requestId: "request-test",
  });
  expect(JSON.stringify(error)).not.toContain("synthetic-sensitive-value");
  expect(isTransient(error)).toBe(true);
  expect(error.requestId).toBe("request-test");
});
it.each(["RDS", "Tair"])(
  "generates valid %s account names and preserves persisted names",
  async (service) => {
    const resource = service === "RDS" ? Account : TairAccount;
    const layer =
      service === "RDS"
        ? AccountProvider({ wait })
        : TairAccountProvider({ wait });
    const names: string[] = [];
    await run(
      Effect.gen(function* () {
        const provider = yield* resource.Provider;
        yield* provider.read!({
          ...base,
          olds: {
            instanceId: "instance-test",
            password: Redacted.make("synthetic-password"),
          },
          output: undefined,
        });
        yield* provider.read!({
          ...base,
          olds: {
            instanceId: "instance-test",
            password: Redacted.make("synthetic-password"),
          },
          output: {
            instanceId: "instance-test",
            name: "persisted_name",
          } as any,
        });
      }),
      layer,
      {
        [service === "RDS" ? "rds" : "tair"]: {
          describeAccounts: async (request: { accountName: string }) => {
            names.push(request.accountName);
            return { body: { accounts: {} } };
          },
        },
      },
    );
    expect(names[0]).toMatch(/^[a-z][a-z0-9_]*[a-z0-9]$/);
    expect(names[0]!.length).toBeLessThanOrEqual(service === "RDS" ? 16 : 100);
    expect(names[1]).toBe("persisted_name");
  },
);
it("does not replace an account when Normal becomes explicit", async () => {
  const olds = {
    instanceId: "rm-test",
    name: "app",
    password: Redacted.make("synthetic-password"),
  };
  expect(
    await run(
      Effect.gen(function* () {
        const provider = yield* Account.Provider;
        return yield* provider.diff!({
          ...base,
          olds,
          news: { ...olds, settings: { accountType: "Normal" } },
        } as any);
      }),
      AccountProvider({ wait }),
      {},
    ),
  ).toBeUndefined();
});
it("deletes a Pending vSwitch after it becomes Available", async () => {
  let reads = 0;
  let deletes = 0;
  await run(
    Effect.gen(function* () {
      const provider = yield* VSwitch.Provider;
      yield* provider.delete({
        ...base,
        olds: {} as any,
        output: { vSwitchId: "vsw-test" } as any,
      });
    }),
    VSwitchProvider({ wait, deleteDependencyWait: wait }),
    {
      vpc: {
        describeVSwitchAttributes: async () => ({
          body: deletes
            ? undefined
            : {
                vSwitchId: "vsw-test",
                status: ++reads === 1 ? "Pending" : "Available",
              },
        }),
        deleteVSwitch: async () => {
          deletes++;
          return {};
        },
      },
    },
  );
  expect(deletes).toBe(1);
});
it("accepts equivalent ACR SDK configuration without updating", async () => {
  const config = {
    repoType: "PRIVATE",
    tagImmutability: true,
    artifactBuildRuleParameters: { imageIndexOnly: true },
  };
  await run(
    Effect.gen(function* () {
      const provider = yield* Namespace.Provider;
      yield* provider.reconcile({
        ...base,
        olds: undefined,
        output: undefined,
        news: {
          instanceId: "cri-test",
          name: "test",
          settings: { defaultRepoConfiguration: config },
        },
      });
    }),
    NamespaceProvider({ wait }),
    {
      acr: {
        getNamespace: async () => ({
          body: new ACR.GetNamespaceResponseBody({
            isSuccess: true,
            namespaceStatus: "NORMAL",
            namespaceName: "test",
            defaultRepoConfiguration: new ACR.RepoConfiguration(config),
          }),
        }),
      },
    },
  );
});
it("repairs ACK cluster-spec drift with unchanged desired inputs", async () => {
  const state = new ACK.DescribeClusterDetailResponseBody({
    clusterId: "c-test",
    name: "test",
    state: "running",
    clusterSpec: "ack.standard",
    tags: tagList,
  });
  let mutations = 0;
  const props = {
    name: "test",
    addons: [{ name: "flannel" }],
    containerCidr: "10.1.0.0/16",
    clusterSpec: "ack.pro.small",
  };
  await run(
    Effect.gen(function* () {
      const provider = yield* ManagedCluster.Provider;
      yield* provider.reconcile({
        ...base,
        olds: props,
        news: props,
        output: { clusterId: "c-test", name: "test" },
      } as any);
    }),
    ManagedClusterProvider({ wait }),
    {
      ack: {
        describeClusterDetail: async () => ({ body: state }),
        modifyCluster: async (
          requestId: string,
          request: ACK.ModifyClusterRequest,
        ) => {
          mutations++;
          state.clusterSpec = request.clusterSpec;
          return {};
        },
      },
    },
  );
  expect(mutations).toBe(1);
});
it("repairs node-pool image drift without changing desired size", async () => {
  const state = new ACK.DescribeClusterNodePoolDetailResponseBody({
    nodepoolInfo: { name: "test", nodepoolId: "np-test" },
    status: { state: "active" },
    scalingGroup: { desiredSize: 1, imageId: "drifted-image", tags: tagList },
  });
  const props = {
    clusterId: "c-test",
    name: "test",
    scalingGroup: { imageId: "desired-image" },
  };
  let mutations = 0;
  await run(
    Effect.gen(function* () {
      const provider = yield* NodePool.Provider;
      yield* provider.reconcile({
        ...base,
        olds: props,
        news: props,
        output: { nodepoolId: "np-test", name: "test" },
      } as any);
    }),
    NodePoolProvider({ wait }),
    {
      ack: {
        describeClusterNodePoolDetail: async () => ({ body: state }),
        modifyClusterNodePool: async (
          _cluster: string,
          _pool: string,
          request: ACK.ModifyClusterNodePoolRequest,
        ) => {
          mutations++;
          state.scalingGroup!.imageId = request.scalingGroup?.imageId;
          return {};
        },
      },
    },
  );
  expect(mutations).toBe(1);
});
it.each([undefined, '{"a":1,"b":2}'])(
  "accepts addon default or equivalent JSON config (%s)",
  async (config) => {
    await run(
      Effect.gen(function* () {
        const provider = yield* Addon.Provider;
        yield* provider.reconcile({
          ...base,
          olds: undefined,
          output: undefined,
          news: { clusterId: "c-test", name: "test", version: "1.0", config },
        });
      }),
      AddonProvider({ wait }),
      {
        ack: {
          describeClusterAddonInstance: async () => ({
            body: {
              name: "test",
              state: "active",
              version: "1.0",
              config: '{ "b": 2, "a": 1 }',
            },
          }),
        },
      },
    );
  },
);
it("uses a fresh Tair token for a later return to the same size, including transient retries", async () => {
  const state = {
    instanceId: "r-test",
    instanceName: "test",
    instanceStatus: "Normal",
    instanceReleaseProtection: false,
    instanceClass: "small",
    tags: { tag: tagList },
  };
  const tokens: string[] = [];
  const cache = new Set<string>();
  const attempted = new Set<string>();
  await run(
    Effect.gen(function* () {
      const provider = yield* Tair.Provider;
      let output: any = { instanceId: "r-test", name: "test" };
      for (const instanceClass of ["medium", "large", "medium"]) {
        const news = { name: "test", instanceClass };
        output = yield* provider.reconcile({
          ...base,
          olds: undefined,
          news,
          output,
        });
        expect(state.instanceClass).toBe(instanceClass);
      }
    }),
    TairProvider({ wait }),
    {
      tair: {
        describeInstanceAttribute: async () => ({
          body: { instances: { DBInstanceAttribute: [state] } },
        }),
        describeInstanceSSL: async () => ({ body: { SSLEnabled: "Disable" } }),
        describeInstanceConfig: async () => ({ body: { config: "{}" } }),
        modifyInstanceSpec: async (request: {
          clientToken: string;
          instanceClass: string;
        }) => {
          tokens.push(request.clientToken);
          if (!attempted.has(request.clientToken)) {
            attempted.add(request.clientToken);
            throw Object.assign(new Error("Busy"), {
              code: "IncorrectDBInstanceState",
            });
          }
          if (!cache.has(request.clientToken))
            state.instanceClass = request.instanceClass;
          cache.add(request.clientToken);
          return {};
        },
      },
    },
  );
  expect(tokens).toHaveLength(6);
  expect(tokens[0]).toBe(tokens[1]);
  expect(tokens[4]).toBe(tokens[5]);
  expect(new Set(tokens).size).toBe(3);
});
it("refuses to delete historical RDS batch state as if it represented one instance", async () => {
  await expect(
    run(
      Effect.gen(function* () {
        const provider = yield* Instance.Provider;
        yield* provider.delete({
          ...base,
          olds: { ...create, amount: 2 },
          output: { instanceId: "rm-test" },
        } as any);
      }),
      InstanceProvider({ wait }),
      {},
    ),
  ).rejects.toMatchObject({ _tag: "AlibabaInvariantError" });
});
it("rejects a persisted region mismatch even when the new request matches the provider", async () => {
  await expect(
    run(
      Effect.gen(function* () {
        const provider = yield* Instance.Provider;
        yield* provider.reconcile({
          ...base,
          olds: undefined,
          news: { ...create, regionId: "ap-southeast-5" },
          output: { instanceId: "rm-test", regionId: "cn-hangzhou" },
        } as any);
      }),
      InstanceProvider({ wait }),
      {},
    ),
  ).rejects.toMatchObject({ operation: "ValidateRegion" });
});
it("rejects SSL secrets without configuration before calling the SDK", async () => {
  await expect(
    run(
      Effect.gen(function* () {
        const provider = yield* Instance.Provider;
        yield* provider.reconcile({
          ...base,
          olds: undefined,
          output: undefined,
          news: { ...create, sslServerKey: Redacted.make("synthetic-key") },
        });
      }),
      InstanceProvider({ wait }),
      {},
    ),
  ).rejects.toMatchObject({ operation: "ModifyDBInstanceSSL" });
});
it("leaves omitted namespace configuration fields unmanaged", async () => {
  await run(
    Effect.gen(function* () {
      const provider = yield* Namespace.Provider;
      yield* provider.reconcile({
        ...base,
        olds: undefined,
        output: undefined,
        news: {
          instanceId: "cri-test",
          name: "test",
          settings: { defaultRepoConfiguration: { tagImmutability: true } },
        },
      });
    }),
    NamespaceProvider({ wait }),
    {
      acr: {
        getNamespace: async () => ({
          body: new ACR.GetNamespaceResponseBody({
            isSuccess: true,
            namespaceStatus: "NORMAL",
            namespaceName: "test",
            defaultRepoConfiguration: new ACR.RepoConfiguration({
              repoType: "PRIVATE",
              tagImmutability: true,
            }),
          }),
        }),
      },
    },
  );
});
it.each(["network", "switch"])(
  "recovers a VPC %s from the second name-search page",
  async (kind) => {
    const pages: number[] = [];
    const page = (request: { pageNumber?: number; regionId?: string }) => {
      expect(request.regionId).toBe("ap-southeast-5");
      pages.push(request.pageNumber!);
      return request.pageNumber === 1
        ? Array.from({ length: 50 }, (_, i) => ({
            vpcId: `vpc-${i}`,
            vpcName: `other-${i}`,
            vSwitchId: `vsw-${i}`,
            vSwitchName: `other-${i}`,
          }))
        : [
            {
              vpcName: "test",
              vSwitchId: "vsw-test",
              vSwitchName: "test",
              vpcId: "vpc-test",
              cidrBlock: "10.0.0.0/24",
              zoneId: "ap-southeast-5a",
              tags: { tag: tagList },
            },
          ];
    };
    const result = await run(
      Effect.gen(function* () {
        const provider =
          kind === "network"
            ? yield* Network.Provider
            : yield* VSwitch.Provider;
        return yield* provider.read!({
          ...base,
          olds: { name: "test", vpcId: "vpc-test" },
          output: undefined,
        } as any);
      }),
      kind === "network"
        ? NetworkProvider({ wait })
        : VSwitchProvider({ wait }),
      {
        vpc: {
          describeVpcs: async (request: any) => ({
            body: { totalCount: 51, vpcs: { vpc: page(request) } },
          }),
          describeVSwitches: async (request: any) => ({
            body: { totalCount: 51, vSwitches: { vSwitch: page(request) } },
          }),
          describeVSwitchAttributes: async () => ({
            body: {
              vSwitchId: "vsw-test",
              vSwitchName: "test",
              vpcId: "vpc-test",
              cidrBlock: "10.0.0.0/24",
              zoneId: "ap-southeast-5a",
              tags: { tag: tagList },
            },
          }),
        },
      },
    );
    expect(pages).toEqual([1, 2]);
    expect(result).toBeDefined();
  },
);
it("does not repeat an RDS resize that converged before state was persisted", async () => {
  const fake = rdsFake();
  await run(
    Effect.gen(function* () {
      const provider = yield* Instance.Provider;
      const olds = { name: "test-db", ...create, DBInstanceStorage: 10 };
      const news = { ...olds, DBInstanceStorage: 20 };
      yield* provider.reconcile({
        ...base,
        olds,
        news,
        output: { instanceId: "rm-test", name: "test-db" },
      } as any);
    }),
    InstanceProvider({ wait }),
    { rds: fake.methods },
  );
  expect(fake.specs).toHaveLength(0);
});
