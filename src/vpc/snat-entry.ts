import * as VPC from "@alicloud/vpc20160428";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { AlibabaClients } from "../clients.ts";
import {
  AlibabaInvariantError,
  isNotFound,
  retryingSdkCall,
} from "../error.ts";
import { uniqueMatch } from "../internal/identity.ts";
import {
  paginate,
  physicalName,
  requireRegion,
  requireValue,
  waitForAbsent,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Providers } from "../providers.ts";

export interface SnatEntryProps {
  readonly snatTableId: string;
  readonly sourceVSwitchId: string;
  /** Use EipAssociation.ipAddress to establish the association dependency. */
  readonly snatIp: string;
  readonly name?: string;
}
export interface SnatEntryAttributes extends SnatEntryProps {
  readonly snatEntryId: string;
  readonly regionId: string;
}
export type SnatEntry = Resource<
  "Alibaba.VPC.SnatEntry",
  SnatEntryProps,
  SnatEntryAttributes,
  never,
  Providers
>;
export const SnatEntry = Resource<SnatEntry>("Alibaba.VPC.SnatEntry");
export const SnatEntryProvider = (
  options: { readonly wait?: WaitOptions } = {},
) =>
  Provider.effect(
    SnatEntry,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const get = (props: SnatEntryProps, snatEntryId?: string) =>
        paginate({
          service: "VPC",
          operation: "DescribeSnatTableEntries",
          page: ({ pageNumber, pageSize }) =>
            retryingSdkCall("VPC", "DescribeSnatTableEntries", () =>
              clients.vpc.describeSnatTableEntries(
                new VPC.DescribeSnatTableEntriesRequest({
                  regionId: clients.regionId,
                  snatTableId: props.snatTableId,
                  snatEntryId,
                  sourceVSwitchId: snatEntryId
                    ? undefined
                    : props.sourceVSwitchId,
                  pageNumber,
                  pageSize,
                }),
              ),
            ).pipe(
              Effect.map((r) => ({
                items: r.body?.snatTableEntries?.snatTableEntry ?? [],
                totalCount: r.body?.totalCount,
              })),
              Effect.catchIf(isNotFound, () => Effect.succeed({ items: [] })),
            ),
        }).pipe(
          Effect.flatMap((items) =>
            uniqueMatch(
              items.filter((v) =>
                snatEntryId
                  ? v.snatEntryId === snatEntryId
                  : v.sourceVSwitchId === props.sourceVSwitchId,
              ),
              SnatEntry.Type,
            ),
          ),
        );
      const attrs = Effect.fn("VPC.SnatEntry.attributes")(function* (
        props: SnatEntryProps,
        value: VPC.DescribeSnatTableEntriesResponseBodySnatTableEntriesSnatTableEntry,
      ) {
        return {
          ...props,
          snatIp: value.snatIp ?? props.snatIp,
          name: value.snatEntryName,
          snatEntryId: yield* requireValue(
            value.snatEntryId,
            SnatEntry.Type,
            "Read",
            "Missing SNAT entry id",
          ),
          regionId: clients.regionId,
        };
      });
      return {
        version: 1,
        stables: ["snatEntryId", "snatTableId", "sourceVSwitchId", "regionId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          // A replaced NAT produces an unresolved table ID during planning.
          // This child must get a new generation so cleanup retains its old table.
          if (
            !("snatTableId" in news) ||
            !("sourceVSwitchId" in news) ||
            !isResolved(news.snatTableId) ||
            !isResolved(news.sourceVSwitchId)
          )
            return { action: "replace", deleteFirst: true };
          if (!isResolved<SnatEntryProps>(news)) return;
          if (
            olds.snatTableId !== news.snatTableId ||
            olds.sourceVSwitchId !== news.sourceVSwitchId
          )
            return { action: "replace" };
          if (output) {
            yield* requireRegion(
              SnatEntry.Type,
              clients.regionId,
              output.regionId,
            );
            const value = yield* get(news, output.snatEntryId);
            if (
              !value ||
              value.snatIp !== news.snatIp ||
              value.snatEntryName !== (news.name ?? output.name)
            )
              return { action: "update" };
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          yield* requireRegion(
            SnatEntry.Type,
            clients.regionId,
            output?.regionId,
          );
          if (!olds.snatTableId) return;
          const value = yield* get(olds, output?.snatEntryId);
          if (value) return yield* attrs(olds, value);
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
          yield* requireRegion(
            SnatEntry.Type,
            clients.regionId,
            output?.regionId,
          );
          const name = yield* physicalName(id, news.name ?? output?.name, 128);
          if (
            output &&
            (output.snatTableId !== news.snatTableId ||
              output.sourceVSwitchId !== news.sourceVSwitchId)
          )
            return yield* new AlibabaInvariantError({
              resourceType: SnatEntry.Type,
              operation: "ReconcileIdentity",
              message:
                "SNAT source or table changed without a replacement plan; re-plan before continuing",
            });
          let value = yield* get(news, output?.snatEntryId);
          if (!output && value && value.snatEntryName !== name)
            return yield* new AlibabaInvariantError({
              resourceType: SnatEntry.Type,
              operation: "Recover",
              message: "Another SNAT entry already owns this source vSwitch",
            });
          if (!value) {
            const response = yield* retryingSdkCall(
              "VPC",
              "CreateSnatEntry",
              () =>
                clients.vpc.createSnatEntry(
                  new VPC.CreateSnatEntryRequest({
                    regionId: clients.regionId,
                    snatTableId: news.snatTableId,
                    sourceVSwitchId: news.sourceVSwitchId,
                    snatIp: news.snatIp,
                    snatEntryName: name,
                    clientToken: `create-${instanceId}`,
                  }),
                ),
            );
            const entryId = yield* requireValue(
              response.body?.snatEntryId,
              SnatEntry.Type,
              "CreateSnatEntry",
              "Missing SNAT entry id",
            );
            value = yield* waitForPresent({
              service: "VPC",
              operation: "CreateSnatEntry",
              read: get(news, entryId),
              ready: (v) => v.status === "Available",
              wait: options.wait,
            });
          }
          const entryId = yield* requireValue(
            value.snatEntryId,
            SnatEntry.Type,
            "Read",
            "Missing SNAT entry id",
          );
          if (value.snatIp !== news.snatIp || value.snatEntryName !== name)
            yield* retryingSdkCall("VPC", "ModifySnatEntry", () =>
              clients.vpc.modifySnatEntry(
                new VPC.ModifySnatEntryRequest({
                  regionId: clients.regionId,
                  snatTableId: news.snatTableId,
                  snatEntryId: entryId,
                  snatIp: news.snatIp,
                  snatEntryName: name,
                }),
              ),
            );
          return yield* attrs(
            news,
            yield* waitForPresent({
              service: "VPC",
              operation: "ReconcileSnatEntry",
              read: get(news, entryId),
              ready: (v) =>
                v.status === "Available" &&
                v.snatIp === news.snatIp &&
                v.snatEntryName === name,
              wait: options.wait,
            }),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* requireRegion(
            SnatEntry.Type,
            clients.regionId,
            output.regionId,
          );
          const value = yield* get(output, output.snatEntryId);
          if (!value) return;
          if (value.status !== "Deleting")
            yield* retryingSdkCall("VPC", "DeleteSnatEntry", () =>
              clients.vpc.deleteSnatEntry(
                new VPC.DeleteSnatEntryRequest({
                  regionId: clients.regionId,
                  snatTableId: output.snatTableId,
                  snatEntryId: output.snatEntryId,
                }),
              ),
            ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitForAbsent({
            service: "VPC",
            operation: "DeleteSnatEntry",
            read: get(output, output.snatEntryId),
            wait: options.wait,
          });
        }),
      };
    }),
  );
