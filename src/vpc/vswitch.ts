import * as VPC from "@alicloud/vpc20160428";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { hasAlchemyTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { isDeepStrictEqual } from "node:util";
import { AlibabaClients } from "../clients.ts";
import {
  AlibabaDependencyBlockedError,
  AlibabaWaitTimeoutError,
  type AlibabaProviderError,
  isDependencyViolation,
  isNotFound,
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

export interface VSwitchProps {
  readonly vpcId: string;
  readonly name?: string;
  readonly cidrBlock: string;
  readonly zoneId: string;
  readonly create?: Without<
    VPC.CreateVSwitchRequest,
    "regionId" | "vpcId" | "vSwitchName" | "cidrBlock" | "zoneId" | "tag"
  >;
  readonly modify?: Without<
    VPC.ModifyVSwitchAttributeRequest,
    "regionId" | "vSwitchId" | "vSwitchName"
  >;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface VSwitchAttributes {
  readonly vSwitchId: string;
  readonly vpcId: string;
  readonly name: string;
  readonly cidrBlock: string;
  readonly zoneId: string;
  readonly status: string;
  readonly description?: string;
  readonly availableIpAddressCount?: number;
  readonly resourceGroupId?: string;
  readonly networkAclId?: string;
  readonly ipv6Enabled: boolean;
  readonly ipv6CidrBlock?: string;
  readonly createdAt?: string;
  readonly tags: Readonly<Record<string, string>>;
}

export type VSwitch = Resource<
  "Alibaba.VPC.VSwitch",
  VSwitchProps,
  VSwitchAttributes,
  never,
  Providers
>;

export const VSwitch = Resource<VSwitch>("Alibaba.VPC.VSwitch");

type ObservedVSwitch = VPC.DescribeVSwitchAttributesResponseBody;

const tagRecord = (vswitch: ObservedVSwitch) =>
  Object.fromEntries(
    (vswitch.tags?.tag ?? []).flatMap((tag) =>
      tag.key === undefined || tag.value === undefined
        ? []
        : [[tag.key, tag.value] as const],
    ),
  );

const tagList = (tags: Readonly<Record<string, string>>) =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));

const ready = (vswitch: ObservedVSwitch) =>
  vswitch.status?.toLowerCase() === "available";

const deleting = (vswitch: ObservedVSwitch) => {
  const status = vswitch.status?.toLowerCase();
  return status === "deleting" || status === "pending";
};

const transientDeleteCodes = new Set([
  "IncorrectRouteEntryStatus",
  "IncorrectVSwitchStatus",
  "InternalError",
  "LastTokenProcessing",
  "OperationConflict",
  "OperationDenied.OtherSubnetProcessing",
  "SystemBusy",
  "TaskConflict",
]);

const retryableDeleteDependency = (error: AlibabaProviderError) =>
  (isDependencyViolation(error) &&
    (error.code === "DependencyViolation" ||
      error.code === "DependencyViolation.NetworkInterface" ||
      error.code === "DependencyViolation.Kvstore")) ||
  (error.code !== undefined && transientDeleteCodes.has(error.code));

const modifyMatches = (
  vswitch: ObservedVSwitch,
  desired: VSwitchProps["modify"],
) =>
  desired === undefined ||
  ((desired.description === undefined ||
    vswitch.description === desired.description) &&
    (desired.enableIPv6 === undefined ||
      vswitch.enabledIpv6 === desired.enableIPv6));

const toAttributes = (vswitch: ObservedVSwitch) =>
  Effect.gen(function* () {
    const vSwitchId = yield* requireValue(
      vswitch.vSwitchId,
      VSwitch.Type,
      "DescribeVSwitchAttributes",
      "VPC returned a vSwitch without vSwitchId",
    );
    const vpcId = yield* requireValue(
      vswitch.vpcId,
      VSwitch.Type,
      "DescribeVSwitchAttributes",
      "VPC returned a vSwitch without vpcId",
    );
    const name = yield* requireValue(
      vswitch.vSwitchName,
      VSwitch.Type,
      "DescribeVSwitchAttributes",
      "VPC returned a vSwitch without vSwitchName",
    );
    const cidrBlock = yield* requireValue(
      vswitch.cidrBlock,
      VSwitch.Type,
      "DescribeVSwitchAttributes",
      "VPC returned a vSwitch without cidrBlock",
    );
    const zoneId = yield* requireValue(
      vswitch.zoneId,
      VSwitch.Type,
      "DescribeVSwitchAttributes",
      "VPC returned a vSwitch without zoneId",
    );
    return {
      vSwitchId,
      vpcId,
      name,
      cidrBlock,
      zoneId,
      status: vswitch.status ?? "Unknown",
      description: vswitch.description,
      availableIpAddressCount: vswitch.availableIpAddressCount,
      resourceGroupId: vswitch.resourceGroupId,
      networkAclId: vswitch.networkAclId,
      ipv6Enabled: vswitch.enabledIpv6 ?? false,
      ipv6CidrBlock: vswitch.ipv6CidrBlock,
      createdAt: vswitch.creationTime,
      tags: userTags(tagRecord(vswitch)),
    } satisfies VSwitchAttributes;
  });

export interface VSwitchProviderOptions {
  readonly wait?: WaitOptions;
  /** Bounded wait for managed ENIs and transitional delete status. */
  readonly deleteDependencyWait?: WaitOptions;
}

export const VSwitchProvider = (options: VSwitchProviderOptions = {}) =>
  Provider.effect(
    VSwitch,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      // Alibaba does not allow concurrent CreateVSwitch operations within one
      // VPC. Keep the lock through readiness, not merely request acceptance,
      // because the API remains exclusive while a vSwitch is Pending.
      const createLocks = new Map<string, Semaphore.Semaphore>();
      const createLock = (vpcId: string) => {
        let lock = createLocks.get(vpcId);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          createLocks.set(vpcId, lock);
        }
        return lock;
      };

      const getById = (vSwitchId: string) =>
        retryingSdkCall("VPC", "DescribeVSwitchAttributes", () =>
          clients.vpc.describeVSwitchAttributes(
            new VPC.DescribeVSwitchAttributesRequest({ vSwitchId }),
          ),
        ).pipe(
          // Alibaba returns HTTP 200 with an empty body after a vSwitch has
          // been deleted. Require the requested identity so destroy waiters do
          // not treat that tombstone response as a live resource.
          Effect.map((response) =>
            response.body?.vSwitchId === vSwitchId ? response.body : undefined,
          ),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );

      const findByName = (vpcId: string, name: string) =>
        retryingSdkCall("VPC", "DescribeVSwitches", () =>
          clients.vpc.describeVSwitches(
            new VPC.DescribeVSwitchesRequest({
              regionId: clients.regionId,
              vpcId,
              vSwitchName: name,
              pageNumber: 1,
              pageSize: 50,
            }),
          ),
        ).pipe(
          Effect.map(
            (response) =>
              response.body?.vSwitches?.vSwitch?.find(
                (item) => item.vSwitchName === name,
              )?.vSwitchId,
          ),
          Effect.flatMap((vSwitchId) =>
            vSwitchId === undefined
              ? Effect.succeed(undefined)
              : getById(vSwitchId),
          ),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );

      const observe = (
        vpcId: string,
        vSwitchId: string | undefined,
        name: string,
      ) =>
        vSwitchId === undefined
          ? findByName(vpcId, name)
          : getById(vSwitchId).pipe(
              Effect.flatMap((vswitch) =>
                vswitch === undefined
                  ? findByName(vpcId, name)
                  : Effect.succeed(vswitch),
              ),
            );

      const syncTags = Effect.fn(function* (
        vSwitchId: string,
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
          yield* retryingSdkCall("VPC", "TagResources", () =>
            clients.vpc.tagResources(
              new VPC.TagResourcesRequest({
                regionId: clients.regionId,
                resourceType: "VSWITCH",
                resourceId: [vSwitchId],
                tag: tagList(upsert),
              }),
            ),
          );
        }
        if (removed.length > 0) {
          yield* retryingSdkCall("VPC", "UnTagResources", () =>
            clients.vpc.unTagResources(
              new VPC.UnTagResourcesRequest({
                all: false,
                regionId: clients.regionId,
                resourceType: "VSWITCH",
                resourceId: [vSwitchId],
                tagKey: removed,
              }),
            ),
          );
        }
      });

      return {
        version: 1,
        stables: ["vSwitchId", "vpcId", "createdAt"] as const,
        // Deleting a vSwitch requires its VPC to still be there, so every
        // vSwitch must be gone before any VPC starts deleting. The in-VPC
        // services declare `Alibaba.VPC.*`, which puts them ahead of both.
        nuke: { dependsOn: ["Alibaba.VPC.Network"] },
        // `DescribeVSwitches` returns a different (thinner) shape than
        // `DescribeVSwitchAttributes`, so re-read each id through `getById`
        // rather than maintaining a second attribute mapping.
        list: () =>
          paginate({
            service: "VPC",
            operation: "DescribeVSwitches",
            page: ({ pageNumber, pageSize }) =>
              retryingSdkCall("VPC", "DescribeVSwitches", () =>
                clients.vpc.describeVSwitches(
                  new VPC.DescribeVSwitchesRequest({
                    regionId: clients.regionId,
                    pageNumber,
                    pageSize,
                  }),
                ),
              ).pipe(
                Effect.map((response) => ({
                  items: (response.body?.vSwitches?.vSwitch ?? []).flatMap(
                    (item) => (item.vSwitchId === undefined ? [] : [item.vSwitchId]),
                  ),
                  totalCount: response.body?.totalCount,
                })),
                Effect.catchIf(isNotFound, () =>
                  Effect.succeed({ items: [] as string[] }),
                ),
              ),
          }).pipe(
            Effect.flatMap(
              Effect.forEach((vSwitchId) => getById(vSwitchId), {
                concurrency: 8,
              }),
            ),
            // A vSwitch deleted between the page read and the detail read is
            // simply gone; skip it rather than failing the whole enumeration.
            Effect.flatMap(
              Effect.forEach(
                (vswitch) =>
                  vswitch === undefined
                    ? Effect.succeed([])
                    : toAttributes(vswitch).pipe(Effect.map((value) => [value])),
                { concurrency: "unbounded" },
              ),
            ),
            Effect.map((groups) => groups.flat()),
          ),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds.vpcId === undefined) return undefined;
          return olds.vpcId !== news.vpcId ||
            olds.name !== news.name ||
            olds.cidrBlock !== news.cidrBlock ||
            olds.zoneId !== news.zoneId ||
            !isDeepStrictEqual(olds.create, news.create)
            ? ({ action: "replace" } as const)
            : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const vpcId = olds.vpcId ?? output?.vpcId;
          if (vpcId === undefined) return undefined;
          const name = yield* physicalName(id, olds.name ?? output?.name, 128);
          const vswitch = yield* observe(vpcId, output?.vSwitchId, name);
          if (vswitch === undefined) return undefined;
          const attributes = yield* toAttributes(vswitch);
          return (yield* hasAlchemyTags(id, tagRecord(vswitch)))
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
          const name = yield* physicalName(id, news.name ?? output?.name, 128);
          const tags = yield* desiredTags(id, news.tags);
          let vswitch = yield* observe(news.vpcId, output?.vSwitchId, name);
          if (vswitch === undefined) {
            vswitch = yield* Semaphore.withPermits(
              createLock(news.vpcId),
              1,
            )(
              Effect.gen(function* () {
                // Another reconcile may have created this switch while this
                // fiber waited for the VPC-scoped create lock.
                const existing = yield* observe(
                  news.vpcId,
                  output?.vSwitchId,
                  name,
                );
                if (existing !== undefined) return existing;
                const response = yield* retryingSdkCall(
                  "VPC",
                  "CreateVSwitch",
                  () =>
                    clients.vpc.createVSwitch(
                      new VPC.CreateVSwitchRequest({
                        ...news.create,
                        cidrBlock: news.cidrBlock,
                        clientToken:
                          news.create?.clientToken ??
                          `create-${resourceInstanceId}`,
                        regionId: clients.regionId,
                        tag: tagList(tags),
                        vpcId: news.vpcId,
                        vSwitchName: name,
                        zoneId: news.zoneId,
                      }),
                    ),
                );
                return yield* waitForPresent({
                  service: "VPC",
                  operation: "CreateVSwitch",
                  read: observe(news.vpcId, response.body?.vSwitchId, name),
                  ready,
                  wait: options.wait,
                });
              }),
            );
          }
          const vSwitchId = yield* requireValue(
            vswitch.vSwitchId,
            VSwitch.Type,
            "Reconcile",
            "VPC returned a vSwitch without vSwitchId",
          );
          if (
            news.modify !== undefined &&
            (!isDeepStrictEqual(news.modify, olds?.modify) ||
              !modifyMatches(vswitch, news.modify))
          ) {
            yield* sdkCall("VPC", "ModifyVSwitchAttribute", () =>
              clients.vpc.modifyVSwitchAttribute(
                new VPC.ModifyVSwitchAttributeRequest({
                  ...news.modify,
                  regionId: clients.regionId,
                  vSwitchId,
                }),
              ),
            );
          }
          yield* syncTags(vSwitchId, tagRecord(vswitch), tags);
          const fresh = yield* waitForPresent({
            service: "VPC",
            operation: "ReconcileVSwitch",
            read: getById(vSwitchId),
            ready: (value) =>
              ready(value) &&
              value.vpcId === news.vpcId &&
              value.cidrBlock === news.cidrBlock &&
              value.zoneId === news.zoneId &&
              modifyMatches(value, news.modify) &&
              tagsEqual(tagRecord(value), tags),
            wait: options.wait,
          });
          return yield* toAttributes(fresh);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Managed services can disappear from their own APIs before Alibaba
          // releases their vSwitch attachment. Retry only the generic API
          // response, explicit ENI/Kvstore dependencies, and documented
          // transient statuses. Permanent dependencies such as a Network ACL
          // stay loud.
          type DeleteDecision = Data.TaggedEnum<{
            Absent: Record<never, never>;
            Deleting: { readonly status: string };
            Pending: { readonly status: string };
            Blocked: { readonly error: AlibabaProviderError };
            Accepted: Record<never, never>;
          }>;
          const DeleteDecision = Data.taggedEnum<DeleteDecision>();
          const result = yield* observeUntil({
            read: getById(output.vSwitchId).pipe(
              Effect.flatMap(
                (
                  vswitch,
                ): Effect.Effect<DeleteDecision, AlibabaProviderError> => {
                  if (vswitch === undefined) {
                    return Effect.succeed(DeleteDecision.Absent());
                  }
                  if (deleting(vswitch)) {
                    return Effect.succeed(
                      DeleteDecision.Deleting({
                        status: vswitch.status ?? "Unknown",
                      }),
                    );
                  }
                  if (!ready(vswitch)) {
                    return Effect.succeed(
                      DeleteDecision.Pending({
                        status: vswitch.status ?? "Unknown",
                      }),
                    );
                  }
                  return retryingSdkCall("VPC", "DeleteVSwitch", () =>
                    clients.vpc.deleteVSwitch(
                      new VPC.DeleteVSwitchRequest({
                        vSwitchId: output.vSwitchId,
                      }),
                    ),
                  ).pipe(
                    Effect.as<DeleteDecision>(DeleteDecision.Accepted()),
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
                        if (retryableDeleteDependency(error)) {
                          return Effect.succeed(
                            DeleteDecision.Blocked({ error }),
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
            wait: options.deleteDependencyWait ?? {
              attempts: 61,
              interval: "10 seconds",
            },
          });
          if (result._tag === "Exhausted") {
            const decision = result.value;
            if (DeleteDecision.$is("Blocked")(decision)) {
              const providerCode = decision.error.code;
              return yield* new AlibabaDependencyBlockedError({
                service: "VPC",
                resourceType: VSwitch.Type,
                operation: "DeleteVSwitch",
                resourceId: output.vSwitchId,
                dependency:
                  providerCode?.startsWith("DependencyViolation.") === true
                    ? providerCode.slice("DependencyViolation.".length)
                    : "unknown",
                attempts: result.attempts,
                providerCode,
                requestId: decision.error.requestId,
                message: `${VSwitch.Type} ${output.vSwitchId} remained blocked by ${providerCode ?? "an unknown dependency"} after ${result.attempts} attempts`,
                cause: new Error(decision.error.message),
              });
            }
            return yield* new AlibabaWaitTimeoutError({
              service: "VPC",
              resourceType: VSwitch.Type,
              operation: "DeleteVSwitchDependencies",
              attempts: result.attempts,
              intervalMs: result.intervalMs,
              lastObservation: DeleteDecision.$is("Pending")(decision)
                ? `status:${decision.status}`
                : decision._tag,
              message: `${VSwitch.Type} did not become deletable after ${result.attempts} observations`,
            });
          }
          yield* waitForAbsent({
            service: "VPC",
            resourceType: VSwitch.Type,
            operation: "DeleteVSwitch",
            read: getById(output.vSwitchId),
            wait: options.wait,
          });
        }),
      };
    }),
  );
