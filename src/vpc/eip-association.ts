import * as VPC from "@alicloud/vpc20160428";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { AlibabaClients } from "../clients.ts";
import {
  AlibabaInvariantError,
  isNotFound,
  retryingSdkCall,
} from "../error.ts";
import {
  requireRegion,
  waitFor,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Providers } from "../providers.ts";

export interface EipAssociationProps {
  readonly allocationId: string;
  readonly instanceId: string;
  readonly instanceType: "Nat" | "EcsInstance";
}
export interface EipAssociationAttributes extends EipAssociationProps {
  readonly regionId: string;
  /** Reference this output from SNAT to order association before SNAT creation. */
  readonly ipAddress: string;
}
export type EipAssociation = Resource<
  "Alibaba.VPC.EipAssociation",
  EipAssociationProps,
  EipAssociationAttributes,
  never,
  Providers
>;
export const EipAssociation = Resource<EipAssociation>(
  "Alibaba.VPC.EipAssociation",
);
export const EipAssociationProvider = (
  options: { readonly wait?: WaitOptions } = {},
) =>
  Provider.effect(
    EipAssociation,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const get = (allocationId: string) =>
        retryingSdkCall("VPC", "DescribeEipAddresses", () =>
          clients.vpc.describeEipAddresses(
            new VPC.DescribeEipAddressesRequest({
              regionId: clients.regionId,
              allocationId,
            }),
          ),
        ).pipe(
          Effect.map((r) =>
            r.body?.eipAddresses?.eipAddress?.find(
              (value) => value.allocationId === allocationId,
            ),
          ),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
      const matches = (
        value:
          | VPC.DescribeEipAddressesResponseBodyEipAddressesEipAddress
          | undefined,
        props: EipAssociationProps,
      ) =>
        value?.instanceId === props.instanceId &&
        value.instanceType === props.instanceType;
      return {
        version: 1,
        stables: ["allocationId", "instanceId", "instanceType", "regionId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (
            !("allocationId" in news) ||
            !("instanceId" in news) ||
            !isResolved(news.allocationId) ||
            !isResolved(news.instanceId)
          )
            return { action: "replace", deleteFirst: true };
          if (!isResolved<EipAssociationProps>(news)) return;
          if (
            olds.allocationId !== news.allocationId ||
            olds.instanceId !== news.instanceId ||
            olds.instanceType !== news.instanceType
          )
            return { action: "replace", deleteFirst: true };
          if (output) {
            yield* requireRegion(
              EipAssociation.Type,
              clients.regionId,
              output.regionId,
            );
            if (!matches(yield* get(news.allocationId), news))
              return { action: "update" };
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          yield* requireRegion(
            EipAssociation.Type,
            clients.regionId,
            output?.regionId,
          );
          const value = yield* get(output?.allocationId ?? olds.allocationId);
          return matches(value, output ?? olds) && value?.ipAddress
            ? {
                ...olds,
                regionId: clients.regionId,
                ipAddress: value.ipAddress,
              }
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          yield* requireRegion(
            EipAssociation.Type,
            clients.regionId,
            output?.regionId,
          );
          if (
            output &&
            (output.allocationId !== news.allocationId ||
              output.instanceId !== news.instanceId ||
              output.instanceType !== news.instanceType)
          ) {
            if (matches(yield* get(output.allocationId), output)) {
              yield* retryingSdkCall("VPC", "UnassociateEipAddress", () =>
                clients.vpc.unassociateEipAddress(
                  new VPC.UnassociateEipAddressRequest({
                    allocationId: output.allocationId,
                    instanceId: output.instanceId,
                    instanceType: output.instanceType,
                    regionId: clients.regionId,
                    force: false,
                  }),
                ),
              );
              yield* waitFor({
                service: "VPC",
                operation: "UnassociatePreviousEip",
                read: get(output.allocationId),
                ready: (v) => !matches(v, output),
                wait: options.wait,
              });
            }
          }
          let value = yield* get(news.allocationId);
          if (!matches(value, news)) {
            if (value?.instanceId)
              return yield* new AlibabaInvariantError({
                resourceType: EipAssociation.Type,
                operation: "Associate",
                message: "EIP is already associated with another target",
              });
            yield* retryingSdkCall("VPC", "AssociateEipAddress", () =>
              clients.vpc.associateEipAddress(
                new VPC.AssociateEipAddressRequest({
                  ...news,
                  regionId: clients.regionId,
                }),
              ),
            );
            value = yield* waitFor({
              service: "VPC",
              operation: "AssociateEipAddress",
              read: get(news.allocationId),
              ready: (v) => matches(v, news) && v?.status === "InUse",
              wait: options.wait,
            });
          }
          if (!value?.ipAddress)
            return yield* new AlibabaInvariantError({
              resourceType: EipAssociation.Type,
              operation: "Read",
              message: "EIP has no public address",
            });
          return {
            ...news,
            regionId: clients.regionId,
            ipAddress: value.ipAddress,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* requireRegion(
            EipAssociation.Type,
            clients.regionId,
            output.regionId,
          );
          if (!matches(yield* get(output.allocationId), output)) return;
          yield* retryingSdkCall("VPC", "UnassociateEipAddress", () =>
            clients.vpc.unassociateEipAddress(
              new VPC.UnassociateEipAddressRequest({
                allocationId: output.allocationId,
                instanceId: output.instanceId,
                instanceType: output.instanceType,
                regionId: clients.regionId,
                force: false,
              }),
            ),
          ).pipe(
            // Alchemy may begin delete-first replacements concurrently. Give
            // the managed SNAT child time to disappear, without forcing detach.
            Effect.retry({
              while: (error) =>
                error.code?.startsWith("DependencyViolation") === true,
              times: Math.max(0, (options.wait?.attempts ?? 60) - 1),
              schedule: Schedule.spaced(options.wait?.interval ?? "5 seconds"),
            }),
            Effect.catchIf(isNotFound, () => Effect.void),
          );
          yield* waitFor({
            service: "VPC",
            operation: "UnassociateEipAddress",
            read: get(output.allocationId),
            ready: (value) => !matches(value, output),
            wait: options.wait,
          });
        }),
      };
    }),
  );
