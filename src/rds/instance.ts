import * as RDS from "@alicloud/rds20140815";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { hasAlchemyTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isDeepStrictEqual } from "node:util";
import { AlibabaClients } from "../clients.ts";
import {
  AlibabaWaitTimeoutError,
  type AlibabaProviderError,
  isAmbiguousCreate,
  isNotFound,
  isTransient,
  retryingSdkCall,
  sdkCall,
} from "../error.ts";
import {
  desiredTags,
  observeUntil,
  paginate,
  physicalName,
  requireValue,
  tagsEqual,
  userTags,
  waitFor,
  waitForAbsent,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Without } from "../internal/model-input.ts";
import type { Providers } from "../providers.ts";

type RDSInstanceCreateRequest = Without<
  RDS.CreateDBInstanceRequest,
  "DBInstanceDescription" | "tag"
>;

export type RDSInstanceCreate = Omit<
  RDSInstanceCreateRequest,
  | "DBInstanceClass"
  | "DBInstanceNetType"
  | "DBInstanceStorage"
  | "engine"
  | "engineVersion"
  | "payType"
  | "securityIPList"
> & {
  /** Required by CreateDBInstance. */
  readonly DBInstanceClass: string;
  /** Alibaba currently requires the fixed Intranet value. */
  readonly DBInstanceNetType: "Intranet";
  /** Required by CreateDBInstance, in GiB. */
  readonly DBInstanceStorage: number;
  readonly engine: "MySQL" | "SQLServer" | "PostgreSQL" | "MariaDB";
  readonly engineVersion: string;
  readonly payType: "Postpaid" | "Prepaid" | "Serverless";
  /** Required initial whitelist. */
  readonly securityIPList: string;
};

export interface InstanceProps {
  readonly name?: string;
  readonly create: RDSInstanceCreate;
  readonly deletionProtection?: boolean;
  readonly spec?: Without<RDS.ModifyDBInstanceSpecRequest, "DBInstanceId">;
  readonly ssl?: Without<
    RDS.ModifyDBInstanceSSLRequest,
    "DBInstanceId" | "passWord" | "serverKey"
  >;
  readonly sslPassword?: Redacted.Redacted<string>;
  readonly sslServerKey?: Redacted.Redacted<string>;
  readonly delete?: Without<RDS.DeleteDBInstanceRequest, "DBInstanceId">;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface InstanceAttributes {
  readonly instanceId: string;
  readonly name: string;
  readonly status: string;
  readonly instanceClass?: string;
  readonly instanceType?: string;
  readonly category?: string;
  readonly engine?: string;
  readonly engineVersion?: string;
  readonly storage?: number;
  readonly storageType?: string;
  readonly connectionString?: string;
  readonly privateIp?: string;
  readonly port?: string;
  readonly regionId?: string;
  readonly zoneId?: string;
  readonly vpcId?: string;
  readonly vswitchId?: string;
  readonly resourceGroupId?: string;
  readonly payType?: string;
  readonly deletionProtection: boolean;
  readonly sslEnabled?: string;
  readonly sslExpiresAt?: string;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly tags: Readonly<Record<string, string>>;
}

export type Instance = Resource<
  "Alibaba.RDS.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

export const Instance = Resource<Instance>("Alibaba.RDS.Instance");

type ObservedInstance =
  RDS.DescribeDBInstanceAttributeResponseBodyItemsDBInstanceAttribute;

const tagList = (tags: Readonly<Record<string, string>>) =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));

const ready = (instance: ObservedInstance) => {
  const status = instance.DBInstanceStatus?.toLowerCase();
  return status === "running" || status === "normal";
};

const deleting = (instance: ObservedInstance) =>
  instance.DBInstanceStatus?.toLowerCase() === "deleting";

const creating = (instance: ObservedInstance) =>
  instance.DBInstanceStatus?.toLowerCase() === "creating";

const retryableDeleteState = (error: AlibabaProviderError) =>
  error.code === "IncorrectDBInstanceState" || isTransient(error);

type ObservedSsl = RDS.DescribeDBInstanceSSLResponseBody | undefined;
type ObservedNetwork =
  RDS.DescribeDBInstanceNetInfoResponseBodyDBInstanceNetInfosDBInstanceNetInfo;

const sslEnabledMatches = (
  observed: string | undefined,
  desired: number | undefined,
) => {
  if (desired === undefined) return true;
  const enabled = ["1", "on", "yes", "enable", "enabled", "true"].includes(
    observed?.toLowerCase() ?? "",
  );
  return enabled === (desired === 1);
};

const sslMatches = (ssl: ObservedSsl, desired: InstanceProps["ssl"]) =>
  desired === undefined ||
  (sslEnabledMatches(ssl?.SSLEnabled, desired.SSLEnabled) &&
    (desired.connectionString === undefined ||
      desired.connectionString === ssl?.connectionString) &&
    (desired.CAType === undefined || desired.CAType === ssl?.CAType) &&
    (desired.tlsVersion === undefined ||
      desired.tlsVersion === ssl?.tlsVersion));

const specMatches = (instance: ObservedInstance, spec: InstanceProps["spec"]) =>
  spec === undefined ||
  ((spec.DBInstanceClass === undefined ||
    spec.DBInstanceClass === instance.DBInstanceClass) &&
    (spec.DBInstanceStorage === undefined ||
      spec.DBInstanceStorage === instance.DBInstanceStorage) &&
    (spec.DBInstanceStorageType === undefined ||
      spec.DBInstanceStorageType === instance.DBInstanceStorageType) &&
    (spec.engineVersion === undefined ||
      spec.engineVersion === instance.engineVersion) &&
    (spec.category === undefined || spec.category === instance.category));

export interface InstanceProviderOptions {
  readonly wait?: WaitOptions;
  /** Bounded name observation after an ambiguous tokenized create response. */
  readonly createRecoveryWait?: WaitOptions;
  /** Bounded wait until the RDS control plane accepts deletion. */
  readonly deleteRequestWait?: WaitOptions;
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

      const getById = (instanceId: string) =>
        retryingSdkCall("RDS", "DescribeDBInstanceAttribute", () =>
          clients.rds.describeDBInstanceAttribute(
            new RDS.DescribeDBInstanceAttributeRequest({
              DBInstanceId: instanceId,
            }),
          ),
        ).pipe(
          Effect.map(
            (response) => response.body?.items?.DBInstanceAttribute?.[0],
          ),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );

      const findByName = (name: string) =>
        retryingSdkCall("RDS", "DescribeDBInstances", () =>
          clients.rds.describeDBInstances(
            new RDS.DescribeDBInstancesRequest({
              searchKey: name,
              pageNumber: 1,
              pageSize: 100,
            }),
          ),
        ).pipe(
          Effect.map(
            (response) =>
              response.body?.items?.DBInstance?.find(
                (instance) => instance.DBInstanceDescription === name,
              )?.DBInstanceId,
          ),
          Effect.flatMap((instanceId) =>
            instanceId === undefined
              ? Effect.succeed(undefined)
              : getById(instanceId),
          ),
        );

      const observe = (instanceId: string | undefined, name: string) =>
        instanceId === undefined
          ? findByName(name)
          : getById(instanceId).pipe(
              Effect.flatMap((instance) =>
                instance === undefined
                  ? findByName(name)
                  : Effect.succeed(instance),
              ),
            );

      const getTags = (instanceId: string) =>
        retryingSdkCall("RDS", "ListTagResources", () =>
          clients.rds.listTagResources(
            new RDS.ListTagResourcesRequest({
              regionId: clients.regionId,
              resourceType: "INSTANCE",
              resourceId: [instanceId],
            }),
          ),
        ).pipe(
          Effect.map((response) =>
            Object.fromEntries(
              (response.body?.tagResources?.tagResource ?? []).flatMap((tag) =>
                tag.tagKey === undefined || tag.tagValue === undefined
                  ? []
                  : [[tag.tagKey, tag.tagValue] as const],
              ),
            ),
          ),
        );

      const getSsl = (instanceId: string) =>
        retryingSdkCall("RDS", "DescribeDBInstanceSSL", () =>
          clients.rds.describeDBInstanceSSL(
            new RDS.DescribeDBInstanceSSLRequest({ DBInstanceId: instanceId }),
          ),
        ).pipe(
          Effect.map((response) => response.body),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );

      const getNetwork = (instanceId: string) =>
        retryingSdkCall("RDS", "DescribeDBInstanceNetInfo", () =>
          clients.rds.describeDBInstanceNetInfo(
            new RDS.DescribeDBInstanceNetInfoRequest({
              DBInstanceId: instanceId,
            }),
          ),
        ).pipe(
          Effect.map((response) => {
            const endpoints =
              response.body?.DBInstanceNetInfos?.DBInstanceNetInfo ?? [];
            return (
              endpoints.find(
                (endpoint) =>
                  endpoint.connectionStringType === "Normal" &&
                  endpoint.IPType === "Private",
              ) ??
              endpoints.find(
                (endpoint) =>
                  endpoint.connectionStringType === "Normal" &&
                  endpoint.IPType === "Inner",
              )
            );
          }),
          Effect.catchIf(isNotFound, () =>
            Effect.succeed<ObservedNetwork | undefined>(undefined),
          ),
        );

      const toAttributes = Effect.fn(function* (instance: ObservedInstance) {
        const instanceId = yield* requireValue(
          instance.DBInstanceId,
          Instance.Type,
          "DescribeDBInstanceAttribute",
          "RDS returned an instance without DBInstanceId",
        );
        const name = yield* requireValue(
          instance.DBInstanceDescription,
          Instance.Type,
          "DescribeDBInstanceAttribute",
          "RDS returned an instance without DBInstanceDescription",
        );
        const [tags, ssl, network] = yield* Effect.all([
          getTags(instanceId),
          getSsl(instanceId),
          getNetwork(instanceId),
        ]);
        return {
          instanceId,
          name,
          status: instance.DBInstanceStatus ?? "Unknown",
          instanceClass: instance.DBInstanceClass,
          instanceType: instance.DBInstanceType,
          category: instance.category,
          engine: instance.engine,
          engineVersion: instance.engineVersion,
          storage: instance.DBInstanceStorage,
          storageType: instance.DBInstanceStorageType,
          connectionString:
            network?.connectionString ?? instance.connectionString,
          privateIp: network?.IPAddress,
          port: network?.port ?? instance.port,
          regionId: instance.regionId,
          zoneId: instance.zoneId,
          vpcId: instance.vpcId,
          vswitchId: instance.vSwitchId,
          resourceGroupId: instance.resourceGroupId,
          payType: instance.payType,
          deletionProtection: instance.deletionProtection ?? false,
          sslEnabled: ssl?.SSLEnabled,
          sslExpiresAt: ssl?.SSLExpireTime,
          createdAt: instance.creationTime,
          expiresAt: instance.expireTime,
          tags: userTags(tags),
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
          yield* retryingSdkCall("RDS", "TagResources", () =>
            clients.rds.tagResources(
              new RDS.TagResourcesRequest({
                regionId: clients.regionId,
                resourceType: "INSTANCE",
                resourceId: [instanceId],
                tag: tagList(upsert),
              }),
            ),
          );
        }
        if (removed.length > 0) {
          yield* retryingSdkCall("RDS", "UntagResources", () =>
            clients.rds.untagResources(
              new RDS.UntagResourcesRequest({
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
        // Databases, accounts, privileges and IP groups are keyed entirely by
        // their instance and vanish with it, so they expose no `list` of their
        // own. Releasing the instance must still precede the subnet it sits in.
        nuke: { dependsOn: ["Alibaba.VPC.*"] },
        // `DescribeDBInstances` returns a summary shape; re-read each id so
        // the emitted attributes match `read` exactly (including SSL, private
        // endpoint and tags), which is what makes each item directly usable
        // with `delete`.
        list: () =>
          paginate({
            service: "RDS",
            operation: "DescribeDBInstances",
            page: ({ pageNumber, pageSize }) =>
              retryingSdkCall("RDS", "DescribeDBInstances", () =>
                clients.rds.describeDBInstances(
                  new RDS.DescribeDBInstancesRequest({
                    regionId: clients.regionId,
                    pageNumber,
                    pageSize,
                  }),
                ),
              ).pipe(
                Effect.map((response) => ({
                  items: (response.body?.items?.DBInstance ?? []).flatMap(
                    (item) =>
                      item.DBInstanceId === undefined ? [] : [item.DBInstanceId],
                  ),
                  totalCount: response.body?.totalRecordCount,
                })),
                Effect.catchIf(isNotFound, () =>
                  Effect.succeed({ items: [] as string[] }),
                ),
              ),
          }).pipe(
            Effect.flatMap(
              Effect.forEach((instanceId) => getById(instanceId), {
                concurrency: 4,
              }),
            ),
            // An instance released between the page read and the detail read
            // is already gone; drop it instead of failing the enumeration.
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
            (news.create.VPCId !== undefined &&
              olds.create.VPCId === undefined) ||
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
          const name = yield* physicalName(id, olds.name ?? output?.name, 64);
          const instance = yield* observe(output?.instanceId, name);
          if (instance === undefined) return undefined;
          const instanceId = yield* requireValue(
            instance.DBInstanceId,
            Instance.Type,
            "Read",
            "RDS returned an instance without DBInstanceId",
          );
          const tags = yield* getTags(instanceId);
          const attributes = yield* toAttributes(instance);
          return (yield* hasAlchemyTags(id, tags))
            ? attributes
            : Unowned(attributes);
        }),
        reconcile: Effect.fn(function* ({
          id,
          instanceId: resourceInstanceId,
          news,
          output,
        }) {
          const name = yield* physicalName(id, news.name ?? output?.name, 64);
          const tags = yield* desiredTags(id, news.tags);
          let instance = yield* observe(output?.instanceId, name);
          if (instance === undefined) {
            const creation = yield* retryingSdkCall(
              "RDS",
              "CreateDBInstance",
              () =>
                clients.rds.createDBInstance(
                  new RDS.CreateDBInstanceRequest({
                    ...createRequest(news.create),
                    DBInstanceDescription: name,
                    clientToken:
                      news.create.clientToken ?? `create-${resourceInstanceId}`,
                    tag: tagList(tags),
                  }),
                ),
            ).pipe(
              Effect.map(
                (response) => ({ _tag: "Requested", response }) as const,
              ),
              Effect.catchIf(isAmbiguousCreate, (requestError) =>
                waitForPresent({
                  service: "RDS",
                  operation: "RecoverCreateDBInstance",
                  read: observe(undefined, name),
                  // Presence proves the tokenized request was accepted. The
                  // ordinary readiness waiter below still requires Running.
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
                ? creation.instance.DBInstanceId
                : creation.response.body?.DBInstanceId?.split(",")[0];
            instance = yield* waitForPresent({
              service: "RDS",
              operation: "CreateDBInstance",
              read: observe(createdInstanceId, name),
              ready,
              wait: options.wait,
            });
          }
          const instanceId = yield* requireValue(
            instance.DBInstanceId,
            Instance.Type,
            "Reconcile",
            "RDS returned an instance without DBInstanceId",
          );
          if (instance.DBInstanceDescription !== name) {
            yield* sdkCall("RDS", "ModifyDBInstanceDescription", () =>
              clients.rds.modifyDBInstanceDescription(
                new RDS.ModifyDBInstanceDescriptionRequest({
                  DBInstanceId: instanceId,
                  DBInstanceDescription: name,
                }),
              ),
            );
          }
          const deletionProtection = news.deletionProtection ?? false;
          if (instance.deletionProtection !== deletionProtection) {
            yield* sdkCall("RDS", "ModifyDBInstanceDeletionProtection", () =>
              clients.rds.modifyDBInstanceDeletionProtection(
                new RDS.ModifyDBInstanceDeletionProtectionRequest({
                  DBInstanceId: instanceId,
                  deletionProtection,
                  // Scope the token to the resource generation AND the
                  // requested value. A token derived from the logical id alone
                  // is reused across every reconcile, so flipping protection
                  // back can match Alibaba's cached result for the earlier
                  // call and silently not apply.
                  clientToken: `protect-${resourceInstanceId}-${deletionProtection}`,
                }),
              ),
            );
          }
          if (!specMatches(instance, news.spec)) {
            yield* sdkCall("RDS", "ModifyDBInstanceSpec", () =>
              clients.rds.modifyDBInstanceSpec(
                new RDS.ModifyDBInstanceSpecRequest({
                  ...news.spec,
                  DBInstanceId: instanceId,
                }),
              ),
            );
          }
          const observedSsl = yield* getSsl(instanceId);
          if (!sslMatches(observedSsl, news.ssl)) {
            const connectionString =
              news.ssl?.connectionString ??
              (yield* requireValue(
                (yield* getNetwork(instanceId))?.connectionString,
                Instance.Type,
                "ModifyDBInstanceSSL",
                "RDS did not return the private endpoint required to configure SSL",
              ));
            yield* sdkCall("RDS", "ModifyDBInstanceSSL", () =>
              clients.rds.modifyDBInstanceSSL(
                new RDS.ModifyDBInstanceSSLRequest({
                  ...news.ssl,
                  DBInstanceId: instanceId,
                  connectionString,
                  passWord:
                    news.sslPassword === undefined
                      ? undefined
                      : Redacted.value(news.sslPassword),
                  serverKey:
                    news.sslServerKey === undefined
                      ? undefined
                      : Redacted.value(news.sslServerKey),
                }),
              ),
            );
          }
          if (news.ssl !== undefined) {
            yield* waitForPresent({
              service: "RDS",
              operation: "ModifyDBInstanceSSL",
              read: getSsl(instanceId),
              ready: (value) => sslMatches(value, news.ssl),
              wait: options.wait,
            });
          }
          yield* syncTags(instanceId, yield* getTags(instanceId), tags);
          yield* waitFor({
            service: "RDS",
            operation: "SyncDBInstanceTags",
            read: getTags(instanceId),
            ready: (value) => tagsEqual(value, tags),
            wait: options.wait,
          });
          const fresh = yield* waitForPresent({
            service: "RDS",
            operation: "ReconcileDBInstance",
            read: getById(instanceId),
            ready: (value) =>
              ready(value) &&
              specMatches(value, news.spec) &&
              value.deletionProtection === (news.deletionProtection ?? false),
            wait: options.wait,
          });
          yield* waitForPresent({
            service: "RDS",
            operation: "ReconcilePrivateEndpoint",
            read: getNetwork(instanceId),
            ready: (value) =>
              typeof value.connectionString === "string" &&
              typeof value.IPAddress === "string" &&
              typeof value.port === "string",
            wait: options.wait,
          });
          return yield* toAttributes(fresh);
        }),
        delete: Effect.fn(function* ({ output, olds }) {
          type DeleteDecision = Data.TaggedEnum<{
            Absent: Record<never, never>;
            Deleting: { readonly status: string };
            Creating: { readonly status: string };
            ProtectionDisabled: Record<never, never>;
            RetryableError: { readonly error: AlibabaProviderError };
            Accepted: Record<never, never>;
          }>;
          const DeleteDecision = Data.taggedEnum<DeleteDecision>();
          const result = yield* observeUntil({
            read: getById(output.instanceId).pipe(
              Effect.flatMap(
                (
                  instance,
                ): Effect.Effect<DeleteDecision, AlibabaProviderError> => {
                  if (instance === undefined) {
                    return Effect.succeed(DeleteDecision.Absent());
                  }
                  if (deleting(instance)) {
                    return Effect.succeed(
                      DeleteDecision.Deleting({
                        status: instance.DBInstanceStatus ?? "Unknown",
                      }),
                    );
                  }
                  // DeleteDBInstance explicitly rejects Creating. Observe until
                  // the purchase task settles instead of hammering the endpoint
                  // with a request that cannot yet succeed.
                  if (creating(instance)) {
                    return Effect.succeed(
                      DeleteDecision.Creating({
                        status: instance.DBInstanceStatus ?? "Unknown",
                      }),
                    );
                  }
                  const request = instance.deletionProtection
                    ? retryingSdkCall("RDS", "DisableDeletionProtection", () =>
                        clients.rds.modifyDBInstanceDeletionProtection(
                          new RDS.ModifyDBInstanceDeletionProtectionRequest({
                            DBInstanceId: output.instanceId,
                            deletionProtection: false,
                          }),
                        ),
                      )
                    : retryingSdkCall("RDS", "DeleteDBInstance", () =>
                        clients.rds.deleteDBInstance(
                          new RDS.DeleteDBInstanceRequest({
                            ...olds.delete,
                            DBInstanceId: output.instanceId,
                          }),
                        ),
                      );
                  return request.pipe(
                    Effect.as<DeleteDecision>(
                      instance.deletionProtection
                        ? DeleteDecision.ProtectionDisabled()
                        : DeleteDecision.Accepted(),
                    ),
                    Effect.catchIf(
                      (_error: AlibabaProviderError) => true,
                      (
                        error,
                      ): Effect.Effect<
                        DeleteDecision,
                        AlibabaProviderError
                      > => {
                        if (isNotFound(error)) {
                          return Effect.succeed(DeleteDecision.Absent());
                        }
                        if (retryableDeleteState(error)) {
                          return Effect.succeed(
                            DeleteDecision.RetryableError({ error }),
                          );
                        }
                        return Effect.fail(error);
                      },
                    ),
                  );
                },
              ),
            ),
            ready: (decision) =>
              DeleteDecision.$is("Absent")(decision) ||
              DeleteDecision.$is("Deleting")(decision) ||
              DeleteDecision.$is("Accepted")(decision),
            wait: options.deleteRequestWait ?? {
              attempts: 61,
              interval: "5 seconds",
            },
          });
          if (result._tag === "Exhausted") {
            const decision = result.value;
            if (DeleteDecision.$is("RetryableError")(decision)) {
              return yield* decision.error;
            }
            return yield* new AlibabaWaitTimeoutError({
              service: "RDS",
              resourceType: Instance.Type,
              operation: "RequestDeleteDBInstance",
              attempts: result.attempts,
              intervalMs: result.intervalMs,
              lastObservation: DeleteDecision.$is("Creating")(decision)
                ? `status:${decision.status}`
                : decision._tag,
              message: `${Instance.Type} did not accept deletion after ${result.attempts} observations`,
            });
          }
          yield* waitForAbsent({
            service: "RDS",
            resourceType: Instance.Type,
            operation: "DeleteDBInstance",
            read: getById(output.instanceId),
            wait: options.wait,
          });
        }),
      };
    }),
  );
