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

/** Enhanced postpaid Internet NAT. Alibaba creates a default VPC route if absent. */
export interface NatGatewayProps {
  /** Network placement is immutable. */
  readonly vpcId: string;
  readonly vSwitchId: string;
  readonly name?: string;
  readonly description?: string;
  readonly tags?: Readonly<Record<string, string>>;
}
export interface NatGatewayAttributes {
  readonly natGatewayId: string;
  readonly snatTableId: string;
  readonly vpcId: string;
  readonly vSwitchId?: string;
  readonly name: string;
  readonly regionId: string;
  readonly description?: string;
  readonly status?: string;
  readonly tags: Readonly<Record<string, string>>;
}
export type NatGateway = Resource<
  "Alibaba.VPC.NatGateway",
  NatGatewayProps,
  NatGatewayAttributes,
  never,
  Providers
>;
export const NatGateway = Resource<NatGateway>("Alibaba.VPC.NatGateway");
type Observed = VPC.DescribeNatGatewaysResponseBodyNatGatewaysNatGateway;
const tagsOf = (value: Observed) =>
  tagRecord(
    value.tags?.tag?.map((tag) => ({ key: tag.tagKey, value: tag.tagValue })),
  );

export const NatGatewayProvider = (
  options: { readonly wait?: WaitOptions } = {},
) =>
  Provider.effect(
    NatGateway,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const inventory = (natGatewayId?: string, name?: string) =>
        paginate({
          service: "VPC",
          operation: "DescribeNatGateways",
          page: ({ pageNumber, pageSize }) =>
            retryingSdkCall("VPC", "DescribeNatGateways", () =>
              clients.vpc.describeNatGateways(
                new VPC.DescribeNatGatewaysRequest({
                  regionId: clients.regionId,
                  natGatewayId,
                  name,
                  pageNumber,
                  pageSize,
                }),
              ),
            ).pipe(
              Effect.map((r) => ({
                items: r.body?.natGateways?.natGateway ?? [],
                totalCount: r.body?.totalCount,
              })),
              Effect.catchIf(isNotFound, () => Effect.succeed({ items: [] })),
            ),
        });
      const get = (natGatewayId?: string, name?: string) =>
        inventory(natGatewayId, name).pipe(
          Effect.flatMap((items) =>
            uniqueMatch(
              items.filter((item) =>
                natGatewayId
                  ? item.natGatewayId === natGatewayId
                  : item.name === name,
              ),
              NatGateway.Type,
            ),
          ),
        );
      const attrs = Effect.fn("VPC.NatGateway.attributes")(function* (
        value: Observed,
      ) {
        return {
          natGatewayId: yield* requireValue(
            value.natGatewayId,
            NatGateway.Type,
            "Read",
            "Missing NAT gateway id",
          ),
          snatTableId: yield* requireValue(
            value.snatTableIds?.snatTableId?.[0],
            NatGateway.Type,
            "Read",
            "Missing SNAT table id",
          ),
          vpcId: yield* requireValue(
            value.vpcId,
            NatGateway.Type,
            "Read",
            "Missing NAT VPC id",
          ),
          vSwitchId: value.natGatewayPrivateInfo?.vswitchId,
          name: value.name ?? "",
          regionId: clients.regionId,
          description: value.description,
          status: value.status,
          tags: userTags(tagsOf(value)),
        };
      });
      const ready = (value: Observed) => value.status === "Available";
      return {
        version: 1,
        stables: ["natGatewayId", "snatTableId", "regionId"],
        nuke: { dependsOn: ["Alibaba.VPC.VSwitch", "Alibaba.VPC.Network"] },
        list: () => inventory().pipe(Effect.flatMap(Effect.forEach(attrs))),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return;
          if (olds.vpcId !== news.vpcId || olds.vSwitchId !== news.vSwitchId)
            return yield* replacement(NatGateway.Type, olds.name, news.name);
          if (output) {
            yield* requireRegion(
              NatGateway.Type,
              clients.regionId,
              output.regionId,
            );
            const value = yield* get(output.natGatewayId);
            if (
              !value ||
              value.name !== (news.name ?? output.name) ||
              !tagsEqual(userTags(tagsOf(value)), news.tags ?? {}) ||
              (news.description !== undefined &&
                value.description !== news.description)
            )
              return { action: "update" };
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          yield* requireRegion(
            NatGateway.Type,
            clients.regionId,
            output?.regionId,
          );
          const value = yield* get(
            output?.natGatewayId,
            yield* physicalName(id, olds.name ?? output?.name, 128),
          );
          if (!value) return;
          const result = yield* attrs(value);
          return (yield* hasAlchemyTags(id, tagsOf(value)))
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
          yield* requireRegion(
            NatGateway.Type,
            clients.regionId,
            output?.regionId,
          );
          const name = yield* physicalName(id, news.name ?? output?.name, 128);
          const tags = yield* desiredTags(id, news.tags);
          let value = yield* get(output?.natGatewayId, name);
          if (value && !output && !(yield* hasAlchemyTags(id, tagsOf(value))))
            return yield* new AlibabaInvariantError({
              resourceType: NatGateway.Type,
              operation: "Recover",
              message:
                "NAT name belongs to an unowned gateway; adopt it explicitly",
            });
          if (!value) {
            yield* session.note(`Creating NAT gateway ${name}`);
            const response = yield* retryingSdkCall(
              "VPC",
              "CreateNatGateway",
              () =>
                clients.vpc.createNatGateway(
                  new VPC.CreateNatGatewayRequest({
                    regionId: clients.regionId,
                    name,
                    vpcId: news.vpcId,
                    vSwitchId: news.vSwitchId,
                    description: news.description,
                    natType: "Enhanced",
                    networkType: "internet",
                    instanceChargeType: "PostPaid",
                    internetChargeType: "PayByLcu",
                    eipBindMode: "NAT",
                    clientToken: `create-${instanceId}`,
                    tag: tagList(tags),
                  }),
                ),
            );
            const natGatewayId = yield* requireValue(
              response.body?.natGatewayId,
              NatGateway.Type,
              "CreateNatGateway",
              "Missing NAT gateway id",
            );
            value = yield* waitForPresent({
              service: "VPC",
              operation: "CreateNatGateway",
              read: get(natGatewayId),
              ready,
              wait: options.wait,
            });
          }
          const natGatewayId = yield* requireValue(
            value.natGatewayId,
            NatGateway.Type,
            "Read",
            "Missing NAT gateway id",
          );
          if (
            value.vpcId !== news.vpcId ||
            value.natGatewayPrivateInfo?.vswitchId !== news.vSwitchId
          )
            return yield* new AlibabaInvariantError({
              resourceType: NatGateway.Type,
              operation: "ObserveIdentity",
              message:
                "NAT gateway placement differs from the requested network",
            });
          if (
            value.name !== name ||
            (news.description !== undefined &&
              value.description !== news.description)
          )
            yield* retryingSdkCall("VPC", "ModifyNatGatewayAttribute", () =>
              clients.vpc.modifyNatGatewayAttribute(
                new VPC.ModifyNatGatewayAttributeRequest({
                  regionId: clients.regionId,
                  natGatewayId,
                  name,
                  description: news.description,
                }),
              ),
            );
          yield* syncTags(
            clients,
            "NATGATEWAY",
            natGatewayId,
            tagsOf(value),
            tags,
          );
          return yield* attrs(
            yield* waitForPresent({
              service: "VPC",
              operation: "ReconcileNatGateway",
              read: get(natGatewayId),
              ready: (v) =>
                ready(v) && v.name === name && tagsEqual(tagsOf(v), tags),
              wait: options.wait,
            }),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* requireRegion(
            NatGateway.Type,
            clients.regionId,
            output.regionId,
          );
          const value = yield* get(output.natGatewayId);
          if (!value) return;
          if (value.status !== "Deleting")
            yield* retryingSdkCall("VPC", "DeleteNatGateway", () =>
              clients.vpc.deleteNatGateway(
                new VPC.DeleteNatGatewayRequest({
                  regionId: clients.regionId,
                  natGatewayId: output.natGatewayId,
                  force: false,
                }),
              ),
            ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitForAbsent({
            service: "VPC",
            operation: "DeleteNatGateway",
            read: get(output.natGatewayId),
            wait: options.wait,
          });
        }),
      };
    }),
  );
