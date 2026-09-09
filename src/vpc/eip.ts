import * as VPC from "@alicloud/vpc20160428";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { hasAlchemyTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import { AlibabaClients } from "../clients.ts";
import {
  AlibabaInvariantError,
  isNotFound,
  retryingSdkCall,
} from "../error.ts";
import { replacement, uniqueMatch } from "../internal/identity.ts";
import {
  desiredTags,
  paginate,
  physicalName,
  requireRegion,
  requireValue,
  tagsEqual,
  userTags,
  waitForAbsent,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Providers } from "../providers.ts";
import { syncTags, tagList, tagRecord } from "./internal.ts";

/** A separately owned postpaid public address, retained across target replacement. */
export interface EipProps {
  readonly name?: string;
  /** Mbps. Updates in place. */
  readonly bandwidth?: number;
  readonly description?: string;
  /** Immutable billing mode. Defaults to PayByTraffic. */
  readonly internetChargeType?: "PayByTraffic" | "PayByBandwidth";
  readonly tags?: Readonly<Record<string, string>>;
}
export interface EipAttributes {
  readonly allocationId: string;
  readonly ipAddress: string;
  readonly name: string;
  readonly regionId: string;
  readonly bandwidth: number;
  readonly description?: string;
  readonly status?: string;
  readonly tags: Readonly<Record<string, string>>;
}
export type Eip = Resource<
  "Alibaba.VPC.Eip",
  EipProps,
  EipAttributes,
  never,
  Providers
>;
export const Eip = Resource<Eip>("Alibaba.VPC.Eip");

export const EipProvider = (options: { readonly wait?: WaitOptions } = {}) =>
  Provider.effect(
    Eip,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const inventory = (allocationId?: string, name?: string) =>
        paginate({
          service: "VPC",
          operation: "DescribeEipAddresses",
          page: ({ pageNumber, pageSize }) =>
            retryingSdkCall("VPC", "DescribeEipAddresses", () =>
              clients.vpc.describeEipAddresses(
                new VPC.DescribeEipAddressesRequest({
                  regionId: clients.regionId,
                  allocationId,
                  eipName: name,
                  pageNumber,
                  pageSize,
                }),
              ),
            ).pipe(
              Effect.map((r) => ({
                items: r.body?.eipAddresses?.eipAddress ?? [],
                totalCount: r.body?.totalCount,
              })),
              Effect.catchIf(isNotFound, () => Effect.succeed({ items: [] })),
            ),
        });
      const get = (allocationId?: string, name?: string) =>
        inventory(allocationId, name).pipe(
          Effect.flatMap((items) =>
            uniqueMatch(
              items.filter((item) =>
                allocationId
                  ? item.allocationId === allocationId
                  : item.name === name,
              ),
              Eip.Type,
            ),
          ),
        );
      const attrs = Effect.fn("VPC.Eip.attributes")(function* (
        value: VPC.DescribeEipAddressesResponseBodyEipAddressesEipAddress,
      ) {
        return {
          allocationId: yield* requireValue(
            value.allocationId,
            Eip.Type,
            "Read",
            "Missing EIP allocation id",
          ),
          ipAddress: yield* requireValue(
            value.ipAddress,
            Eip.Type,
            "Read",
            "Missing EIP address",
          ),
          name: value.name ?? "",
          regionId: clients.regionId,
          bandwidth: Number(value.bandwidth),
          description: value.description,
          status: value.status,
          tags: userTags(tagRecord(value.tags?.tag)),
        };
      });
      const ready = (
        value: VPC.DescribeEipAddressesResponseBodyEipAddressesEipAddress,
      ) => value.status === "Available" || value.status === "InUse";
      return {
        version: 1,
        stables: ["allocationId", "ipAddress", "regionId"],
        list: () => inventory().pipe(Effect.flatMap(Effect.forEach(attrs))),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return;
          if (
            (olds.internetChargeType ?? "PayByTraffic") !==
            (news.internetChargeType ?? "PayByTraffic")
          )
            return yield* replacement(Eip.Type, olds.name, news.name);
          if (output) {
            yield* requireRegion(Eip.Type, clients.regionId, output.regionId);
            const value = yield* get(output.allocationId);
            if (
              !value ||
              Number(value.bandwidth) !== (news.bandwidth ?? 5) ||
              value.name !== (news.name ?? output.name) ||
              (news.description !== undefined &&
                value.description !== news.description) ||
              !tagsEqual(userTags(tagRecord(value.tags?.tag)), news.tags ?? {})
            )
              return { action: "update" };
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          yield* requireRegion(Eip.Type, clients.regionId, output?.regionId);
          const value = yield* get(
            output?.allocationId,
            yield* physicalName(id, olds.name ?? output?.name, 128),
          );
          if (!value) return;
          const result = yield* attrs(value);
          return (yield* hasAlchemyTags(id, tagRecord(value.tags?.tag)))
            ? result
            : Unowned(result);
        }),
        reconcile: Effect.fn(function* ({
          id,
          instanceId,
          news,
          output,
          session,
        }) {
          yield* requireRegion(Eip.Type, clients.regionId, output?.regionId);
          const name = yield* physicalName(id, news.name ?? output?.name, 128);
          const tags = yield* desiredTags(id, news.tags);
          let value = yield* get(output?.allocationId, name);
          if (
            value &&
            !output &&
            !(yield* hasAlchemyTags(id, tagRecord(value.tags?.tag)))
          )
            return yield* new AlibabaInvariantError({
              resourceType: Eip.Type,
              operation: "Recover",
              message:
                "EIP name belongs to an unowned address; adopt it explicitly",
            });
          if (!value) {
            yield* session.note(`Allocating EIP ${name}`);
            const response = yield* retryingSdkCall(
              "VPC",
              "AllocateEipAddress",
              () =>
                clients.vpc.allocateEipAddress(
                  new VPC.AllocateEipAddressRequest({
                    regionId: clients.regionId,
                    name,
                    bandwidth: String(news.bandwidth ?? 5),
                    description: news.description,
                    internetChargeType:
                      news.internetChargeType ?? "PayByTraffic",
                    instanceChargeType: "PostPaid",
                    clientToken: `create-${instanceId}`,
                    tag: tagList(tags),
                  }),
                ),
            );
            const allocationId = yield* requireValue(
              response.body?.allocationId,
              Eip.Type,
              "AllocateEipAddress",
              "Missing EIP allocation id",
            );
            value = yield* waitForPresent({
              service: "VPC",
              operation: "AllocateEipAddress",
              read: get(allocationId),
              ready,
              wait: options.wait,
            });
          }
          const allocationId = yield* requireValue(
            value.allocationId,
            Eip.Type,
            "Read",
            "Missing EIP allocation id",
          );
          if (
            value.name !== name ||
            Number(value.bandwidth) !== (news.bandwidth ?? 5) ||
            (news.description !== undefined &&
              value.description !== news.description)
          )
            yield* retryingSdkCall("VPC", "ModifyEipAddressAttribute", () =>
              clients.vpc.modifyEipAddressAttribute(
                new VPC.ModifyEipAddressAttributeRequest({
                  regionId: clients.regionId,
                  allocationId,
                  name,
                  bandwidth: String(news.bandwidth ?? 5),
                  description: news.description,
                }),
              ),
            );
          yield* syncTags(
            clients,
            "EIP",
            allocationId,
            tagRecord(value.tags?.tag),
            tags,
          );
          return yield* attrs(
            yield* waitForPresent({
              service: "VPC",
              operation: "ReconcileEip",
              read: get(allocationId),
              ready: (v) =>
                ready(v) &&
                v.name === name &&
                Number(v.bandwidth) === (news.bandwidth ?? 5) &&
                tagsEqual(tagRecord(v.tags?.tag), tags),
              wait: options.wait,
            }),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* requireRegion(Eip.Type, clients.regionId, output.regionId);
          if (!(yield* get(output.allocationId))) return;
          yield* retryingSdkCall("VPC", "ReleaseEipAddress", () =>
            clients.vpc.releaseEipAddress(
              new VPC.ReleaseEipAddressRequest({
                regionId: clients.regionId,
                allocationId: output.allocationId,
              }),
            ),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitForAbsent({
            service: "VPC",
            operation: "ReleaseEipAddress",
            read: get(output.allocationId),
            wait: options.wait,
          });
        }),
      };
    }),
  );
