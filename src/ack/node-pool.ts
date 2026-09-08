import * as ACK from "@alicloud/cs20151215";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { hasAlchemyTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import { isDeepStrictEqual } from "node:util";
import { AlibabaClients } from "../clients.ts";
import { isNotFound, retryingSdkCall, sdkCall } from "../error.ts";
import {
  desiredTags,
  paginate,
  physicalName,
  requireValue,
  requestOrContinueDelete,
  tagsEqual,
  userTags,
  waitFor,
  waitForAbsent,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { ModelInput } from "../internal/model-input.ts";
import type { Providers } from "../providers.ts";
import { waitForTask } from "./task.ts";
import { modelMatches } from "../internal/observation.ts";

type NodePoolCreateRequest = ModelInput<ACK.CreateClusterNodePoolRequest>;
type NodePoolInfo = NonNullable<NodePoolCreateRequest["nodepoolInfo"]>;
type NodePoolScalingGroup = NonNullable<NodePoolCreateRequest["scalingGroup"]>;

export type NodePoolCreate = Omit<
  NodePoolCreateRequest,
  "nodepoolInfo" | "scalingGroup"
> & {
  readonly nodepoolInfo?: Omit<NodePoolInfo, "name">;
  readonly scalingGroup: Omit<
    NodePoolScalingGroup,
    "instanceChargeType" | "instanceTypes" | "vswitchIds"
  > & {
    /** Required by CreateClusterNodePool. */
    readonly instanceChargeType: "PrePaid" | "PostPaid";
    /** Alibaba accepts 1-10 candidates and recommends several for availability. */
    readonly instanceTypes: string[];
    /** Required by CreateClusterNodePool; use multiple zones for availability. */
    readonly vswitchIds: string[];
  };
};

export interface NodePoolProps {
  readonly clusterId: string;
  readonly name?: string;
  /** Alibaba CreateClusterNodePool request with documented required fields encoded. */
  readonly create: NodePoolCreate;
  /** Complete mutable request; applied when desired input or observed tags drift. */
  readonly modify?: ModelInput<ACK.ModifyClusterNodePoolRequest>;
  readonly delete?: ModelInput<ACK.DeleteClusterNodepoolRequest>;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface NodePoolAttributes {
  readonly clusterId: string;
  readonly nodepoolId: string;
  readonly name: string;
  readonly state: string;
  readonly type?: string;
  readonly regionId?: string;
  readonly resourceGroupId?: string;
  readonly scalingGroupId?: string;
  readonly desiredSize?: number;
  readonly totalNodes?: number;
  readonly healthyNodes?: number;
  readonly servingNodes?: number;
  readonly failedNodes?: number;
  readonly created?: string;
  readonly updated?: string;
  readonly tags: Readonly<Record<string, string>>;
}

export type NodePool = Resource<
  "Alibaba.ACK.NodePool",
  NodePoolProps,
  NodePoolAttributes,
  never,
  Providers
>;

export const NodePool = Resource<NodePool>("Alibaba.ACK.NodePool");

const tagRecord = (
  tags: ReadonlyArray<{ key?: string; value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? []).flatMap((tag) =>
      tag.key === undefined || tag.value === undefined
        ? []
        : [[tag.key, tag.value] as const],
    ),
  );

const tagList = (tags: Readonly<Record<string, string>>) =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));

const observedTags = (pool: ACK.DescribeClusterNodePoolDetailResponseBody) =>
  tagRecord(pool.scalingGroup?.tags);

const toAttributes = (
  clusterId: string,
  pool: ACK.DescribeClusterNodePoolDetailResponseBody,
) =>
  Effect.gen(function* () {
    const nodepoolId = yield* requireValue(
      pool.nodepoolInfo?.nodepoolId,
      NodePool.Type,
      "DescribeClusterNodePoolDetail",
      "ACK returned a node pool without nodepoolId",
    );
    const name = yield* requireValue(
      pool.nodepoolInfo?.name,
      NodePool.Type,
      "DescribeClusterNodePoolDetail",
      "ACK returned a node pool without name",
    );
    return {
      clusterId,
      nodepoolId,
      name,
      state: pool.status?.state ?? "Unknown",
      type: pool.nodepoolInfo?.type,
      regionId: pool.nodepoolInfo?.regionId,
      resourceGroupId: pool.nodepoolInfo?.resourceGroupId,
      scalingGroupId: pool.scalingGroup?.scalingGroupId,
      desiredSize: pool.scalingGroup?.desiredSize,
      totalNodes: pool.status?.totalNodes,
      healthyNodes: pool.status?.healthyNodes,
      servingNodes: pool.status?.servingNodes,
      failedNodes: pool.status?.failedNodes,
      created: pool.nodepoolInfo?.created,
      updated: pool.nodepoolInfo?.updated,
      tags: userTags(observedTags(pool)),
    } satisfies NodePoolAttributes;
  });

const ready = (pool: ACK.DescribeClusterNodePoolDetailResponseBody) => {
  const state = pool.status?.state?.toLowerCase();
  return state === "active" || state === "running";
};

const deleting = (pool: ACK.DescribeClusterNodePoolDetailResponseBody) => {
  const state = pool.status?.state?.toLowerCase();
  return state === "deleting" || state === "removing";
};

const modifyMatches = (
  pool: ACK.DescribeClusterNodePoolDetailResponseBody,
  desired: ModelInput<ACK.ModifyClusterNodePoolRequest> | undefined,
) =>
  modelMatches(
    pool,
    desired === undefined
      ? undefined
      : {
          ...desired,
          // Tags are owned and checked independently, including internal tags.
          scalingGroup:
            desired.scalingGroup === undefined
              ? undefined
              : { ...desired.scalingGroup, tags: undefined },
        },
    ACK.DescribeClusterNodePoolDetailResponseBody,
  );

export interface NodePoolProviderOptions {
  readonly wait?: WaitOptions;
}

export const NodePoolProvider = (options: NodePoolProviderOptions = {}) =>
  Provider.effect(
    NodePool,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;

      const getById = (clusterId: string, nodepoolId: string) =>
        retryingSdkCall("ACK", "DescribeClusterNodePoolDetail", () =>
          clients.ack.describeClusterNodePoolDetail(clusterId, nodepoolId),
        ).pipe(
          Effect.map((response) => response.body),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );

      const findByName = (clusterId: string, name: string) =>
        retryingSdkCall("ACK", "DescribeClusterNodePools", () =>
          clients.ack.describeClusterNodePools(
            clusterId,
            new ACK.DescribeClusterNodePoolsRequest({ nodepoolName: name }),
          ),
        ).pipe(
          Effect.map(
            (response) =>
              response.body?.nodepools?.find(
                (pool) => pool.nodepoolInfo?.name === name,
              )?.nodepoolInfo?.nodepoolId,
          ),
          Effect.flatMap((nodepoolId) =>
            nodepoolId === undefined
              ? Effect.succeed(undefined)
              : getById(clusterId, nodepoolId),
          ),
        );

      const observe = (
        clusterId: string,
        nodepoolId: string | undefined,
        name: string,
      ) =>
        nodepoolId === undefined
          ? findByName(clusterId, name)
          : getById(clusterId, nodepoolId).pipe(
              Effect.flatMap((pool) =>
                pool === undefined
                  ? findByName(clusterId, name)
                  : Effect.succeed(pool),
              ),
            );

      return {
        version: 1,
        stables: ["clusterId", "nodepoolId", "created"] as const,
        // Node pools are scoped to a cluster, so they must all be gone before
        // any cluster (or the network beneath it) is deleted.
        nuke: {
          dependsOn: ["Alibaba.ACK.ManagedCluster", "Alibaba.VPC.*"],
        },
        /**
         * Node pools have no account-wide inventory API — they are addressed
         * only through their cluster. Enumerate the region's clusters first,
         * then each cluster's pools. `DescribeClusterNodePools` is not paged,
         * and a cluster deleted mid-scan simply contributes nothing.
         */
        list: () =>
          paginate({
            service: "ACK",
            operation: "DescribeClustersV1",
            page: ({ pageNumber, pageSize }) =>
              retryingSdkCall("ACK", "DescribeClustersV1", () =>
                clients.ack.describeClustersV1(
                  new ACK.DescribeClustersV1Request({
                    regionId: clients.regionId,
                    pageNumber,
                    pageSize,
                  }),
                ),
              ).pipe(
                Effect.map((response) => ({
                  items: (response.body?.clusters ?? []).flatMap((cluster) =>
                    cluster.clusterId === undefined ? [] : [cluster.clusterId],
                  ),
                  totalCount: response.body?.pageInfo?.totalCount,
                })),
                Effect.catchIf(isNotFound, () =>
                  Effect.succeed({ items: [] as string[] }),
                ),
              ),
          }).pipe(
            Effect.flatMap(
              Effect.forEach(
                (clusterId) =>
                  retryingSdkCall("ACK", "DescribeClusterNodePools", () =>
                    clients.ack.describeClusterNodePools(
                      clusterId,
                      new ACK.DescribeClusterNodePoolsRequest({}),
                    ),
                  ).pipe(
                    Effect.map((response) => response.body?.nodepools ?? []),
                    Effect.catchIf(isNotFound, () =>
                      Effect.succeed(
                        [] as ACK.DescribeClusterNodePoolsResponseBodyNodepools[],
                      ),
                    ),
                    // The list entries carry a different shape than the
                    // detail read, so re-read each pool for full attributes.
                    Effect.flatMap(
                      Effect.forEach(
                        (pool) =>
                          pool.nodepoolInfo?.nodepoolId === undefined
                            ? Effect.succeed([])
                            : getById(
                                clusterId,
                                pool.nodepoolInfo.nodepoolId,
                              ).pipe(
                                Effect.flatMap((detail) =>
                                  detail === undefined
                                    ? Effect.succeed([])
                                    : toAttributes(clusterId, detail).pipe(
                                        Effect.map((value) => [value]),
                                      ),
                                ),
                              ),
                        { concurrency: 4 },
                      ),
                    ),
                    Effect.map((groups) => groups.flat()),
                  ),
                { concurrency: 4 },
              ),
            ),
            Effect.map((groups) => groups.flat()),
          ),

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds.clusterId === undefined || olds.create === undefined) {
            return undefined;
          }
          if (
            olds.clusterId !== news.clusterId ||
            olds.name !== news.name ||
            !isDeepStrictEqual(olds.create, news.create)
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const clusterId = olds.clusterId ?? output?.clusterId;
          if (clusterId === undefined) return undefined;
          const name = yield* physicalName(id, olds.name ?? output?.name, 63);
          const pool = yield* observe(clusterId, output?.nodepoolId, name);
          if (pool === undefined) return undefined;
          const attributes = yield* toAttributes(clusterId, pool);
          return (yield* hasAlchemyTags(id, observedTags(pool)))
            ? attributes
            : Unowned(attributes);
        }),

        reconcile: Effect.fn(function* ({ id, news, olds, output }) {
          const name = yield* physicalName(id, news.name ?? output?.name, 63);
          const tags = yield* desiredTags(id, news.tags);
          let pool = yield* observe(news.clusterId, output?.nodepoolId, name);

          if (pool === undefined) {
            const response = yield* sdkCall(
              "ACK",
              "CreateClusterNodePool",
              () =>
                clients.ack.createClusterNodePool(
                  news.clusterId,
                  new ACK.CreateClusterNodePoolRequest({
                    ...news.create,
                    nodepoolInfo: { ...news.create.nodepoolInfo, name },
                    scalingGroup: {
                      ...news.create.scalingGroup,
                      tags: tagList(tags),
                    },
                  }),
                ),
            );
            yield* waitForTask({
              client: clients.ack,
              operation: "CreateClusterNodePool",
              taskId: response.body?.taskId,
              wait: options.wait,
            });
            pool = yield* waitForPresent({
              service: "ACK",
              operation: "CreateClusterNodePool",
              read: observe(news.clusterId, response.body?.nodepoolId, name),
              ready,
              wait: options.wait,
            });
          }

          const nodepoolId = yield* requireValue(
            pool.nodepoolInfo?.nodepoolId,
            NodePool.Type,
            "Reconcile",
            "ACK returned a node pool without nodepoolId",
          );
          if (
            !tagsEqual(observedTags(pool), tags) ||
            (news.modify !== undefined &&
              (!isDeepStrictEqual(news.modify, olds?.modify) ||
                !modifyMatches(pool, news.modify)))
          ) {
            const response = yield* sdkCall(
              "ACK",
              "ModifyClusterNodePool",
              () =>
                clients.ack.modifyClusterNodePool(
                  news.clusterId,
                  nodepoolId,
                  new ACK.ModifyClusterNodePoolRequest({
                    ...news.modify,
                    scalingGroup: {
                      ...news.modify?.scalingGroup,
                      tags: tagList(tags),
                    },
                  }),
                ),
            );
            yield* waitForTask({
              client: clients.ack,
              operation: "ModifyClusterNodePool",
              taskId: response.body?.taskId,
              wait: options.wait,
            });
          }

          const fresh = yield* waitForPresent({
            service: "ACK",
            operation: "ReconcileClusterNodePool",
            read: getById(news.clusterId, nodepoolId),
            ready: (value) =>
              ready(value) &&
              modifyMatches(value, news.modify) &&
              tagsEqual(observedTags(value), tags),
            wait: options.wait,
          });
          return yield* toAttributes(news.clusterId, fresh);
        }),

        delete: Effect.fn(function* ({ output, olds }) {
          const pool = yield* getById(output.clusterId, output.nodepoolId);
          if (pool === undefined) return;
          if (!deleting(pool)) {
            const response = yield* requestOrContinueDelete({
              request: retryingSdkCall("ACK", "DeleteClusterNodepool", () =>
                clients.ack.deleteClusterNodepool(
                  output.clusterId,
                  output.nodepoolId,
                  new ACK.DeleteClusterNodepoolRequest(olds.delete),
                ),
              ),
              read: getById(output.clusterId, output.nodepoolId),
              deleting,
            });
            yield* waitForTask({
              client: clients.ack,
              operation: "DeleteClusterNodepool",
              taskId: response?.body?.taskId,
              wait: options.wait,
            });
          }
          yield* waitForAbsent({
            service: "ACK",
            operation: "DeleteClusterNodepool",
            read: getById(output.clusterId, output.nodepoolId),
            wait: options.wait,
          });
        }),
      };
    }),
  );
