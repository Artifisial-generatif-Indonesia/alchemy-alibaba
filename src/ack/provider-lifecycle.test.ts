import ACKClient, * as ACK from "@alicloud/cs20151215";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { AlibabaClients } from "../clients.ts";
import {
  alchemyTestRuntime,
  resourceBase,
  testClientSet,
  testConfig,
  TestTransientFailures,
} from "../test-support.ts";
import { Addon, AddonProvider } from "./addon.ts";
import { ManagedCluster, ManagedClusterProvider } from "./managed-cluster.ts";
import { NodePool, NodePoolProvider } from "./node-pool.ts";

class StatefulACKClient extends ACKClient {
  readonly transientFailures = new TestTransientFailures();
  cluster: ACK.DescribeClusterDetailResponseBody | undefined;
  nodePool: ACK.DescribeClusterNodePoolDetailResponseBody | undefined;
  addon: ACK.DescribeClusterAddonInstanceResponseBody | undefined;
  clusterCreates = 0;
  clusterModifies = 0;
  clusterUpgrades = 0;
  clusterDeletes = 0;
  clusterReadsUntilAbsent = 0;
  nodePoolCreates = 0;
  nodePoolReads = 0;
  nodePoolModifies = 0;
  nodePoolDeletes = 0;
  nodePoolReadsUntilAbsent = 0;
  addonInstalls = 0;
  addonUpgrades = 0;
  addonModifies = 0;
  addonUninstalls = 0;
  addonReadsUntilAbsent = 0;

  constructor() {
    super(testConfig());
  }

  override async describeClusterDetail(
    clusterId: string,
  ): Promise<ACK.DescribeClusterDetailResponse> {
    const cluster = this.cluster?.clusterId === clusterId
      ? this.cluster
      : undefined;
    if (cluster !== undefined && this.clusterReadsUntilAbsent > 0) {
      this.clusterReadsUntilAbsent -= 1;
      if (this.clusterReadsUntilAbsent === 0) this.cluster = undefined;
    }
    return cluster !== undefined
      ? new ACK.DescribeClusterDetailResponse({
          statusCode: 200,
          body: cluster,
        })
      : new ACK.DescribeClusterDetailResponse({ statusCode: 404 });
  }

  /**
   * Region-scoped, paginated cluster inventory.
   *
   * `decoyClusters` pad earlier pages so a name match on a later page is only
   * found if the provider actually paginates. Clusters in other regions are
   * modelled by `describeClusters` (v0) below, which this API never returns.
   */
  decoyClusters: { clusterId: string; name: string }[] = [];
  otherRegionClusters: { clusterId: string; name: string }[] = [];
  clusterListRequests: ACK.DescribeClustersV1Request[] = [];

  /**
   * The deprecated inventory API: no `regionId`, no pagination, so it answers
   * with every cluster on the account including other regions. The provider
   * must never call it — reaching here means a same-named cluster in another
   * region could be adopted and ultimately deleted.
   */
  override async describeClusters(
    _request: ACK.DescribeClustersRequest,
  ): Promise<ACK.DescribeClustersResponse> {
    throw new Error(
      "describeClusters (v0) is account-wide and must not be used; " +
        `it would have returned ${JSON.stringify(this.otherRegionClusters)}`,
    );
  }

  override async describeClustersV1(
    request: ACK.DescribeClustersV1Request,
  ): Promise<ACK.DescribeClustersV1Response> {
    this.clusterListRequests.push(request);
    if (request.regionId !== "ap-southeast-5") {
      throw Object.assign(new Error("regionId is required"), {
        code: "MissingParameter",
        statusCode: 400,
      });
    }
    const all = [
      ...this.decoyClusters.map(
        (cluster) =>
          new ACK.DescribeClustersV1ResponseBodyClusters({
            clusterId: cluster.clusterId,
            name: cluster.name,
            state: "running",
          }),
      ),
      ...(this.cluster === undefined
        ? []
        : [
            new ACK.DescribeClustersV1ResponseBodyClusters({
              clusterId: this.cluster.clusterId,
              name: this.cluster.name,
              state: this.cluster.state,
            }),
          ]),
    ];
    // `name` is a server-side fuzzy (substring) match, mirroring Alibaba.
    const matched =
      request.name === undefined
        ? all
        : all.filter((cluster) => cluster.name?.includes(request.name!));
    const pageSize = request.pageSize ?? 50;
    const pageNumber = request.pageNumber ?? 1;
    const start = (pageNumber - 1) * pageSize;
    return new ACK.DescribeClustersV1Response({
      statusCode: 200,
      body: new ACK.DescribeClustersV1ResponseBody({
        clusters: matched.slice(start, start + pageSize),
        pageInfo: new ACK.DescribeClustersV1ResponseBodyPageInfo({
          pageNumber,
          pageSize,
          totalCount: matched.length,
        }),
      }),
    });
  }

  override async createCluster(
    request: ACK.CreateClusterRequest,
  ): Promise<ACK.CreateClusterResponse> {
    this.clusterCreates += 1;
    this.cluster = new ACK.DescribeClusterDetailResponseBody({
      clusterId: "c-test",
      name: request.name,
      state: "running",
      clusterType: request.clusterType,
      currentVersion: "1.30.0-aliyun.1",
      initVersion: "1.30.0-aliyun.1",
      deletionProtection: false,
      regionId: "ap-southeast-5",
      created: "2026-08-31T00:00:00Z",
      tags: request.tags,
    });
    return new ACK.CreateClusterResponse({
      statusCode: 200,
      body: new ACK.CreateClusterResponseBody({ clusterId: "c-test" }),
    });
  }

  override async modifyCluster(
    _clusterId: string,
    request: ACK.ModifyClusterRequest,
  ): Promise<ACK.ModifyClusterResponse> {
    this.clusterModifies += 1;
    this.transientFailures.throwIfPlanned("DisableDeletionProtection");
    if (this.cluster !== undefined) {
      this.cluster = new ACK.DescribeClusterDetailResponseBody({
        ...this.cluster,
        deletionProtection:
          request.deletionProtection ?? this.cluster.deletionProtection,
      });
    }
    return new ACK.ModifyClusterResponse({ statusCode: 200 });
  }

  override async upgradeCluster(
    _clusterId: string,
    request: ACK.UpgradeClusterRequest,
  ): Promise<ACK.UpgradeClusterResponse> {
    this.clusterUpgrades += 1;
    if (this.cluster !== undefined) {
      this.cluster = new ACK.DescribeClusterDetailResponseBody({
        ...this.cluster,
        currentVersion: request.nextVersion ?? request.version,
      });
    }
    return new ACK.UpgradeClusterResponse({ statusCode: 200 });
  }

  override async tagResources(
    request: ACK.TagResourcesRequest,
  ): Promise<ACK.TagResourcesResponse> {
    if (this.cluster !== undefined) {
      const merged = new Map(
        (this.cluster.tags ?? []).flatMap((tag) =>
          tag.key === undefined || tag.value === undefined
            ? []
            : [[tag.key, tag.value] as const],
        ),
      );
      for (const tag of request.tags ?? []) {
        if (tag.key !== undefined && tag.value !== undefined) {
          merged.set(tag.key, tag.value);
        }
      }
      this.cluster = new ACK.DescribeClusterDetailResponseBody({
        ...this.cluster,
        tags: [...merged].map(([key, value]) => ({ key, value })),
      });
    }
    return new ACK.TagResourcesResponse({ statusCode: 200 });
  }

  override async untagResources(
    request: ACK.UntagResourcesRequest,
  ): Promise<ACK.UntagResourcesResponse> {
    if (this.cluster !== undefined) {
      const removed = new Set(request.tagKeys ?? []);
      this.cluster = new ACK.DescribeClusterDetailResponseBody({
        ...this.cluster,
        tags: (this.cluster.tags ?? []).filter(
          (tag) => tag.key === undefined || !removed.has(tag.key),
        ),
      });
    }
    return new ACK.UntagResourcesResponse({ statusCode: 200 });
  }

  override async deleteCluster(
    _clusterId: string,
    _request: ACK.DeleteClusterRequest,
  ): Promise<ACK.DeleteClusterResponse> {
    this.clusterDeletes += 1;
    this.transientFailures.throwIfPlanned("DeleteCluster");
    this.cluster = undefined;
    return new ACK.DeleteClusterResponse({ statusCode: 200 });
  }

  override async describeClusterNodePoolDetail(
    clusterId: string,
    nodepoolId: string,
  ): Promise<ACK.DescribeClusterNodePoolDetailResponse> {
    this.nodePoolReads += 1;
    const pool = clusterId === "c-test" &&
      this.nodePool?.nodepoolInfo?.nodepoolId === nodepoolId
      ? this.nodePool
      : undefined;
    if (pool !== undefined && this.nodePoolReadsUntilAbsent > 0) {
      this.nodePoolReadsUntilAbsent -= 1;
      if (this.nodePoolReadsUntilAbsent === 0) this.nodePool = undefined;
    }
    return pool !== undefined
      ? new ACK.DescribeClusterNodePoolDetailResponse({
          statusCode: 200,
          body: pool,
        })
      : new ACK.DescribeClusterNodePoolDetailResponse({ statusCode: 404 });
  }

  override async describeClusterNodePools(
    _clusterId: string,
    _request: ACK.DescribeClusterNodePoolsRequest,
  ): Promise<ACK.DescribeClusterNodePoolsResponse> {
    return new ACK.DescribeClusterNodePoolsResponse({
      statusCode: 200,
      body: new ACK.DescribeClusterNodePoolsResponseBody({
        nodepools:
          this.nodePool === undefined
            ? []
            : [
                new ACK.DescribeClusterNodePoolsResponseBodyNodepools({
                  nodepoolInfo:
                    new ACK.DescribeClusterNodePoolsResponseBodyNodepoolsNodepoolInfo(
                      {
                        nodepoolId: this.nodePool.nodepoolInfo?.nodepoolId,
                        name: this.nodePool.nodepoolInfo?.name,
                      },
                    ),
                }),
              ],
      }),
    });
  }

  override async createClusterNodePool(
    _clusterId: string,
    request: ACK.CreateClusterNodePoolRequest,
  ): Promise<ACK.CreateClusterNodePoolResponse> {
    this.nodePoolCreates += 1;
    this.nodePool = new ACK.DescribeClusterNodePoolDetailResponseBody({
      nodepoolInfo: new ACK.DescribeClusterNodePoolDetailResponseBodyNodepoolInfo({
        nodepoolId: "np-test",
        name: request.nodepoolInfo?.name,
        type: "ess",
        regionId: "ap-southeast-5",
        created: "2026-08-31T00:00:00Z",
      }),
      scalingGroup: new ACK.DescribeClusterNodePoolDetailResponseBodyScalingGroup({
        scalingGroupId: "asg-test",
        desiredSize: request.scalingGroup?.desiredSize ?? 1,
        tags: request.scalingGroup?.tags,
      }),
      status: new ACK.DescribeClusterNodePoolDetailResponseBodyStatus({
        state: "active",
        totalNodes: 1,
        healthyNodes: 1,
      }),
    });
    return new ACK.CreateClusterNodePoolResponse({
      statusCode: 200,
      body: new ACK.CreateClusterNodePoolResponseBody({ nodepoolId: "np-test" }),
    });
  }

  override async modifyClusterNodePool(
    _clusterId: string,
    _nodepoolId: string,
    request: ACK.ModifyClusterNodePoolRequest,
  ): Promise<ACK.ModifyClusterNodePoolResponse> {
    this.nodePoolModifies += 1;
    if (this.nodePool !== undefined) {
      this.nodePool = new ACK.DescribeClusterNodePoolDetailResponseBody({
        ...this.nodePool,
        scalingGroup:
          new ACK.DescribeClusterNodePoolDetailResponseBodyScalingGroup({
            ...this.nodePool.scalingGroup,
            desiredSize:
              request.scalingGroup?.desiredSize ??
              this.nodePool.scalingGroup?.desiredSize,
            tags: request.scalingGroup?.tags,
          }),
      });
    }
    return new ACK.ModifyClusterNodePoolResponse({ statusCode: 200 });
  }

  override async deleteClusterNodepool(
    _clusterId: string,
    _nodepoolId: string,
    _request: ACK.DeleteClusterNodepoolRequest,
  ): Promise<ACK.DeleteClusterNodepoolResponse> {
    this.nodePoolDeletes += 1;
    this.transientFailures.throwIfPlanned("DeleteClusterNodepool");
    this.nodePool = undefined;
    return new ACK.DeleteClusterNodepoolResponse({ statusCode: 200 });
  }

  override async describeClusterAddonInstance(
    _clusterId: string,
    addonName: string,
  ): Promise<ACK.DescribeClusterAddonInstanceResponse> {
    const addon = this.addon?.name === addonName ? this.addon : undefined;
    if (addon !== undefined && this.addonReadsUntilAbsent > 0) {
      this.addonReadsUntilAbsent -= 1;
      if (this.addonReadsUntilAbsent === 0) this.addon = undefined;
    }
    return addon !== undefined
      ? new ACK.DescribeClusterAddonInstanceResponse({
          statusCode: 200,
          body: addon,
        })
      : new ACK.DescribeClusterAddonInstanceResponse({ statusCode: 404 });
  }

  override async installClusterAddons(
    _clusterId: string,
    request: ACK.InstallClusterAddonsRequest,
  ): Promise<ACK.InstallClusterAddonsResponse> {
    this.addonInstalls += 1;
    const desired = request.body?.[0];
    this.addon = new ACK.DescribeClusterAddonInstanceResponseBody({
      name: desired?.name,
      version: desired?.version,
      config: desired?.config,
      state: "active",
    });
    return new ACK.InstallClusterAddonsResponse({ statusCode: 200 });
  }

  override async upgradeClusterAddons(
    _clusterId: string,
    request: ACK.UpgradeClusterAddonsRequest,
  ): Promise<ACK.UpgradeClusterAddonsResponse> {
    this.addonUpgrades += 1;
    const desired = request.body?.[0];
    this.addon = new ACK.DescribeClusterAddonInstanceResponseBody({
      ...this.addon,
      name: desired?.componentName,
      version: desired?.nextVersion,
      config: desired?.config,
      state: "active",
    });
    return new ACK.UpgradeClusterAddonsResponse({ statusCode: 200 });
  }

  override async modifyClusterAddon(
    _clusterId: string,
    _componentId: string,
    request: ACK.ModifyClusterAddonRequest,
  ): Promise<ACK.ModifyClusterAddonResponse> {
    this.addonModifies += 1;
    this.addon = new ACK.DescribeClusterAddonInstanceResponseBody({
      ...this.addon,
      config: request.config,
      state: "active",
    });
    return new ACK.ModifyClusterAddonResponse({ statusCode: 200 });
  }

  override async unInstallClusterAddons(
    _clusterId: string,
    _request: ACK.UnInstallClusterAddonsRequest,
  ): Promise<ACK.UnInstallClusterAddonsResponse> {
    this.addonUninstalls += 1;
    this.transientFailures.throwIfPlanned("UnInstallClusterAddons");
    this.addon = undefined;
    return new ACK.UnInstallClusterAddonsResponse({ statusCode: 200 });
  }
}

const providerLayer = (fake: StatefulACKClient) =>
  Layer.succeed(AlibabaClients, testClientSet({ ack: fake }));

describe("ACK provider lifecycles", () => {
  it("does not call ACK when an interrupted node pool has no cluster identity", async () => {
    const fake = new StatefulACKClient();
    const layer = NodePoolProvider().pipe(Layer.provide(providerLayer(fake)));
    const program = Effect.gen(function* () {
      const provider = yield* NodePool.Provider;
      const read = provider.read;
      if (read === undefined) throw new Error("NodePool read is missing");
      return yield* read({
        ...resourceBase("interrupted-node-pool"),
        olds: {} as never,
        output: undefined,
      });
    });

    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toBeUndefined();
    expect(fake.nodePoolReads).toBe(0);
  });

  it("rejects a managed cluster without its selected network addon", async () => {
    const fake = new StatefulACKClient();
    const layer = ManagedClusterProvider({
      wait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const program = Effect.gen(function* () {
      const provider = yield* ManagedCluster.Provider;
      return yield* provider.reconcile({
        ...resourceBase("cluster-without-cni"),
        news: {
          create: {
            clusterType: "ManagedKubernetes",
            profile: "Default",
            clusterSpec: "ack.pro.small",
            addons: [{ name: "csi-plugin" }],
            vpcid: "vpc-test",
            vswitchIds: ["vsw-a", "vsw-b"],
            containerCidr: "172.20.0.0/16",
            serviceCidr: "172.21.0.0/20",
          },
        },
        olds: undefined,
        output: undefined,
      });
    });

    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).rejects.toMatchObject({
      _tag: "AlibabaInvariantError",
      operation: "CreateCluster",
      message: "Flannel networking requires the flannel addon",
    });
    expect(fake.clusterCreates).toBe(0);
  });

  it("creates, updates, and deletes a cluster through transient teardown failures", async () => {
    const fake = new StatefulACKClient();
    const layer = ManagedClusterProvider({
      wait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("cluster");
    const initial = {
      name: "example-dev",
      create: {
        clusterType: "ManagedKubernetes" as const,
        profile: "Default" as const,
        clusterSpec: "ack.pro.small" as const,
        addons: [{ name: "flannel" }] as [{ name: string }],
        vpcid: "vpc-test",
        vswitchIds: ["vsw-a", "vsw-b"],
        containerCidr: "172.20.0.0/16",
        serviceCidr: "172.21.0.0/20",
      },
      tags: { environment: "dev" },
    };
    const changed = {
      ...initial,
      modify: { deletionProtection: true },
      upgrade: { nextVersion: "1.31.0-aliyun.1" },
      tags: { environment: "test" },
    };
    const program = Effect.gen(function* () {
      const provider = yield* ManagedCluster.Provider;
      const created = yield* provider.reconcile({
        ...base,
        news: initial,
        olds: undefined,
        output: undefined,
      });
      const updated = yield* provider.reconcile({
        ...base,
        news: changed,
        olds: initial,
        output: created,
      });
      const read = provider.read;
      if (read === undefined) throw new Error("ManagedCluster read is missing");
      const observed = yield* read({ ...base, olds: changed, output: updated });
      fake.transientFailures.failNext("DisableDeletionProtection");
      fake.transientFailures.failNext("DeleteCluster");
      yield* provider.delete({ ...base, olds: changed, output: updated });
      return observed;
    });

    const observed = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(observed).toMatchObject({
      clusterId: "c-test",
      currentVersion: "1.31.0-aliyun.1",
      deletionProtection: true,
      tags: { environment: "test" },
    });
    expect(fake.clusterCreates).toBe(1);
    expect(fake.clusterUpgrades).toBe(1);
    expect(fake.clusterModifies).toBe(3);
    expect(fake.clusterDeletes).toBe(2);
    expect(fake.cluster).toBeUndefined();
  });

  it("creates, updates, and deletes a node pool after a transient failure", async () => {
    const fake = new StatefulACKClient();
    const layer = NodePoolProvider({
      wait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("node-pool");
    const initial = {
      clusterId: "c-test",
      name: "workers",
      create: {
        nodepoolInfo: {},
        scalingGroup: {
          desiredSize: 1,
          instanceChargeType: "PostPaid" as const,
          instanceTypes: ["ecs.g7.large"],
          vswitchIds: ["vsw-test"],
        },
      },
      tags: { environment: "dev" },
    };
    const changed = {
      ...initial,
      modify: { scalingGroup: { desiredSize: 2 } },
      tags: { environment: "test" },
    };
    const program = Effect.gen(function* () {
      const provider = yield* NodePool.Provider;
      const created = yield* provider.reconcile({
        ...base,
        news: initial,
        olds: undefined,
        output: undefined,
      });
      const updated = yield* provider.reconcile({
        ...base,
        news: changed,
        olds: initial,
        output: created,
      });
      fake.transientFailures.failNext("DeleteClusterNodepool");
      yield* provider.delete({ ...base, olds: changed, output: updated });
      return updated;
    });

    const updated = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(updated).toMatchObject({
      clusterId: "c-test",
      nodepoolId: "np-test",
      desiredSize: 2,
      tags: { environment: "test" },
    });
    expect(fake.nodePoolCreates).toBe(1);
    expect(fake.nodePoolModifies).toBe(1);
    expect(fake.nodePoolDeletes).toBe(2);
    expect(fake.nodePool).toBeUndefined();
  });

  it("installs, updates, and uninstalls an addon after a transient failure", async () => {
    const fake = new StatefulACKClient();
    const layer = AddonProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("addon");
    const initial = {
      clusterId: "c-test",
      name: "coredns",
      version: "v1",
      config: "{\"replicas\":2}",
    };
    const upgraded = { ...initial, version: "v2" };
    const reconfigured = { ...upgraded, config: "{\"replicas\":3}" };
    const program = Effect.gen(function* () {
      const provider = yield* Addon.Provider;
      const created = yield* provider.reconcile({
        ...base,
        news: initial,
        olds: undefined,
        output: undefined,
      });
      const next = yield* provider.reconcile({
        ...base,
        news: upgraded,
        olds: initial,
        output: created,
      });
      const updated = yield* provider.reconcile({
        ...base,
        news: reconfigured,
        olds: upgraded,
        output: next,
      });
      fake.transientFailures.failNext("UnInstallClusterAddons");
      yield* provider.delete({ ...base, olds: reconfigured, output: updated });
      return updated;
    });

    const updated = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(updated).toMatchObject({
      name: "coredns",
      version: "v2",
      config: "{\"replicas\":3}",
    });
    expect(fake.addonInstalls).toBe(1);
    expect(fake.addonUpgrades).toBe(1);
    expect(fake.addonModifies).toBe(1);
    expect(fake.addonUninstalls).toBe(2);
    expect(fake.addon).toBeUndefined();
  });

  it("recovers a cluster orphaned by an interrupted create by paginating the region inventory", async () => {
    const fake = new StatefulACKClient();
    // The create landed but the response never arrived, so there is no
    // persisted clusterId. ACK exposes no idempotency token, so name lookup
    // is the only way to reach the orphan instead of building a second one.
    fake.cluster = new ACK.DescribeClusterDetailResponseBody({
      clusterId: "c-orphan",
      name: "example-test",
      state: "running",
      clusterType: "ManagedKubernetes",
      currentVersion: "1.30.0-aliyun.1",
      initVersion: "1.30.0-aliyun.1",
      deletionProtection: false,
      regionId: "ap-southeast-5",
      created: "2026-08-31T00:00:00Z",
    });
    // Push the real cluster onto page 2 of a 50-per-page inventory.
    fake.decoyClusters = Array.from({ length: 50 }, (_, index) => ({
      clusterId: `c-decoy-${index}`,
      name: `example-test-decoy-${index}`,
    }));
    const layer = ManagedClusterProvider({
      wait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("cluster-orphan");
    const news = {
      name: "example-test",
      create: {
        clusterType: "ManagedKubernetes" as const,
        profile: "Default" as const,
        clusterSpec: "ack.pro.small" as const,
        addons: [{ name: "flannel" }] as [{ name: string }],
        vpcid: "vpc-test",
        vswitchIds: ["vsw-test"],
        containerCidr: "172.20.0.0/16",
        serviceCidr: "172.21.0.0/20",
      },
    };

    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* ManagedCluster.Provider;
        return yield* provider.reconcile({
          ...base,
          news,
          olds: undefined,
          output: undefined,
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );

    expect(recovered.clusterId).toBe("c-orphan");
    // Adopted, not duplicated.
    expect(fake.clusterCreates).toBe(0);
    // Every inventory request is region-scoped, and more than one page was read.
    expect(fake.clusterListRequests.length).toBeGreaterThan(1);
    for (const request of fake.clusterListRequests) {
      expect(request.regionId).toBe("ap-southeast-5");
    }
  });

  it("never adopts a same-named cluster from another region", async () => {
    const fake = new StatefulACKClient();
    fake.otherRegionClusters = [
      { clusterId: "c-other-region", name: "example-test" },
    ];
    const layer = ManagedClusterProvider({
      wait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("cluster-cross-region");
    const news = {
      name: "example-test",
      create: {
        clusterType: "ManagedKubernetes" as const,
        profile: "Default" as const,
        clusterSpec: "ack.pro.small" as const,
        addons: [{ name: "flannel" }] as [{ name: string }],
        vpcid: "vpc-test",
        vswitchIds: ["vsw-test"],
        containerCidr: "172.20.0.0/16",
        serviceCidr: "172.21.0.0/20",
      },
    };

    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* ManagedCluster.Provider;
        return yield* provider.reconcile({
          ...base,
          news,
          olds: undefined,
          output: undefined,
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );

    // The out-of-region cluster is invisible, so a fresh one is built. Had the
    // provider fallen back to the account-wide v0 API, the stub would have
    // thrown rather than let "c-other-region" be adopted.
    expect(created.clusterId).toBe("c-test");
    expect(fake.clusterCreates).toBe(1);
    expect(fake.clusterListRequests.length).toBeGreaterThan(0);
  });

  it("resumes an already-deleting cluster without another delete request", async () => {
    const fake = new StatefulACKClient();
    fake.cluster = new ACK.DescribeClusterDetailResponseBody({
      clusterId: "c-test",
      name: "example-test",
      state: "deleting",
      deletionProtection: false,
    });
    fake.clusterReadsUntilAbsent = 1;
    const layer = ManagedClusterProvider({
      wait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("cluster-resumed-delete");
    const olds = {
      name: "example-test",
      create: {
        clusterType: "ManagedKubernetes" as const,
        profile: "Default" as const,
        clusterSpec: "ack.pro.small" as const,
        addons: [{ name: "flannel" }] as [{ name: string }],
        vpcid: "vpc-test",
        vswitchIds: ["vsw-test"],
        containerCidr: "172.20.0.0/16",
        serviceCidr: "172.21.0.0/20",
      },
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* ManagedCluster.Provider;
        yield* provider.delete({
          ...base,
          olds,
          output: {
            clusterId: "c-test",
            name: "example-test",
            state: "deleting",
            vswitchIds: ["vsw-test"],
            deletionProtection: false,
            tags: {},
          },
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(fake.clusterDeletes).toBe(0);
  });

  it("resumes an already-removing node pool without another delete request", async () => {
    const fake = new StatefulACKClient();
    fake.nodePool = new ACK.DescribeClusterNodePoolDetailResponseBody({
      nodepoolInfo:
        new ACK.DescribeClusterNodePoolDetailResponseBodyNodepoolInfo({
          nodepoolId: "np-test",
          name: "workers",
        }),
      status: new ACK.DescribeClusterNodePoolDetailResponseBodyStatus({
        state: "removing",
      }),
    });
    fake.nodePoolReadsUntilAbsent = 1;
    const layer = NodePoolProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("node-pool-resumed-delete");
    const olds = {
      clusterId: "c-test",
      name: "workers",
      create: {
        scalingGroup: {
          desiredSize: 1,
          instanceChargeType: "PostPaid" as const,
          instanceTypes: ["ecs.g7.large"],
          vswitchIds: ["vsw-test"],
        },
      },
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* NodePool.Provider;
        yield* provider.delete({
          ...base,
          olds,
          output: {
            clusterId: "c-test",
            nodepoolId: "np-test",
            name: "workers",
            state: "removing",
            tags: {},
          },
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(fake.nodePoolDeletes).toBe(0);
  });

  it("resumes an uninstalling addon without another uninstall request", async () => {
    const fake = new StatefulACKClient();
    fake.addon = new ACK.DescribeClusterAddonInstanceResponseBody({
      name: "coredns",
      version: "v1",
      state: "uninstalling",
    });
    fake.addonReadsUntilAbsent = 1;
    const layer = AddonProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("addon-resumed-delete");
    const olds = {
      clusterId: "c-test",
      name: "coredns",
      version: "v1",
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Addon.Provider;
        yield* provider.delete({
          ...base,
          olds,
          output: {
            clusterId: "c-test",
            name: "coredns",
            version: "v1",
            state: "uninstalling",
          },
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(fake.addonUninstalls).toBe(0);
  });
});
