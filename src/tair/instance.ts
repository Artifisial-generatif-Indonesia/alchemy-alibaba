import * as Tair from "@alicloud/r-kvstore20150101";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { hasAlchemyTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AlibabaClients } from "../clients.ts";
import {
  AlibabaObservationConflictError,
  AlibabaUnsafeLifecycleTransitionError,
  isAmbiguousCreate,
  isIncorrectInstanceState,
  isNotFound,
  isTransient,
  retryingSdkCall,
  sdkCall,
} from "../error.ts";
import {
  desiredTags,
  paginate,
  physicalName,
  requireValue,
  requestOrContinueDelete,
  tagsEqual,
  userTags,
  waitFor,
  waitForPresent,
  waitUntilAccepted,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Without } from "../internal/model-input.ts";
import type { Providers } from "../providers.ts";

export interface InstanceProps {
  readonly name?: string;
  readonly create: Without<
    Tair.CreateInstanceRequest,
    "instanceName" | "password" | "tag"
  >;
  readonly password?: Redacted.Redacted<string>;
  readonly releaseProtection?: boolean;
  readonly spec?: Without<Tair.ModifyInstanceSpecRequest, "instanceId">;
  readonly ssl?: "Enable" | "Disable";
  /** Redis maxmemory policy. Queue-backed workloads require noeviction. */
  readonly evictionPolicy?:
    | "noeviction"
    | "allkeys-lru"
    | "allkeys-lfu"
    | "allkeys-random"
    | "volatile-lru"
    | "volatile-lfu"
    | "volatile-random"
    | "volatile-ttl";
  /** Whether VPC clients must authenticate to Tair. */
  readonly vpcAuthMode?: "Open" | "Close";
  readonly delete?: Without<Tair.DeleteInstanceRequest, "instanceId">;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface InstanceAttributes {
  readonly instanceId: string;
  readonly name: string;
  readonly status: string;
  readonly instanceClass?: string;
  readonly instanceType?: string;
  readonly architectureType?: string;
  readonly engine?: string;
  readonly engineVersion?: string;
  readonly connectionDomain?: string;
  readonly port?: number;
  readonly privateIp?: string;
  readonly regionId?: string;
  readonly zoneId?: string;
  readonly secondaryZoneId?: string;
  readonly vpcId?: string;
  readonly vswitchId?: string;
  readonly resourceGroupId?: string;
  readonly chargeType?: string;
  readonly storage?: string;
  readonly storageType?: string;
  readonly shardCount?: number;
  readonly replicaCount?: number;
  readonly releaseProtection: boolean;
  readonly ssl: "Enable" | "Disable" | "Unknown";
  readonly evictionPolicy?: string;
  readonly vpcAuthMode?: string;
  readonly sslExpiresAt?: string;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly tags: Readonly<Record<string, string>>;
}

export type Instance = Resource<
  "Alibaba.Tair.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

export const Instance = Resource<Instance>("Alibaba.Tair.Instance");

type ObservedInstance =
  Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttribute;

const tagRecord = (
  tags:
    | Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttributeTags
    | undefined,
) =>
  Object.fromEntries(
    (tags?.tag ?? []).flatMap((tag) =>
      tag.key === undefined || tag.value === undefined
        ? []
        : [[tag.key, tag.value] as const],
    ),
  );

const tagList = (tags: Readonly<Record<string, string>>) =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));

const specMatches = (instance: ObservedInstance, spec: InstanceProps["spec"]) =>
  spec === undefined ||
  ((spec.instanceClass === undefined ||
    spec.instanceClass === instance.instanceClass) &&
    (spec.majorVersion === undefined ||
      spec.majorVersion === instance.engineVersion) &&
    (spec.nodeType === undefined || spec.nodeType === instance.nodeType) &&
    (spec.readOnlyCount === undefined ||
      spec.readOnlyCount === instance.readOnlyCount) &&
    (spec.replicaCount === undefined ||
      spec.replicaCount === instance.replicaCount) &&
    (spec.shardCount === undefined ||
      spec.shardCount === instance.shardCount) &&
    (spec.slaveReadOnlyCount === undefined ||
      spec.slaveReadOnlyCount === instance.slaveReadOnlyCount) &&
    (spec.slaveReplicaCount === undefined ||
      spec.slaveReplicaCount === instance.slaveReplicaCount) &&
    (spec.secondaryZoneId === undefined ||
      spec.secondaryZoneId === instance.secondaryZoneId) &&
    (spec.storage === undefined || String(spec.storage) === instance.storage) &&
    (spec.storageType === undefined ||
      spec.storageType === instance.storageType));

/**
 * Alibaba requires a distinct ClientToken for distinct ModifyInstanceSpec
 * requests. Hash both the Alchemy resource generation and the requested spec
 * so retries remain idempotent while a later resize cannot replay an older
 * operation. The fixed prefix plus SHA-256 digest stays below the 64-byte API
 * limit.
 */
const specClientToken = (
  resourceInstanceId: string,
  spec: InstanceProps["spec"],
): string =>
  `spec-${createHash("sha256")
    .update(JSON.stringify({ resourceInstanceId, spec }))
    .digest("hex")
    .slice(0, 56)}`;

const ready = (instance: ObservedInstance) => {
  const status = instance.instanceStatus?.toLowerCase();
  return status === "normal" || status === "running";
};

const deleting = (instance: ObservedInstance) => {
  const status = instance.instanceStatus?.toLowerCase();
  return status === "deleting" || status === "releasing";
};

const releasedStatus = (status: string | undefined) =>
  status?.toLowerCase() === "released";

type TairApiPresence = Data.TaggedEnum<{
  Absent: Record<never, never>;
  Visible: {
    /** Overview still sees the instance, but detail reads are inconsistent. */
    readonly instanceId: string;
    readonly name: string;
  };
  Released: {
    readonly instanceId: string;
    readonly name: string;
    readonly vpcId?: string;
    readonly vSwitchId?: string;
  };
  Live: {
    readonly instanceId: string;
    readonly name: string;
    readonly raw: ObservedInstance;
  };
}>;

const TairApiPresence = Data.taggedEnum<TairApiPresence>();

const withIdentity = (
  instance: ObservedInstance,
  fallbackId?: string,
  fallbackName?: string,
): ObservedInstance | undefined => {
  const instanceId = instance.instanceId ?? fallbackId;
  const instanceName = instance.instanceName ?? fallbackName;
  if (instanceId === undefined || instanceName === undefined) return undefined;
  return new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttribute(
    { ...instance, instanceId, instanceName },
  );
};

const endpointReady = (
  instance: ObservedInstance,
  desired: InstanceProps["create"],
) =>
  desired.networkType !== "VPC" ||
  (typeof instance.connectionDomain === "string" &&
    typeof instance.port === "number");

const evictionPolicyFromConfig = (config: string | undefined) => {
  if (config === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(config);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const values = parsed as Readonly<Record<string, unknown>>;
    const value = values["maxmemory-policy"] ?? values.EvictionPolicy;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
};

export interface InstanceProviderOptions {
  readonly wait?: WaitOptions;
  /** Bounded name observation after an ambiguous tokenized create response. */
  readonly createRecoveryWait?: WaitOptions;
}

export const InstanceProvider = (options: InstanceProviderOptions = {}) =>
  Provider.effect(
    Instance,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const createRequest = (create: InstanceProps["create"]) => ({
        ...create,
        regionId: create.regionId ?? clients.regionId,
      });

      const getById = (instanceId: string, fallbackName?: string) =>
        retryingSdkCall("Tair", "DescribeInstanceAttribute", () =>
          clients.tair.describeInstanceAttribute(
            new Tair.DescribeInstanceAttributeRequest({ instanceId }),
          ),
        ).pipe(
          Effect.map((response) => {
            const instance = response.body?.instances?.DBInstanceAttribute?.[0];
            return instance === undefined
              ? undefined
              : (withIdentity(instance, instanceId, fallbackName) ??
                  new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttribute(
                    {
                      ...instance,
                      instanceId,
                      instanceName: instance.instanceName ?? fallbackName,
                    },
                  ));
          }),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );

      /**
       * Every Tair instance in the configured region.
       *
       * `regionId` is explicit: the request parameter — not the client's
       * endpoint — is what scopes the query, and an unscoped inventory could
       * surface a same-named instance from another region.
       */
      const listInstances = () =>
        paginate({
          service: "Tair",
          operation: "DescribeInstances",
          page: ({ pageNumber, pageSize }) =>
            retryingSdkCall("Tair", "DescribeInstances", () =>
              clients.tair.describeInstances(
                new Tair.DescribeInstancesRequest({
                  regionId: clients.regionId,
                  pageNumber,
                  pageSize,
                }),
              ),
            ).pipe(
              Effect.map((response) => ({
                items: response.body?.instances?.KVStoreInstance ?? [],
                totalCount: response.body?.totalCount,
              })),
              Effect.catchIf(isNotFound, () =>
                Effect.succeed({
                  items: [] as Tair.DescribeInstancesResponseBodyInstancesKVStoreInstance[],
                }),
              ),
            ),
        });

      const findByName = Effect.fn(function* (name: string) {
        const instances = yield* listInstances();
        const match = instances.find((item) => item.instanceName === name);
        return match?.instanceId === undefined
          ? undefined
          : yield* getById(match.instanceId, name);
      });

      const listOverview = (request: {
        readonly instanceIds?: string;
        readonly searchKey?: string;
      }) =>
        retryingSdkCall("Tair", "DescribeInstancesOverview", () =>
          clients.tair.describeInstancesOverview(
            new Tair.DescribeInstancesOverviewRequest({
              regionId: clients.regionId,
              instanceIds: request.instanceIds,
              searchKey: request.searchKey,
            }),
          ),
        ).pipe(
          Effect.map((response) => response.body?.instances ?? []),
          Effect.catchIf(isNotFound, () => Effect.succeed([])),
        );

      const presenceFromOverview = (
        items: readonly Tair.DescribeInstancesOverviewResponseBodyInstances[],
        instanceId?: string,
        name?: string,
      ): TairApiPresence => {
        const match = items.find(
          (item) =>
            item.instanceId === instanceId ||
            (name !== undefined && item.instanceName === name),
        );
        if (match?.instanceId === undefined) return TairApiPresence.Absent();
        const observedName = match.instanceName ?? name ?? match.instanceId;
        if (!releasedStatus(match.instanceStatus)) {
          return TairApiPresence.Visible({
            instanceId: match.instanceId,
            name: observedName,
          });
        }
        return TairApiPresence.Released({
          instanceId: match.instanceId,
          name: observedName,
          vpcId: match.vpcId,
          vSwitchId: match.vSwitchId,
        });
      };

      const observe = (instanceId: string | undefined, name: string) =>
        instanceId === undefined
          ? findByName(name)
          : getById(instanceId, name).pipe(
              Effect.flatMap((instance) =>
                instance === undefined
                  ? findByName(name)
                  : Effect.succeed(instance),
              ),
            );

      const observePresence = (instanceId: string | undefined, name: string) =>
        Effect.gen(function* () {
          const overview = yield* listOverview(
            instanceId === undefined
              ? { searchKey: name }
              : { instanceIds: instanceId },
          );
          const overviewPresence = presenceFromOverview(
            overview,
            instanceId,
            name,
          );
          if (TairApiPresence.$is("Released")(overviewPresence)) {
            return overviewPresence;
          }
          const live = yield* observe(instanceId, name);
          if (live?.instanceId === undefined) {
            return presenceFromOverview(overview, instanceId, name);
          }
          return TairApiPresence.Live({
            instanceId: live.instanceId,
            name: live.instanceName ?? name,
            raw: live,
          });
        });

      const getSsl = (instanceId: string) =>
        retryingSdkCall("Tair", "DescribeInstanceSSL", () =>
          clients.tair.describeInstanceSSL(
            new Tair.DescribeInstanceSSLRequest({ instanceId }),
          ),
        ).pipe(Effect.map((response) => response.body));

      const getConfig = (instanceId: string) =>
        retryingSdkCall("Tair", "DescribeInstanceConfig", () =>
          clients.tair.describeInstanceConfig(
            new Tair.DescribeInstanceConfigRequest({ instanceId }),
          ),
        ).pipe(Effect.map((response) => response.body));

      const toAttributes = Effect.fn(function* (instance: ObservedInstance) {
        const instanceId = yield* requireValue(
          instance.instanceId,
          Instance.Type,
          "DescribeInstanceAttribute",
          "Tair returned an instance without instanceId",
        );
        const name = yield* requireValue(
          instance.instanceName,
          Instance.Type,
          "DescribeInstanceAttribute",
          "Tair returned an instance without instanceName",
        );
        const ssl = yield* getSsl(instanceId).pipe(
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
        const config = yield* getConfig(instanceId).pipe(
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
        const sslState = ssl?.SSLEnabled;
        return {
          instanceId,
          name,
          status: instance.instanceStatus ?? "Unknown",
          instanceClass: instance.instanceClass,
          instanceType: instance.instanceType,
          architectureType: instance.architectureType,
          engine: instance.engine,
          engineVersion: instance.engineVersion,
          connectionDomain: instance.connectionDomain,
          port: instance.port,
          privateIp: instance.privateIp,
          regionId: instance.regionId,
          zoneId: instance.zoneId,
          secondaryZoneId: instance.secondaryZoneId,
          vpcId: instance.vpcId,
          vswitchId: instance.vSwitchId,
          resourceGroupId: instance.resourceGroupId,
          chargeType: instance.chargeType,
          storage: instance.storage,
          storageType: instance.storageType,
          shardCount: instance.shardCount,
          replicaCount: instance.replicaCount,
          releaseProtection: instance.instanceReleaseProtection ?? false,
          ssl:
            sslState === "Enable" || sslState === "Disable"
              ? sslState
              : "Unknown",
          evictionPolicy: evictionPolicyFromConfig(config?.config),
          vpcAuthMode: instance.vpcAuthMode,
          sslExpiresAt: ssl?.SSLExpiredTime,
          createdAt: instance.createTime,
          expiresAt: instance.endTime,
          tags: userTags(tagRecord(instance.tags)),
        } satisfies InstanceAttributes;
      });

      const syncTags = Effect.fn(function* (
        instanceId: string,
        observed: Readonly<Record<string, string>>,
        desired: Readonly<Record<string, string>>,
      ) {
        if (tagsEqual(observed, desired)) return;
        const upsert = Object.fromEntries(
          Object.entries(desired).filter(
            ([key, value]) => observed[key] !== value,
          ),
        );
        const removed = Object.keys(observed).filter(
          (key) => !(key in desired),
        );
        if (Object.keys(upsert).length > 0) {
          yield* retryingSdkCall("Tair", "TagResources", () =>
            clients.tair.tagResources(
              new Tair.TagResourcesRequest({
                regionId: clients.regionId,
                resourceType: "INSTANCE",
                resourceId: [instanceId],
                tag: tagList(upsert),
              }),
            ),
          );
        }
        if (removed.length > 0) {
          yield* retryingSdkCall("Tair", "UntagResources", () =>
            clients.tair.untagResources(
              new Tair.UntagResourcesRequest({
                all: false,
                regionId: clients.regionId,
                resourceType: "INSTANCE",
                resourceId: [instanceId],
                tagKey: removed,
              }),
            ),
          );
        }
      });

      return {
        version: 1,
        stables: ["instanceId", "createdAt"] as const,
        // Accounts and IP groups are keyed entirely by their instance and go
        // with it. Tair's teardown is what holds the vSwitch (its hidden
        // relation surfaces as `DependencyViolation.Kvstore`), so it must be
        // fully released before the subnet is touched.
        nuke: { dependsOn: ["Alibaba.VPC.*"] },
        list: () =>
          listInstances().pipe(
            Effect.flatMap(
              Effect.forEach(
                (instance) =>
                  instance.instanceId === undefined
                    ? Effect.succeed(undefined)
                    : getById(instance.instanceId, instance.instanceName),
                { concurrency: 4 },
              ),
            ),
            Effect.flatMap(
              Effect.forEach(
                (instance) =>
                  instance === undefined
                    ? Effect.succeed([])
                    : toAttributes(instance).pipe(
                        Effect.map((value) => [value]),
                      ),
                { concurrency: 4 },
              ),
            ),
            Effect.map((groups) => groups.flat()),
          ),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds.create === undefined ||
            (news.create.vpcId !== undefined &&
              olds.create.vpcId === undefined) ||
            (news.create.vSwitchId !== undefined &&
              olds.create.vSwitchId === undefined)
          ) {
            return undefined;
          }
          return olds.name !== news.name ||
            !isDeepStrictEqual(
              createRequest(olds.create),
              createRequest(news.create),
            )
            ? ({ action: "replace" } as const)
            : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = yield* physicalName(id, olds.name ?? output?.name, 80);
          const instance = yield* observe(output?.instanceId, name);
          if (instance === undefined) return undefined;
          const attributes = yield* toAttributes(instance);
          return (yield* hasAlchemyTags(id, tagRecord(instance.tags)))
            ? attributes
            : Unowned(attributes);
        }),
        reconcile: Effect.fn(function* ({
          id,
          instanceId: resourceInstanceId,
          news,
          olds,
          output,
        }) {
          const name = yield* physicalName(id, news.name ?? output?.name, 80);
          const tags = yield* desiredTags(id, news.tags);
          let instance = yield* observe(output?.instanceId, name);
          const creating = instance === undefined;
          if (instance === undefined) {
            const creation = yield* retryingSdkCall(
              "Tair",
              "CreateInstance",
              () =>
                clients.tair.createInstance(
                  new Tair.CreateInstanceRequest({
                    ...createRequest(news.create),
                    instanceName: name,
                    password:
                      news.password === undefined
                        ? undefined
                        : Redacted.value(news.password),
                    tag: tagList(tags),
                    token: news.create.token ?? `create-${resourceInstanceId}`,
                  }),
                ),
            ).pipe(
              Effect.map(
                (response) => ({ _tag: "Requested", response }) as const,
              ),
              Effect.catchIf(isAmbiguousCreate, (requestError) =>
                waitForPresent({
                  service: "Tair",
                  operation: "RecoverCreateInstance",
                  read: observe(undefined, name),
                  // Presence proves the tokenized request was accepted. The
                  // ordinary readiness waiter below still requires Normal.
                  ready: () => true,
                  wait: options.createRecoveryWait ?? {
                    attempts: 13,
                    interval: "5 seconds",
                  },
                }).pipe(
                  Effect.map(
                    (instance) => ({ _tag: "Observed", instance }) as const,
                  ),
                  Effect.catchTag("AlibabaWaitTimeoutError", () =>
                    Effect.fail(requestError),
                  ),
                ),
              ),
            );
            const createdInstanceId =
              creation._tag === "Observed"
                ? creation.instance.instanceId
                : creation.response.body?.instanceId;
            instance = yield* waitForPresent({
              service: "Tair",
              operation: "CreateInstance",
              read: observe(createdInstanceId, name),
              ready,
              wait: options.wait,
            });
          }
          const instanceId = yield* requireValue(
            instance.instanceId,
            Instance.Type,
            "Reconcile",
            "Tair returned an instance without instanceId",
          );

          const waitUntilNormal = () =>
            waitForPresent({
              service: "Tair",
              operation: "WaitInstanceReady",
              read: getById(instanceId, name),
              ready,
              wait: options.wait,
            });

          const requestMutation = <Result>(
            operation: string,
            call: () => Promise<Result>,
          ) =>
            waitUntilAccepted({
              service: "Tair",
              operation,
              request: sdkCall("Tair", operation, call),
              retryIf: (error) =>
                isIncorrectInstanceState(error) || isTransient(error),
              wait: options.wait,
            });

          if (
            !creating &&
            news.password !== undefined &&
            (olds === undefined || !Equal.equals(olds.password, news.password))
          ) {
            const password = Redacted.value(news.password);
            yield* requestMutation("ResetDefaultAccountPassword", () =>
              clients.tair.resetAccountPassword(
                new Tair.ResetAccountPasswordRequest({
                  instanceId,
                  accountName: instanceId,
                  accountPassword: password,
                }),
              ),
            );
            yield* waitUntilNormal();
          }

          if (
            instance.instanceName !== name ||
            instance.instanceReleaseProtection !==
              (news.releaseProtection ?? false)
          ) {
            yield* requestMutation("ModifyInstanceAttribute", () =>
              clients.tair.modifyInstanceAttribute(
                new Tair.ModifyInstanceAttributeRequest({
                  instanceId,
                  instanceName: name,
                  instanceReleaseProtection: news.releaseProtection ?? false,
                }),
              ),
            );
            yield* waitUntilNormal();
          }
          if (!specMatches(instance, news.spec)) {
            yield* requestMutation("ModifyInstanceSpec", () =>
              clients.tair.modifyInstanceSpec(
                new Tair.ModifyInstanceSpecRequest({
                  ...news.spec,
                  instanceId,
                  clientToken:
                    news.spec?.clientToken ??
                    specClientToken(resourceInstanceId, news.spec),
                }),
              ),
            );
            yield* waitUntilNormal();
          }
          const observedSsl = yield* getSsl(instanceId).pipe(
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
          if (news.ssl !== undefined && news.ssl !== observedSsl?.SSLEnabled) {
            yield* requestMutation("ModifyInstanceSSL", () =>
              clients.tair.modifyInstanceSSL(
                new Tair.ModifyInstanceSSLRequest({
                  instanceId,
                  SSLEnabled: news.ssl,
                }),
              ),
            );
            yield* waitForPresent({
              service: "Tair",
              operation: "ModifyInstanceSSL",
              read: getSsl(instanceId).pipe(
                Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
              ),
              ready: (value) => value.SSLEnabled === news.ssl,
              wait: options.wait,
            });
            yield* waitUntilNormal();
          }
          instance = yield* waitUntilNormal();
          if (
            news.vpcAuthMode !== undefined &&
            news.vpcAuthMode !== instance.vpcAuthMode
          ) {
            yield* requestMutation("ModifyInstanceVpcAuthMode", () =>
              clients.tair.modifyInstanceVpcAuthMode(
                new Tair.ModifyInstanceVpcAuthModeRequest({
                  instanceId,
                  vpcAuthMode: news.vpcAuthMode,
                }),
              ),
            );
            yield* waitUntilNormal();
          }
          const observedConfig = yield* getConfig(instanceId).pipe(
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
          if (
            news.evictionPolicy !== undefined &&
            news.evictionPolicy !==
              evictionPolicyFromConfig(observedConfig?.config)
          ) {
            yield* requestMutation("ModifyInstanceConfig", () =>
              clients.tair.modifyInstanceConfig(
                new Tair.ModifyInstanceConfigRequest({
                  instanceId,
                  config: JSON.stringify({
                    "maxmemory-policy": news.evictionPolicy,
                  }),
                }),
              ),
            );
            yield* waitForPresent({
              service: "Tair",
              operation: "ModifyInstanceConfig",
              read: getConfig(instanceId).pipe(
                Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
              ),
              ready: (value) =>
                evictionPolicyFromConfig(value.config) === news.evictionPolicy,
              wait: options.wait,
            });
            yield* waitUntilNormal();
          }
          yield* syncTags(instanceId, tagRecord(instance.tags), tags);

          const fresh = yield* waitForPresent({
            service: "Tair",
            operation: "ReconcileInstance",
            read: getById(instanceId),
            ready: (value) =>
              ready(value) &&
              endpointReady(value, news.create) &&
              specMatches(value, news.spec) &&
              value.instanceReleaseProtection ===
                (news.releaseProtection ?? false) &&
              (news.vpcAuthMode === undefined ||
                value.vpcAuthMode === news.vpcAuthMode) &&
              tagsEqual(tagRecord(value.tags), tags),
            wait: options.wait,
          });
          return yield* toAttributes(fresh);
        }),
        delete: Effect.fn(function* ({ output, olds }) {
          const name = output.name;
          const observeForDelete = () =>
            waitFor({
              service: "Tair",
              resourceType: Instance.Type,
              operation: "ObserveInstanceForDelete",
              read: observePresence(output.instanceId, name),
              ready: (value) => !TairApiPresence.$is("Visible")(value),
              describe: (value) => value._tag,
              wait: options.wait,
            }).pipe(
              Effect.catchTag("AlibabaWaitTimeoutError", (error) =>
                Effect.fail(
                  new AlibabaObservationConflictError({
                    service: "Tair",
                    resourceType: Instance.Type,
                    operation: error.operation,
                    resourceId: output.instanceId,
                    observations: [
                      "DescribeInstancesOverview:visible",
                      "DescribeInstanceAttribute:absent",
                      "DescribeInstances:absent",
                    ],
                    attempts: error.attempts,
                    message:
                      "Tair inventory APIs remained contradictory; refusing to advance deletion",
                  }),
                ),
              ),
            );
          let presence = yield* observeForDelete();
          if (TairApiPresence.$is("Absent")(presence)) return;
          if (TairApiPresence.$is("Live")(presence)) {
            if (
              !deleting(presence.raw) &&
              presence.raw.instanceReleaseProtection
            ) {
              yield* requestOrContinueDelete({
                request: retryingSdkCall(
                  "Tair",
                  "DisableReleaseProtection",
                  () =>
                    clients.tair.modifyInstanceAttribute(
                      new Tair.ModifyInstanceAttributeRequest({
                        instanceId: output.instanceId,
                        instanceReleaseProtection: false,
                      }),
                    ),
                ),
                read: getById(output.instanceId, name),
                deleting,
              });
              presence = yield* observeForDelete();
            }
            if (
              TairApiPresence.$is("Live")(presence) &&
              !deleting(presence.raw) &&
              !releasedStatus(presence.raw.instanceStatus)
            ) {
              yield* requestOrContinueDelete({
                request: retryingSdkCall("Tair", "DeleteInstance", () =>
                  clients.tair.deleteInstance(
                    new Tair.DeleteInstanceRequest({
                      ...olds.delete,
                      instanceId: output.instanceId,
                    }),
                  ),
                ),
                read: observePresence(output.instanceId, name).pipe(
                  Effect.map((value) =>
                    TairApiPresence.$is("Live")(value) ? value.raw : undefined,
                  ),
                ),
                deleting: (value) =>
                  deleting(value) || releasedStatus(value.instanceStatus),
              });
            }
            presence = yield* waitFor({
              service: "Tair",
              resourceType: Instance.Type,
              operation: "ReleaseInstance",
              read: observePresence(output.instanceId, name),
              ready: (value) =>
                TairApiPresence.$is("Released")(value) ||
                TairApiPresence.$is("Absent")(value),
              describe: (value) => value._tag,
              wait: options.wait,
            });
          }
          if (TairApiPresence.$is("Visible")(presence)) {
            return yield* new AlibabaUnsafeLifecycleTransitionError({
              resourceType: Instance.Type,
              operation: "DestroyInstance",
              resourceId: output.instanceId,
              fromState: presence._tag,
              allowedStates: ["Released", "Absent"],
              message:
                "Refusing permanent Tair destruction while inventory observations conflict",
            });
          }
          if (TairApiPresence.$is("Live")(presence)) {
            return yield* new AlibabaUnsafeLifecycleTransitionError({
              resourceType: Instance.Type,
              operation: "DestroyInstance",
              resourceId: output.instanceId,
              fromState: presence._tag,
              allowedStates: ["Released", "Absent"],
              message:
                "Refusing permanent Tair destruction before release is observed",
            });
          }
          if (TairApiPresence.$is("Released")(presence)) {
            yield* retryingSdkCall("Tair", "DestroyInstance", () =>
              clients.tair.destroyInstance(
                new Tair.DestroyInstanceRequest({
                  instanceId: presence.instanceId,
                }),
              ),
            ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          }
          yield* waitFor({
            service: "Tair",
            resourceType: Instance.Type,
            operation: "DestroyInstance",
            read: observePresence(output.instanceId, name),
            ready: TairApiPresence.$is("Absent"),
            describe: (value) => value._tag,
            wait: options.wait,
          });
        }),
      };
    }),
  );
