import * as ECS from "@alicloud/ecs20140526";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { hasAlchemyTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isDeepStrictEqual } from "node:util";
import { AlibabaClients } from "../clients.ts";
import {
  AlibabaInvariantError,
  isAmbiguousCreate,
  retryingSdkCall,
} from "../error.ts";
import {
  requestOrContinueDelete,
  desiredTags,
  paginate,
  physicalName,
  requireRegion,
  requireValue,
  tagsEqual,
  userTags,
  waitFor,
  waitForAbsent,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Providers } from "../providers.ts";
import { missing, syncTags, tagList, tagRecord, unique } from "./internal.ts";

/** One pay-as-you-go VPC instance with an instance-owned system disk. */
export interface InstanceProps {
  readonly name?: string;
  readonly imageId: string;
  readonly instanceType: string;
  readonly vSwitchId: string;
  readonly securityGroupIds: readonly string[];
  readonly systemDisk?: { readonly category?: string; readonly size?: number };
  readonly keyPairName?: string;
  readonly ramRoleName?: string;
  /** Plain UTF-8 cloud-init input; encoded to Base64 only for RunInstances. Replaced on change. */
  readonly userData?: Redacted.Redacted<string>;
  /** Zero (default) creates no public IP. Nonzero uses instance-bound, pay-by-traffic access. */
  readonly internetMaxBandwidthOut?: number;
  readonly description?: string;
  readonly deletionProtection?: boolean;
  /** Absolute UTC timestamp accepted by ECS. Empty string clears an existing schedule. */
  readonly autoReleaseTime?: string;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface InstanceAttributes {
  readonly instanceId: string;
  readonly name: string;
  readonly regionId: string;
  readonly vpcId: string;
  readonly vSwitchId: string;
  readonly privateIp: string;
  readonly publicIp?: string;
  readonly status: string;
  readonly imageId: string;
  readonly instanceType: string;
  readonly securityGroupIds: readonly string[];
  readonly description?: string;
  readonly deletionProtection: boolean;
  readonly autoReleaseTime?: string;
  readonly tags: Readonly<Record<string, string>>;
}
export type Instance = Resource<
  "Alibaba.ECS.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;
export const Instance = Resource<Instance>("Alibaba.ECS.Instance");
type Observed = ECS.DescribeInstancesResponseBodyInstancesInstance;
const absent = missing("InvalidInstanceId.NotFound");
const sorted = (ids: readonly string[]) => [...ids].sort();
const identity = (props: InstanceProps) => ({
  name: props.name,
  imageId: props.imageId,
  instanceType: props.instanceType,
  vSwitchId: props.vSwitchId,
  securityGroupIds: sorted(props.securityGroupIds),
  systemDisk: {
    category: props.systemDisk?.category ?? "cloud_essd",
    size: props.systemDisk?.size ?? 40,
  },
  keyPairName: props.keyPairName,
  ramRoleName: props.ramRoleName,
  internetMaxBandwidthOut: props.internetMaxBandwidthOut ?? 0,
  userData:
    props.userData === undefined ? undefined : Redacted.value(props.userData),
});
const privateIp = (instance: Observed) =>
  instance.vpcAttributes?.privateIpAddress?.ipAddress?.[0];
const running = (instance: Observed) =>
  instance.status === "Running" && privateIp(instance) !== undefined;

export const InstanceProvider = (
  options: { readonly wait?: WaitOptions } = {},
) =>
  Provider.effect(
    Instance,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const inventory = (
        query: { instanceIds?: string; instanceName?: string } = {},
      ) =>
        paginate({
          service: "ECS",
          operation: "DescribeInstances",
          page: ({ pageNumber, pageSize }) =>
            retryingSdkCall("ECS", "DescribeInstances", () =>
              clients.ecs.describeInstances(
                new ECS.DescribeInstancesRequest({
                  ...query,
                  regionId: clients.regionId,
                  pageNumber,
                  pageSize,
                }),
              ),
            ).pipe(
              Effect.flatMap((response) =>
                requireValue(
                  response.body?.instances?.instance,
                  Instance.Type,
                  "DescribeInstances",
                  "ECS instance inventory is missing",
                ).pipe(
                  Effect.map((items) => ({
                    items,
                    totalCount: response.body?.totalCount,
                  })),
                ),
              ),
            ),
        });
      const get = (id: string) =>
        inventory({ instanceIds: JSON.stringify([id]) }).pipe(
          Effect.flatMap((items) =>
            unique(
              items.filter((item) => item.instanceId === id),
              Instance.Type,
            ),
          ),
          Effect.catchIf(absent, () => Effect.succeed(undefined)),
        );
      const find = (name: string) =>
        inventory({ instanceName: name }).pipe(
          Effect.flatMap((items) =>
            unique(
              items.filter((item) => item.instanceName === name),
              Instance.Type,
            ),
          ),
        );
      // A saved id is authoritative: never switch deletion or adoption to a namesake.
      const observe = (id: string | undefined, name: string) =>
        id === undefined ? find(name) : get(id);
      const attrs = Effect.fn("ECS.Instance.attributes")(function* (
        value: Observed,
      ) {
        const required = (field: string | undefined) =>
          requireValue(
            field,
            Instance.Type,
            "DescribeInstances",
            "ECS returned incomplete instance attributes",
          );
        return {
          instanceId: yield* required(value.instanceId),
          name: yield* required(value.instanceName),
          regionId: yield* required(value.regionId),
          vpcId: yield* required(value.vpcAttributes?.vpcId),
          vSwitchId: yield* required(value.vpcAttributes?.vSwitchId),
          privateIp: yield* required(privateIp(value)),
          publicIp: value.publicIpAddress?.ipAddress?.[0],
          status: value.status ?? "Unknown",
          imageId: yield* required(value.imageId),
          instanceType: yield* required(value.instanceType),
          securityGroupIds: value.securityGroupIds?.securityGroupId ?? [],
          description: value.description,
          deletionProtection: value.deletionProtection ?? false,
          autoReleaseTime: value.autoReleaseTime,
          tags: userTags(tagRecord(value.tags?.tag)),
        } satisfies InstanceAttributes;
      });
      const checkIdentity = (value: Observed, props: InstanceProps) =>
        value.instanceChargeType === "PostPaid" &&
        value.imageId === props.imageId &&
        value.instanceType === props.instanceType &&
        value.vpcAttributes?.vSwitchId === props.vSwitchId &&
        isDeepStrictEqual(
          sorted(value.securityGroupIds?.securityGroupId ?? []),
          sorted(props.securityGroupIds),
        )
          ? Effect.void
          : Effect.fail(
              new AlibabaInvariantError({
                resourceType: Instance.Type,
                operation: "Reconcile",
                message:
                  "Observed ECS billing, image, size or network identity differs; review replacement instead of adopting incompatible infrastructure",
              }),
            );
      return {
        version: 1,
        stables: [
          "instanceId",
          "regionId",
          "vpcId",
          "vSwitchId",
          "privateIp",
        ] as const,
        nuke: { dependsOn: ["Alibaba.ECS.SecurityGroup", "Alibaba.VPC.*"] },
        list: () =>
          inventory().pipe(
            Effect.flatMap((items) => Effect.forEach(items, attrs)),
          ),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (!isDeepStrictEqual(identity(olds), identity(news)))
            return { action: "replace", deleteFirst: true } as const;
          if (output === undefined) return undefined;
          yield* requireRegion(
            Instance.Type,
            clients.regionId,
            output.regionId,
          );
          const current = yield* get(output.instanceId);
          if (current === undefined)
            return { action: "replace", deleteFirst: true } as const;
          yield* checkIdentity(current, news);
          const observed = yield* attrs(current);
          if (
            observed.status !== "Running" ||
            !tagsEqual(observed.tags, news.tags ?? {}) ||
            (news.description !== undefined &&
              observed.description !== news.description) ||
            (news.deletionProtection !== undefined &&
              observed.deletionProtection !== news.deletionProtection) ||
            (news.autoReleaseTime !== undefined &&
              (observed.autoReleaseTime ?? "") !== news.autoReleaseTime)
          )
            return { action: "update" } as const;
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          yield* requireRegion(
            Instance.Type,
            clients.regionId,
            output?.regionId,
          );
          const name = yield* physicalName(id, olds.name ?? output?.name, 128);
          const value = yield* observe(output?.instanceId, name);
          if (value === undefined) return undefined;
          const attributes = yield* attrs(value);
          return (yield* hasAlchemyTags(id, tagRecord(value.tags?.tag)))
            ? attributes
            : Unowned(attributes);
        }),
        reconcile: Effect.fn(function* ({
          id,
          instanceId: generation,
          news,
          output,
        }) {
          yield* requireRegion(
            Instance.Type,
            clients.regionId,
            output?.regionId,
          );
          if (
            !news.securityGroupIds.length ||
            new Set(news.securityGroupIds).size !== news.securityGroupIds.length
          )
            return yield* new AlibabaInvariantError({
              resourceType: Instance.Type,
              operation: "Validate",
              message: "Provide at least one security group without duplicates",
            });
          const name = yield* physicalName(id, news.name ?? output?.name, 128);
          const tags = yield* desiredTags(id, news.tags);
          let value = yield* observe(output?.instanceId, name);
          if (value === undefined) {
            const response = yield* retryingSdkCall("ECS", "RunInstances", () =>
              clients.ecs.runInstances(
                new ECS.RunInstancesRequest({
                  regionId: clients.regionId,
                  instanceName: name,
                  amount: 1,
                  minAmount: 1,
                  instanceChargeType: "PostPaid",
                  clientToken: `create-${generation}`,
                  imageId: news.imageId,
                  instanceType: news.instanceType,
                  vSwitchId: news.vSwitchId,
                  securityGroupIds: [...news.securityGroupIds],
                  systemDisk: {
                    category: news.systemDisk?.category ?? "cloud_essd",
                    size: String(news.systemDisk?.size ?? 40),
                  },
                  keyPairName: news.keyPairName,
                  ramRoleName: news.ramRoleName,
                  userData:
                    news.userData === undefined
                      ? undefined
                      : Buffer.from(
                          Redacted.value(news.userData),
                          "utf8",
                        ).toString("base64"),
                  internetChargeType: "PayByTraffic",
                  internetMaxBandwidthOut: news.internetMaxBandwidthOut ?? 0,
                  description: news.description,
                  deletionProtection: news.deletionProtection ?? false,
                  autoReleaseTime: news.autoReleaseTime || undefined,
                  tag: tagList(tags),
                }),
              ),
            ).pipe(
              Effect.catchIf(isAmbiguousCreate, (error) =>
                waitForPresent({
                  service: "ECS",
                  operation: "RecoverRunInstances",
                  read: find(name),
                  ready: (value) => value.instanceId !== undefined,
                  wait: options.wait,
                }).pipe(
                  Effect.map((value) => ({
                    body: {
                      instanceIdSets: { instanceIdSet: [value.instanceId!] },
                    },
                  })),
                  Effect.catch(() => Effect.fail(error)),
                ),
              ),
            );
            const ids = response.body?.instanceIdSets?.instanceIdSet;
            if (ids !== undefined && ids.length !== 1)
              return yield* new AlibabaInvariantError({
                resourceType: Instance.Type,
                operation: "RunInstances",
                message:
                  "ECS did not return exactly one instance; reconcile the purchase inventory before retrying",
              });
            value = yield* waitForPresent({
              service: "ECS",
              operation: "RunInstances",
              read: observe(ids?.[0], name),
              ready: (value) =>
                running(value) &&
                ((news.internetMaxBandwidthOut ?? 0) === 0 ||
                  !!value.publicIpAddress?.ipAddress?.[0]),
              wait: options.wait,
            });
          }
          const instanceId = yield* requireValue(
            value.instanceId,
            Instance.Type,
            "Reconcile",
            "Missing instance id",
          );
          yield* checkIdentity(value, news);
          if (value.status === "Stopped")
            yield* requestOrContinueDelete({
              request: retryingSdkCall("ECS", "StartInstance", () =>
                clients.ecs.startInstance(
                  new ECS.StartInstanceRequest({ instanceId }),
                ),
              ),
              read: get(instanceId),
              deleting: (value) =>
                value.status === "Starting" || value.status === "Running",
            });
          value = yield* waitForPresent({
            service: "ECS",
            operation: "Running",
            read: get(instanceId),
            ready: running,
            wait: options.wait,
          });
          if (
            (news.description !== undefined &&
              value.description !== news.description) ||
            (news.deletionProtection !== undefined &&
              value.deletionProtection !== news.deletionProtection)
          ) {
            yield* retryingSdkCall("ECS", "ModifyInstanceAttribute", () =>
              clients.ecs.modifyInstanceAttribute(
                new ECS.ModifyInstanceAttributeRequest({
                  instanceId,
                  description: news.description,
                  deletionProtection: news.deletionProtection,
                }),
              ),
            );
          }
          if (
            news.autoReleaseTime !== undefined &&
            (value.autoReleaseTime ?? "") !== news.autoReleaseTime
          )
            yield* retryingSdkCall("ECS", "ModifyInstanceAutoReleaseTime", () =>
              clients.ecs.modifyInstanceAutoReleaseTime(
                new ECS.ModifyInstanceAutoReleaseTimeRequest({
                  regionId: clients.regionId,
                  instanceId,
                  autoReleaseTime: news.autoReleaseTime,
                }),
              ),
            );
          yield* syncTags(
            clients,
            "instance",
            instanceId,
            tagRecord(value.tags?.tag),
            tags,
          );
          return yield* attrs(
            yield* waitForPresent({
              service: "ECS",
              operation: "ReconcileInstance",
              read: get(instanceId),
              ready: (value) =>
                running(value) &&
                ((news.internetMaxBandwidthOut ?? 0) === 0 ||
                  !!value.publicIpAddress?.ipAddress?.[0]) &&
                (news.description === undefined ||
                  value.description === news.description) &&
                (news.deletionProtection === undefined ||
                  value.deletionProtection === news.deletionProtection) &&
                (news.autoReleaseTime === undefined ||
                  (value.autoReleaseTime ?? "") === news.autoReleaseTime) &&
                tagsEqual(tagRecord(value.tags?.tag), tags),
              wait: options.wait,
            }),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* requireRegion(
            Instance.Type,
            clients.regionId,
            output.regionId,
          );
          let value = yield* get(output.instanceId);
          if (value === undefined) return;
          if (
            value.instanceChargeType !== "PostPaid" ||
            value.deletionProtection === true
          )
            return yield* new AlibabaInvariantError({
              resourceType: Instance.Type,
              operation: "DeleteInstance",
              message:
                "ECS deletion requires a pay-as-you-go instance with deletion protection disabled",
            });
          value = yield* waitFor({
            service: "ECS",
            operation: "WaitBeforeStop",
            read: get(output.instanceId),
            ready: (value) =>
              value === undefined ||
              value.status === "Running" ||
              value.status === "Stopped",
            wait: options.wait,
          });
          if (value === undefined) return;
          if (value.status === "Running")
            yield* requestOrContinueDelete({
              request: retryingSdkCall("ECS", "StopInstance", () =>
                clients.ecs.stopInstance(
                  new ECS.StopInstanceRequest({
                    instanceId: output.instanceId,
                    forceStop: false,
                  }),
                ),
              ),
              read: get(output.instanceId),
              deleting: (value) =>
                value.status === "Stopping" || value.status === "Stopped",
            });
          // Absence during stop (for example AutoReleaseTime) is also terminal.
          yield* waitForAbsent({
            service: "ECS",
            operation: "StopInstance",
            read: get(output.instanceId).pipe(
              Effect.map((value) =>
                value?.status === "Stopped" ? undefined : value,
              ),
            ),
            wait: options.wait,
          });
          yield* retryingSdkCall("ECS", "DeleteInstance", () =>
            clients.ecs.deleteInstance(
              new ECS.DeleteInstanceRequest({
                instanceId: output.instanceId,
                force: false,
              }),
            ),
          ).pipe(Effect.catchIf(absent, () => Effect.void));
          yield* waitForAbsent({
            service: "ECS",
            operation: "DeleteInstance",
            read: get(output.instanceId),
            wait: options.wait,
          });
        }),
      };
    }),
  );
