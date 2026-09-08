import * as VPC from "@alicloud/vpc20160428";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { hasAlchemyTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isDeepStrictEqual } from "node:util";
import { AlibabaClients } from "../clients.ts";
import {
  AlibabaDependencyBlockedError,
  AlibabaWaitTimeoutError,
  isDependencyViolation,
  isNotFound,
  retryingSdkCall,
  sdkCall,
  type AlibabaProviderError,
} from "../error.ts";
import {
  desiredTags,
  observeUntil,
  paginate,
  physicalName,
  requireValue,
  tagsEqual,
  userTags,
  waitForAbsent,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Without } from "../internal/model-input.ts";
import type { Providers } from "../providers.ts";

export interface NetworkProps {
  readonly name?: string;
  readonly cidrBlock: string;
  readonly create?: Without<
    VPC.CreateVpcRequest,
    "regionId" | "vpcName" | "cidrBlock" | "tag"
  >;
  readonly modify?: Without<
    VPC.ModifyVpcAttributeRequest,
    "regionId" | "vpcId" | "vpcName" | "cidrBlock"
  >;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface NetworkAttributes {
  readonly vpcId: string;
  readonly name: string;
  readonly cidrBlock: string;
  readonly status: string;
  readonly description?: string;
  readonly regionId?: string;
  readonly resourceGroupId?: string;
  readonly routerId?: string;
  readonly ipv6Enabled: boolean;
  readonly ipv6CidrBlock?: string;
  readonly dnsHostnameStatus?: string;
  readonly createdAt?: string;
  readonly tags: Readonly<Record<string, string>>;
}

export type Network = Resource<
  "Alibaba.VPC.Network",
  NetworkProps,
  NetworkAttributes,
  never,
  Providers
>;

export const Network = Resource<Network>("Alibaba.VPC.Network");

type ObservedNetwork = VPC.DescribeVpcsResponseBodyVpcsVpc;

const tagRecord = (network: ObservedNetwork) =>
  Object.fromEntries(
    (network.tags?.tag ?? []).flatMap((tag) =>
      tag.key === undefined || tag.value === undefined
        ? []
        : [[tag.key, tag.value] as const],
    ),
  );

const tagList = (tags: Readonly<Record<string, string>>) =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));

const ready = (network: ObservedNetwork) =>
  network.status?.toLowerCase() === "available";

// Unlike vSwitch deletion, VPC deletion has its own explicit `Deleting`
// state. `Pending` means the VPC is still being configured and DeleteVpc must
// eventually be issued once it becomes Available.
const deleting = (network: ObservedNetwork) =>
  network.status?.toLowerCase() === "deleting";

/**
 * Documented transient DeleteVpc rejections. Route-table and other in-progress
 * VPC mutations clear on their own, as do the managed attachments that ACK
 * leaves behind.
 */
const transientDeleteCodes = new Set([
  "IncorrectRouteEntryStatus",
  "IncorrectStatus.RouteTable",
  "IncorrectVpcStatus",
  "InternalError",
  "LastTokenProcessing",
  "OperationConflict",
  "SystemBusy",
  "TaskConflict",
]);

const retryableDeleteDependency = (error: AlibabaProviderError) =>
  isDependencyViolation(error) ||
  (error.code !== undefined && transientDeleteCodes.has(error.code));

const modifyMatches = (
  network: ObservedNetwork,
  desired: NetworkProps["modify"],
) =>
  desired === undefined ||
  ((desired.description === undefined ||
    network.description === desired.description) &&
    (desired.enableDnsHostname === undefined ||
      (network.dnsHostnameStatus?.toLowerCase() === "enabled") ===
        desired.enableDnsHostname) &&
    (desired.enableIPv6 === undefined ||
      network.enabledIpv6 === desired.enableIPv6));

const toAttributes = (network: ObservedNetwork) =>
  Effect.gen(function* () {
    const vpcId = yield* requireValue(
      network.vpcId,
      Network.Type,
      "DescribeVpcs",
      "VPC returned a network without vpcId",
    );
    const name = yield* requireValue(
      network.vpcName,
      Network.Type,
      "DescribeVpcs",
      "VPC returned a network without vpcName",
    );
    const cidrBlock = yield* requireValue(
      network.cidrBlock,
      Network.Type,
      "DescribeVpcs",
      "VPC returned a network without cidrBlock",
    );
    return {
      vpcId,
      name,
      cidrBlock,
      status: network.status ?? "Unknown",
      description: network.description,
      regionId: network.regionId,
      resourceGroupId: network.resourceGroupId,
      routerId: network.VRouterId,
      ipv6Enabled: network.enabledIpv6 ?? false,
      ipv6CidrBlock: network.ipv6CidrBlock,
      dnsHostnameStatus: network.dnsHostnameStatus,
      createdAt: network.creationTime,
      tags: userTags(tagRecord(network)),
    } satisfies NetworkAttributes;
  });

export interface NetworkProviderOptions {
  readonly wait?: WaitOptions;
  /** Bounded wait for managed child attachments to release the VPC. */
  readonly deleteDependencyWait?: WaitOptions;
}

export const NetworkProvider = (options: NetworkProviderOptions = {}) =>
  Provider.effect(
    Network,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;

      const describe = (request: VPC.DescribeVpcsRequest) =>
        retryingSdkCall("VPC", "DescribeVpcs", () =>
          clients.vpc.describeVpcs(request),
        ).pipe(
          Effect.map((response) => response.body?.vpcs?.vpc ?? []),
          Effect.catchIf(isNotFound, () => Effect.succeed([])),
        );

      const getById = (vpcId: string) =>
        describe(
          new VPC.DescribeVpcsRequest({
            regionId: clients.regionId,
            vpcId,
            pageNumber: 1,
            pageSize: 50,
          }),
        ).pipe(
          Effect.map((items) => items.find((item) => item.vpcId === vpcId)),
        );

      const findByName = (name: string) =>
        paginate({
          service: "VPC",
          operation: "DescribeVpcs",
          page: ({ pageNumber, pageSize }) =>
            retryingSdkCall("VPC", "DescribeVpcs", () =>
              clients.vpc.describeVpcs(
                new VPC.DescribeVpcsRequest({
                  regionId: clients.regionId,
                  vpcName: name,
                  pageNumber,
                  pageSize,
                }),
              ),
            ).pipe(
              Effect.map((response) => ({
                items: response.body?.vpcs?.vpc ?? [],
                totalCount: response.body?.totalCount,
              })),
            ),
        }).pipe(
          Effect.map((items) => items.find((item) => item.vpcName === name)),
        );

      const observe = (vpcId: string | undefined, name: string) =>
        vpcId === undefined
          ? findByName(name)
          : getById(vpcId).pipe(
              Effect.flatMap((network) =>
                network === undefined
                  ? findByName(name)
                  : Effect.succeed(network),
              ),
            );

      const syncTags = Effect.fn(function* (
        vpcId: string,
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
                resourceType: "VPC",
                resourceId: [vpcId],
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
                resourceType: "VPC",
                resourceId: [vpcId],
                tagKey: removed,
              }),
            ),
          );
        }
      });

      return {
        version: 1,
        stables: ["vpcId", "createdAt"] as const,
        // No `nuke.dependsOn`: a VPC's teardown consumes nothing, and it is
        // the last thing to go. Everything inside it — the vSwitch and every
        // in-VPC service — declares `Alibaba.VPC.*` so it is fully gone
        // before this type starts deleting.
        list: () =>
          paginate({
            service: "VPC",
            operation: "DescribeVpcs",
            page: ({ pageNumber, pageSize }) =>
              retryingSdkCall("VPC", "DescribeVpcs", () =>
                clients.vpc.describeVpcs(
                  new VPC.DescribeVpcsRequest({
                    regionId: clients.regionId,
                    pageNumber,
                    pageSize,
                  }),
                ),
              ).pipe(
                Effect.map((response) => ({
                  items: response.body?.vpcs?.vpc ?? [],
                  totalCount: response.body?.totalCount,
                })),
                Effect.catchIf(isNotFound, () =>
                  Effect.succeed({ items: [] as ObservedNetwork[] }),
                ),
              ),
          }).pipe(
            Effect.flatMap(
              Effect.forEach((network) => toAttributes(network), {
                concurrency: "unbounded",
              }),
            ),
          ),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          return olds.name !== news.name ||
            olds.cidrBlock !== news.cidrBlock ||
            !isDeepStrictEqual(olds.create, news.create)
            ? ({ action: "replace" } as const)
            : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = yield* physicalName(id, olds.name ?? output?.name, 128);
          const network = yield* observe(output?.vpcId, name);
          if (network === undefined) return undefined;
          const attributes = yield* toAttributes(network);
          return (yield* hasAlchemyTags(id, tagRecord(network)))
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
          let network = yield* observe(output?.vpcId, name);
          if (network === undefined) {
            const response = yield* retryingSdkCall("VPC", "CreateVpc", () =>
              clients.vpc.createVpc(
                new VPC.CreateVpcRequest({
                  ...news.create,
                  cidrBlock: news.cidrBlock,
                  clientToken:
                    news.create?.clientToken ?? `create-${resourceInstanceId}`,
                  regionId: clients.regionId,
                  vpcName: name,
                  tag: tagList(tags),
                }),
              ),
            );
            network = yield* waitForPresent({
              service: "VPC",
              operation: "CreateVpc",
              read: observe(response.body?.vpcId, name),
              ready,
              wait: options.wait,
            });
          }
          const vpcId = yield* requireValue(
            network.vpcId,
            Network.Type,
            "Reconcile",
            "VPC returned a network without vpcId",
          );
          if (
            news.modify !== undefined &&
            (!isDeepStrictEqual(news.modify, olds?.modify) ||
              !modifyMatches(network, news.modify))
          ) {
            yield* sdkCall("VPC", "ModifyVpcAttribute", () =>
              clients.vpc.modifyVpcAttribute(
                new VPC.ModifyVpcAttributeRequest({
                  ...news.modify,
                  regionId: clients.regionId,
                  vpcId,
                }),
              ),
            );
          }
          yield* syncTags(vpcId, tagRecord(network), tags);
          const fresh = yield* waitForPresent({
            service: "VPC",
            operation: "ReconcileVpc",
            read: getById(vpcId),
            ready: (value) =>
              ready(value) &&
              value.cidrBlock === news.cidrBlock &&
              modifyMatches(value, news.modify) &&
              tagsEqual(tagRecord(value), tags),
            wait: options.wait,
          });
          return yield* toAttributes(fresh);
        }),
        delete: Effect.fn(function* ({ output }) {
          // A VPC is the last thing torn down, so it inherits every straggler
          // its children left behind: ACK's NAT gateway, EIP and managed
          // security groups, plus ENIs that outlive the instance they were
          // attached to. Alibaba reports all of those as `DependencyViolation`
          // on DeleteVpc, and they clear on their own — so retry them the same
          // way `VSwitch` does instead of failing the destroy and stranding
          // the whole network. Permanent dependencies still surface, because
          // the wait is bounded and reports the last provider error.
          type DeleteDecision = Data.TaggedEnum<{
            Absent: Record<never, never>;
            Deleting: { readonly status: string };
            Blocked: { readonly error: AlibabaProviderError };
            Accepted: Record<never, never>;
          }>;
          const DeleteDecision = Data.taggedEnum<DeleteDecision>();
          const result = yield* observeUntil({
            read: getById(output.vpcId).pipe(
              Effect.flatMap(
                (
                  network,
                ): Effect.Effect<DeleteDecision, AlibabaProviderError> => {
                  if (network === undefined) {
                    return Effect.succeed(DeleteDecision.Absent());
                  }
                  if (deleting(network)) {
                    return Effect.succeed(
                      DeleteDecision.Deleting({
                        status: network.status ?? "Unknown",
                      }),
                    );
                  }
                  return retryingSdkCall("VPC", "DeleteVpc", () =>
                    clients.vpc.deleteVpc(
                      new VPC.DeleteVpcRequest({
                        regionId: clients.regionId,
                        vpcId: output.vpcId,
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
                resourceType: Network.Type,
                operation: "DeleteVpc",
                resourceId: output.vpcId,
                dependency:
                  providerCode?.startsWith("DependencyViolation.") === true
                    ? providerCode.slice("DependencyViolation.".length)
                    : "unknown",
                attempts: result.attempts,
                providerCode,
                requestId: decision.error.requestId,
                message: `${Network.Type} ${output.vpcId} remained blocked by ${providerCode ?? "an unknown dependency"} after ${result.attempts} attempts`,
                cause: new Error(decision.error.message),
              });
            }
            return yield* new AlibabaWaitTimeoutError({
              service: "VPC",
              resourceType: Network.Type,
              operation: "DeleteVpcDependencies",
              attempts: result.attempts,
              intervalMs: result.intervalMs,
              lastObservation: decision._tag,
              message: `${Network.Type} did not become deletable after ${result.attempts} observations`,
            });
          }
          yield* waitForAbsent({
            service: "VPC",
            resourceType: Network.Type,
            operation: "DeleteVpc",
            read: getById(output.vpcId),
            wait: options.wait,
          });
        }),
      };
    }),
  );
