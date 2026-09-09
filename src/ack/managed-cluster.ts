import { validateDesiredInput } from "../internal/desired-input.ts";
import { clusterConnection } from "./kubeconfig.ts";
import type { Connection } from "alchemy/Kubernetes/Connection";
import { modelFields } from "../internal/model-input.ts";
import { sdkInput, type SecretInput } from "../internal/secret-input.ts";
import {
  uniqueMatch,
  replacement,
  requireRecoveryOwnership,
} from "../internal/identity.ts";
import * as ACK from "@alicloud/cs20151215";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { hasAlchemyTags, diffTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import { isDeepStrictEqual } from "node:util";
import { AlibabaClients } from "../clients.ts";
import {
  AlibabaInvariantError,
  isNotFound,
  retryingSdkCall,
  sdkCall,
} from "../error.ts";
import {
  desiredTags,
  paginate,
  physicalName,
  requireValue,
  requireRegion,
  requestOrContinueDelete,
  tagsEqual,
  userTags,
  waitFor,
  waitForAbsent,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { ModelInput, Without } from "../internal/model-input.ts";
import type { Providers } from "../providers.ts";
import { waitForTask } from "./task.ts";
import { modelMatches } from "../internal/observation.ts";

type ManagedClusterCreateRequest = Omit<
  SecretInput<ACK.CreateClusterRequest>,
  | "clusterSpec"
  | "clusterType"
  | "addons"
  | "name"
  | "profile"
  | "regionId"
  | "serviceCidr"
  | "tags"
  | "vpcid"
  | "vswitchIds"
>;

type ManagedClusterAddon = Omit<ModelInput<ACK.Addon>, "name"> & {
  readonly name: string;
};

type ManagedClusterNetwork =
  | {
      /** Required for the Flannel network plugin. */
      readonly containerCidr: string;
      readonly podVswitchIds?: string[];
    }
  | {
      /** Required for the Terway network plugin. */
      readonly podVswitchIds: string[];
      readonly containerCidr?: string;
    };

type ManagedClusterCreate = ManagedClusterCreateRequest &
  ManagedClusterNetwork & {
    readonly regionId?: string;
    /** The ACK CreateCluster contract for a managed cluster. */
    readonly clusterType: "ManagedKubernetes";
    readonly profile: "Default";
    readonly clusterSpec: "ack.pro.small" | "ack.standard";
    /** Explicit system components; include the selected CNI plugin. */
    readonly addons: [ManagedClusterAddon, ...ManagedClusterAddon[]];
    readonly vpcid: string;
    readonly serviceCidr: string;
    readonly vswitchIds: string[];
  };

/** Desired cluster configuration; SDK create/update requests are internal. */
export type ManagedClusterProps = ManagedClusterCreate &
  Omit<
    SecretInput<ACK.ModifyClusterRequest>,
    keyof ManagedClusterCreate | "clusterName" | "clientToken"
  > & {
    readonly connectionOptions?: import("./kubeconfig.ts").KubeconfigOptions;
    /** Deterministic Alchemy name when omitted. */
    readonly name?: string;
    /** Upgrade execution policy; kubernetesVersion is the only desired version. */
    readonly upgradePolicy?: Without<
      ACK.UpgradeClusterRequest,
      "nextVersion" | "version"
    >;
    /** Retention of cluster-associated resources during destroy. */
    readonly delete?: ModelInput<ACK.DeleteClusterRequest>;
    readonly tags?: Readonly<Record<string, string>>;
  };
const mutableFields = [
  "clusterSpec",
  "deletionProtection",
  "enableRrsa",
  "maintenanceWindow",
  "resourceGroupId",
  "timezone",
  "kubernetesVersion",
] as const;
const immutableCreate = (create: ManagedClusterCreate) =>
  Object.fromEntries(
    Object.entries(create).filter(
      ([key]) => !mutableFields.includes(key as (typeof mutableFields)[number]),
    ),
  );
const requests = (props: ManagedClusterProps) => ({
  ...props,
  create: modelFields<ManagedClusterCreate>(props, ACK.CreateClusterRequest, [
    "name",
    "tags",
  ]),
  modify: modelFields<SecretInput<ACK.ModifyClusterRequest>>(
    props,
    ACK.ModifyClusterRequest,
    [
      "clusterName",
      "clientToken",
      ...Object.keys(ACK.CreateClusterRequest.types()).filter(
        (key) => !mutableFields.includes(key as (typeof mutableFields)[number]),
      ),
    ],
  ),
  upgrade: { ...props.upgradePolicy, nextVersion: props.kubernetesVersion },
});

export interface ManagedClusterAttributes {
  /** ACK owns this OIDC provider when RRSA is enabled. */
  readonly oidcProviderArn?: string;
  readonly oidcIssuer?: string;
  readonly connection: Connection;
  readonly clusterId: string;
  readonly name: string;
  readonly state: string;
  readonly clusterType?: string;
  readonly clusterSpec?: string;
  readonly profile?: string;
  readonly currentVersion?: string;
  readonly initialVersion?: string;
  readonly nextVersion?: string;
  readonly regionId?: string;
  readonly zoneId?: string;
  readonly vpcId?: string;
  readonly vswitchIds: readonly string[];
  readonly serviceCidr?: string;
  readonly containerCidr?: string;
  readonly securityGroupId?: string;
  readonly resourceGroupId?: string;
  readonly apiServerUrl?: string;
  readonly deletionProtection: boolean;
  readonly created?: string;
  readonly updated?: string;
  readonly tags: Readonly<Record<string, string>>;
}

export type ManagedCluster = Resource<
  "Alibaba.ACK.ManagedCluster",
  ManagedClusterProps,
  ManagedClusterAttributes,
  never,
  Providers
>;

export const ManagedCluster = Resource<ManagedCluster>(
  "Alibaba.ACK.ManagedCluster",
);

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

const toAttributes = (
  cluster: ACK.DescribeClusterDetailResponseBody,
): Effect.Effect<
  ManagedClusterAttributes,
  import("../error.ts").AlibabaInvariantError
> =>
  Effect.gen(function* () {
    const clusterId = yield* requireValue(
      cluster.clusterId,
      ManagedCluster.Type,
      "DescribeClusterDetail",
      "ACK returned a cluster without clusterId",
    );
    const name = yield* requireValue(
      cluster.name,
      ManagedCluster.Type,
      "DescribeClusterDetail",
      "ACK returned a cluster without name",
    );
    return {
      clusterId,
      connection: clusterConnection(clusterId, { regionId: cluster.regionId }),
      name,
      state: cluster.state ?? "Unknown",
      clusterType: cluster.clusterType,
      clusterSpec: cluster.clusterSpec,
      profile: cluster.profile,
      currentVersion: cluster.currentVersion,
      initialVersion: cluster.initVersion,
      nextVersion: cluster.nextVersion,
      regionId: cluster.regionId,
      zoneId: cluster.zoneId,
      vpcId: cluster.vpcId,
      vswitchIds:
        cluster.vswitchIds ?? (cluster.vswitchId ? [cluster.vswitchId] : []),
      serviceCidr: cluster.serviceCidr,
      containerCidr: cluster.containerCidr,
      securityGroupId: cluster.securityGroupId,
      oidcProviderArn: cluster.rrsaConfig?.oidcArn,
      oidcIssuer: cluster.rrsaConfig?.issuer?.split(",")[0],
      resourceGroupId: cluster.resourceGroupId,
      apiServerUrl: cluster.masterUrl,
      deletionProtection: cluster.deletionProtection ?? false,
      created: cluster.created,
      updated: cluster.updated,
      tags: userTags(tagRecord(cluster.tags)),
    };
  });

const sameVersion = (
  cluster: ACK.DescribeClusterDetailResponseBody,
  desired: ModelInput<ACK.UpgradeClusterRequest> | undefined,
): boolean => {
  const version = desired?.nextVersion;
  return version === undefined || cluster.currentVersion === version;
};

const ready = (cluster: ACK.DescribeClusterDetailResponseBody): boolean => {
  const state = cluster.state?.toLowerCase();
  return state === "running" || state === "active";
};

const modifyMatches = (
  cluster: ACK.DescribeClusterDetailResponseBody,
  desired: ModelInput<ACK.ModifyClusterRequest> | undefined,
): boolean =>
  desired === undefined ||
  modelMatches(
    cluster,
    {
      ...desired,
      name: desired.clusterName,
      rrsaConfig:
        desired.enableRrsa === undefined
          ? undefined
          : { enabled: desired.enableRrsa },
    },
    ACK.DescribeClusterDetailResponseBody,
  );

export interface ManagedClusterProviderOptions {
  readonly wait?: WaitOptions;
}

export const ManagedClusterProvider = (
  options: ManagedClusterProviderOptions = {},
) =>
  Provider.effect(
    ManagedCluster,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const createRequest = (create: ManagedClusterCreate) => ({
        ...create,
        regionId: create.regionId ?? clients.regionId,
      });

      const getById = (clusterId: string) =>
        retryingSdkCall("ACK", "DescribeClusterDetail", () =>
          clients.ack.describeClusterDetail(clusterId),
        ).pipe(
          Effect.map((response) => response.body),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );

      const deleting = (cluster: ACK.DescribeClusterDetailResponseBody) =>
        cluster.state?.toLowerCase() === "deleting";

      /**
       * Enumerates clusters in the configured region, one page at a time.
       *
       * `DescribeClusters` (v0) is deprecated, takes no `regionId` and does
       * not paginate — it answers with every cluster on the account, so a
       * same-named cluster in another region could be matched, adopted and
       * ultimately deleted. `DescribeClustersV1` is region-scoped and paged.
       * This matters more here than elsewhere: ACK's create APIs expose no
       * idempotency token, so name lookup is the *only* way to recover a
       * cluster orphaned by an interrupted create.
       */
      const listClusters = (request: { readonly name?: string } = {}) =>
        paginate({
          service: "ACK",
          operation: "DescribeClustersV1",
          page: ({ pageNumber, pageSize }) =>
            retryingSdkCall("ACK", "DescribeClustersV1", () =>
              clients.ack.describeClustersV1(
                new ACK.DescribeClustersV1Request({
                  regionId: clients.regionId,
                  name: request.name,
                  pageNumber,
                  pageSize,
                }),
              ),
            ).pipe(
              Effect.map((response) => ({
                items: response.body?.clusters ?? [],
                totalCount: response.body?.pageInfo?.totalCount,
              })),
              Effect.catchIf(isNotFound, () =>
                Effect.succeed({
                  items: [] as ACK.DescribeClustersV1ResponseBodyClusters[],
                }),
              ),
            ),
        });

      const findByName = (name: string) =>
        listClusters({ name }).pipe(
          // `name` is a server-side fuzzy match, so re-filter exactly.
          Effect.flatMap((clusters) =>
            uniqueMatch(
              clusters.filter((cluster) => cluster.name === name),
              ManagedCluster.Type,
            ),
          ),
          Effect.map((cluster) => cluster?.clusterId),
          Effect.flatMap((clusterId) =>
            clusterId === undefined
              ? Effect.succeed(undefined)
              : getById(clusterId),
          ),
        );

      const observe = (clusterId: string | undefined, name: string) =>
        clusterId === undefined ? findByName(name) : getById(clusterId);

      const syncTags = Effect.fn(function* (
        clusterId: string,
        regionId: string,
        observed: Readonly<Record<string, string>>,
        desired: Readonly<Record<string, string>>,
      ) {
        if (tagsEqual(observed, desired)) return;
        const { removed, upsert: entries } = diffTags(
          { ...observed },
          { ...desired },
        );
        const upsert = Object.fromEntries(
          entries.map(({ Key, Value }) => [Key, Value]),
        );
        if (Object.keys(upsert).length > 0) {
          yield* retryingSdkCall("ACK", "TagResources", () =>
            clients.ack.tagResources(
              new ACK.TagResourcesRequest({
                regionId,
                resourceType: "CLUSTER",
                resourceIds: [clusterId],
                tags: tagList(upsert),
              }),
            ),
          );
        }
        if (removed.length > 0) {
          yield* retryingSdkCall("ACK", "UntagResources", () =>
            clients.ack.untagResources(
              new ACK.UntagResourcesRequest({
                all: false,
                regionId,
                resourceType: "CLUSTER",
                resourceIds: [clusterId],
                tagKeys: removed,
              }),
            ),
          );
        }
      });

      return {
        version: 1,
        // Node pools and addons live inside the cluster and are removed with
        // it; the cluster in turn must be gone before its network.
        nuke: { dependsOn: ["Alibaba.VPC.*"] },
        // The V1 list shape is thinner than `DescribeClusterDetail`, so
        // re-read each id to emit the same attributes `read` produces.
        list: () =>
          listClusters().pipe(
            Effect.flatMap(
              Effect.forEach(
                (cluster) =>
                  cluster.clusterId === undefined
                    ? Effect.succeed(undefined)
                    : getById(cluster.clusterId),
                { concurrency: 4 },
              ),
            ),
            Effect.flatMap(
              Effect.forEach(
                (cluster) =>
                  cluster === undefined
                    ? Effect.succeed([])
                    : toAttributes(cluster).pipe(
                        Effect.map((value) => [value]),
                      ),
                { concurrency: 4 },
              ),
            ),
            Effect.map((groups) => groups.flat()),
          ),
        stables: ["clusterId", "created"] as const,

        diff: Effect.fn(function* ({ olds: previous, news: input, output }) {
          if (!isResolved(input)) return undefined;
          const olds = requests(previous);
          yield* validateDesiredInput(input, ManagedCluster.Type);
          const news = requests(input);
          if (
            olds.create === undefined ||
            (news.create.vpcid !== undefined &&
              olds.create.vpcid === undefined) ||
            (news.create.vswitchIds !== undefined &&
              olds.create.vswitchIds === undefined) ||
            (news.create.podVswitchIds !== undefined &&
              olds.create.podVswitchIds === undefined)
          ) {
            return undefined;
          }
          if (
            olds.name !== news.name ||
            !isDeepStrictEqual(
              immutableCreate(createRequest(olds.create)),
              immutableCreate(createRequest(news.create)),
            )
          ) {
            return yield* replacement(
              ManagedCluster.Type,
              olds.name,
              news.name,
            );
          }
          if (output !== undefined) {
            const observed = yield* getById(output.clusterId);
            const modify = yield* sdkInput<ACK.ModifyClusterRequest>(
              news.modify,
              ManagedCluster.Type,
            );
            if (
              observed !== undefined &&
              (!modifyMatches(observed, modify) ||
                !sameVersion(observed, news.upgrade))
            )
              return { action: "update" };
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds: input, output }) {
          const olds = requests(input);
          yield* requireRegion(
            ManagedCluster.Type,
            clients.regionId,
            olds.create?.regionId,
          );
          yield* requireRegion(
            ManagedCluster.Type,
            clients.regionId,
            output?.regionId,
          );
          const name = yield* physicalName(id, olds.name ?? output?.name, 63);
          const cluster = yield* observe(output?.clusterId, name);
          if (cluster === undefined) return undefined;
          const attributes = {
            ...(yield* toAttributes(cluster)),
            connection: clusterConnection(cluster.clusterId!, {
              regionId: clients.regionId,
              ...olds.connectionOptions,
            }),
          };
          return (yield* hasAlchemyTags(id, tagRecord(cluster.tags)))
            ? attributes
            : Unowned(attributes);
        }),

        reconcile: Effect.fn(function* ({
          id,
          news: input,
          olds: previous,
          output,
          session,
        }) {
          yield* validateDesiredInput(input, ManagedCluster.Type);
          const news = requests(input);
          const olds = previous === undefined ? undefined : requests(previous);
          const create = yield* sdkInput<ACK.CreateClusterRequest>(
            news.create,
            ManagedCluster.Type,
          );
          const modify = yield* sdkInput<ACK.ModifyClusterRequest>(
            news.modify,
            ManagedCluster.Type,
          );
          yield* requireRegion(
            ManagedCluster.Type,
            clients.regionId,
            news.create.regionId,
          );
          yield* requireRegion(
            ManagedCluster.Type,
            clients.regionId,
            output?.regionId,
          );
          const addonNames = new Set(
            news.create.addons.map((addon) => addon.name),
          );
          const requestedTerway = news.create.podVswitchIds !== undefined;
          if (requestedTerway && !addonNames.has("terway-eniip")) {
            return yield* new AlibabaInvariantError({
              resourceType: ManagedCluster.Type,
              operation: "CreateCluster",
              message: "Terway networking requires the terway-eniip addon",
            });
          }
          if (!requestedTerway && !addonNames.has("flannel")) {
            return yield* new AlibabaInvariantError({
              resourceType: ManagedCluster.Type,
              operation: "CreateCluster",
              message: "Flannel networking requires the flannel addon",
            });
          }
          const name = yield* physicalName(id, news.name ?? output?.name, 63);
          const tags = yield* desiredTags(id, news.tags);
          let cluster = yield* observe(output?.clusterId, name);
          if (cluster !== undefined && output === undefined)
            yield* requireRecoveryOwnership(
              id,
              ManagedCluster.Type,
              tagRecord(cluster.tags),
            );

          if (cluster === undefined) {
            yield* session.note(`Creating ACK cluster ${name}`);
            const response = yield* sdkCall("ACK", "CreateCluster", () =>
              clients.ack.createCluster(
                new ACK.CreateClusterRequest({
                  ...create,
                  regionId: create.regionId ?? clients.regionId,
                  name,
                  tags: tagList(tags),
                }),
              ),
            );
            yield* waitForTask({
              client: clients.ack,
              operation: "CreateCluster",
              taskId: response.body?.taskId,
              wait: options.wait,
            });
            const createdId = response.body?.clusterId;
            cluster = yield* waitForPresent({
              service: "ACK",
              operation: "CreateCluster",
              read: observe(createdId, name),
              ready,
              wait: options.wait,
            });
          }

          const clusterId = yield* requireValue(
            cluster.clusterId,
            ManagedCluster.Type,
            "Reconcile",
            "ACK returned a cluster without clusterId",
          );

          if (
            news.modify !== undefined &&
            ((olds !== undefined
              ? !isDeepStrictEqual(news.modify, olds.modify)
              : Object.entries(news.modify).some(
                  ([key, value]) =>
                    value !== undefined &&
                    !(key in ACK.CreateClusterRequest.types()),
                )) ||
              !modifyMatches(cluster, modify))
          ) {
            const response = yield* sdkCall("ACK", "ModifyCluster", () =>
              clients.ack.modifyCluster(
                clusterId,
                new ACK.ModifyClusterRequest(modify),
              ),
            );
            yield* waitForTask({
              client: clients.ack,
              operation: "ModifyCluster",
              taskId: response.body?.taskId,
              wait: options.wait,
            });
          }

          if (!sameVersion(cluster, news.upgrade)) {
            yield* session.note(`Upgrading ACK cluster ${clusterId}`);
            const response = yield* sdkCall("ACK", "UpgradeCluster", () =>
              clients.ack.upgradeCluster(
                clusterId,
                new ACK.UpgradeClusterRequest(news.upgrade),
              ),
            );
            yield* waitForTask({
              client: clients.ack,
              operation: "UpgradeCluster",
              taskId: response.body?.taskId,
              wait: options.wait,
            });
          }

          yield* syncTags(
            clusterId,
            cluster.regionId ?? clients.regionId,
            tagRecord(cluster.tags),
            tags,
          );

          const fresh = yield* waitForPresent({
            service: "ACK",
            operation: "ReconcileCluster",
            read: getById(clusterId),
            ready: (value) =>
              ready(value) &&
              sameVersion(value, news.upgrade) &&
              modifyMatches(value, modify) &&
              tagsEqual(tagRecord(value.tags), tags),
            wait: options.wait,
          });
          return {
            ...(yield* toAttributes(fresh)),
            connection: clusterConnection(clusterId, {
              regionId: clients.regionId,
              ...news.connectionOptions,
            }),
          };
        }),

        delete: Effect.fn(function* ({ output, olds: input }) {
          const olds = requests(input);
          yield* requireRegion(
            ManagedCluster.Type,
            clients.regionId,
            olds.create?.regionId,
          );
          yield* requireRegion(
            ManagedCluster.Type,
            clients.regionId,
            output.regionId,
          );
          let cluster = yield* getById(output.clusterId);
          if (cluster === undefined) return;
          if (!deleting(cluster) && cluster.deletionProtection) {
            const response = yield* requestOrContinueDelete({
              request: retryingSdkCall(
                "ACK",
                "DisableClusterDeletionProtection",
                () =>
                  clients.ack.modifyCluster(
                    output.clusterId,
                    new ACK.ModifyClusterRequest({ deletionProtection: false }),
                  ),
              ),
              read: getById(output.clusterId),
              deleting,
            });
            yield* waitForTask({
              client: clients.ack,
              operation: "DisableClusterDeletionProtection",
              taskId: response?.body?.taskId,
              wait: options.wait,
            });
            cluster = yield* getById(output.clusterId);
          }
          if (cluster !== undefined && !deleting(cluster)) {
            const response = yield* requestOrContinueDelete({
              request: retryingSdkCall("ACK", "DeleteCluster", () =>
                clients.ack.deleteCluster(
                  output.clusterId,
                  new ACK.DeleteClusterRequest(olds.delete),
                ),
              ),
              read: getById(output.clusterId),
              deleting,
            });
            yield* waitForTask({
              client: clients.ack,
              operation: "DeleteCluster",
              taskId: response?.body?.taskId,
              wait: options.wait,
            });
          }
          yield* waitForAbsent({
            service: "ACK",
            operation: "DeleteCluster",
            read: getById(output.clusterId),
            wait: options.wait,
          });
        }),
      };
    }),
  );
