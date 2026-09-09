import * as ECS from "@alicloud/ecs20140526";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { hasAlchemyTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import { isDeepStrictEqual } from "node:util";
import { AlibabaClients, type AlibabaClientSet } from "../clients.ts";
import {
  AlibabaInvariantError,
  isIncorrectInstanceState,
  isNotFound,
  isTransient,
  retryingSdkCall,
  sdkCall,
} from "../error.ts";
import {
  replacement,
  requireRecoveryOwnership,
  uniqueMatch,
} from "../internal/identity.ts";
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
  waitUntilAccepted,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Providers } from "../providers.ts";
import { syncTags, tagList, tagRecord } from "./internal.ts";

export interface DiskProps {
  readonly name?: string;
  readonly zoneId: string;
  /** GiB; only increases are supported. Filesystem expansion remains guest-owned. */
  readonly size: number;
  readonly category?:
    | "cloud_essd"
    | "cloud_essd_entry"
    | "cloud_ssd"
    | "cloud_efficiency";
  readonly encrypted?: boolean;
  readonly kmsKeyId?: string;
  readonly description?: string;
  readonly tags?: Readonly<Record<string, string>>;
}
export interface DiskAttributes {
  readonly diskId: string;
  readonly name: string;
  readonly zoneId: string;
  readonly regionId: string;
  readonly size: number;
  readonly status?: string;
  readonly instanceId?: string;
  readonly tags: Readonly<Record<string, string>>;
}
export type Disk = Resource<
  "Alibaba.ECS.Disk",
  DiskProps,
  DiskAttributes,
  never,
  Providers
>;
export const Disk = Resource<Disk>("Alibaba.ECS.Disk");
const inventory = (clients: AlibabaClientSet, diskId?: string, name?: string) =>
  paginate({
    service: "ECS",
    operation: "DescribeDisks",
    page: ({ pageNumber, pageSize }) =>
      retryingSdkCall("ECS", "DescribeDisks", () =>
        clients.ecs.describeDisks(
          new ECS.DescribeDisksRequest({
            regionId: clients.regionId,
            diskIds: diskId ? JSON.stringify([diskId]) : undefined,
            diskName: name,
            diskType: "data",
            pageNumber,
            pageSize,
          }),
        ),
      ).pipe(
        Effect.map((r) => ({
          items: r.body?.disks?.disk ?? [],
          totalCount: r.body?.totalCount,
        })),
        Effect.catchIf(isNotFound, () => Effect.succeed({ items: [] })),
      ),
  });
export const getDisk = (
  clients: AlibabaClientSet,
  diskId?: string,
  name?: string,
) =>
  inventory(clients, diskId, name).pipe(
    Effect.flatMap((items) =>
      uniqueMatch(
        items.filter((v) =>
          diskId ? v.diskId === diskId : v.diskName === name,
        ),
        Disk.Type,
      ),
    ),
  );
const identity = (props: DiskProps) => ({
  zoneId: props.zoneId,
  category: props.category ?? "cloud_essd",
  encrypted: props.encrypted ?? false,
  kmsKeyId: props.kmsKeyId,
});
export const DiskProvider = (options: { readonly wait?: WaitOptions } = {}) =>
  Provider.effect(
    Disk,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const attrs = Effect.fn("ECS.Disk.attributes")(function* (
        v: ECS.DescribeDisksResponseBodyDisksDisk,
      ) {
        return {
          diskId: yield* requireValue(
            v.diskId,
            Disk.Type,
            "Read",
            "Missing disk id",
          ),
          name: v.diskName ?? "",
          regionId: clients.regionId,
          zoneId: yield* requireValue(
            v.zoneId,
            Disk.Type,
            "Read",
            "Missing disk zone",
          ),
          size: yield* requireValue(
            v.size,
            Disk.Type,
            "Read",
            "Missing disk size",
          ),
          status: v.status,
          instanceId: v.instanceId || undefined,
          tags: userTags(tagRecord(v.tags?.tag)),
        };
      });
      return {
        version: 1,
        stables: ["diskId", "zoneId", "regionId"],
        list: () =>
          inventory(clients).pipe(Effect.flatMap(Effect.forEach(attrs))),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return;
          if (!isDeepStrictEqual(identity(olds), identity(news)))
            return yield* replacement(Disk.Type, olds.name, news.name);
          if (output) {
            yield* requireRegion(Disk.Type, clients.regionId, output.regionId);
            const v = yield* getDisk(clients, output.diskId);
            if (
              !v ||
              v.size !== news.size ||
              v.diskName !== (news.name ?? output.name) ||
              !tagsEqual(userTags(tagRecord(v.tags?.tag)), news.tags ?? {})
            )
              return { action: "update" };
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          yield* requireRegion(Disk.Type, clients.regionId, output?.regionId);
          const v = yield* getDisk(
            clients,
            output?.diskId,
            yield* physicalName(id, olds.name ?? output?.name, 128),
          );
          if (!v) return;
          const result = yield* attrs(v);
          return (yield* hasAlchemyTags(id, tagRecord(v.tags?.tag)))
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
          yield* requireRegion(Disk.Type, clients.regionId, output?.regionId);
          const name = yield* physicalName(id, news.name ?? output?.name, 128),
            tags = yield* desiredTags(id, news.tags);
          let v = yield* getDisk(clients, output?.diskId, name);
          if (v && !output)
            yield* requireRecoveryOwnership(
              id,
              Disk.Type,
              tagRecord(v.tags?.tag),
            );
          if (!v) {
            yield* session.note(`Creating data disk ${name}`);
            const r = yield* retryingSdkCall("ECS", "CreateDisk", () =>
              clients.ecs.createDisk(
                new ECS.CreateDiskRequest({
                  regionId: clients.regionId,
                  zoneId: news.zoneId,
                  diskName: name,
                  size: news.size,
                  diskCategory: news.category ?? "cloud_essd",
                  encrypted: news.encrypted ?? false,
                  KMSKeyId: news.kmsKeyId,
                  description: news.description,
                  clientToken: `create-${instanceId}`,
                  tag: tagList(tags),
                }),
              ),
            );
            const diskId = yield* requireValue(
              r.body?.diskId,
              Disk.Type,
              "CreateDisk",
              "Missing disk id",
            );
            v = yield* waitForPresent({
              service: "ECS",
              operation: "CreateDisk",
              read: getDisk(clients, diskId),
              ready: (v) => v.status === "Available",
              wait: options.wait,
            });
          }
          const diskId = yield* requireValue(
            v.diskId,
            Disk.Type,
            "Read",
            "Missing disk id",
          );
          if ((v.size ?? 0) > news.size)
            return yield* new AlibabaInvariantError({
              resourceType: Disk.Type,
              operation: "ResizeDisk",
              message: "ECS data disks cannot shrink",
            });
          if (v.size !== news.size)
            yield* waitUntilAccepted({
              service: "ECS",
              operation: "ResizeDisk",
              request: sdkCall("ECS", "ResizeDisk", () =>
                clients.ecs.resizeDisk(
                  new ECS.ResizeDiskRequest({
                    diskId,
                    newSize: news.size,
                    type: v.status === "In_use" ? "online" : "offline",
                  }),
                ),
              ),
              // A concurrent VM resize restarts the attached instance. ECS
              // reports this state conflict as OperationDenied, not always
              // IncorrectInstanceStatus. Keep this retry local and bounded;
              // an unsupported operation still surfaces its original error.
              retryIf: (error) =>
                isTransient(error) ||
                isIncorrectInstanceState(error) ||
                error.code === "InvalidStatus.Upgrading" ||
                error.code === "InvalidInstanceStatus.NotRunning" ||
                (error.code === "OperationDenied" && !!v.instanceId),
              wait: options.wait,
            });
          if (
            v.diskName !== name ||
            (news.description !== undefined &&
              v.description !== news.description)
          )
            yield* retryingSdkCall("ECS", "ModifyDiskAttribute", () =>
              clients.ecs.modifyDiskAttribute(
                new ECS.ModifyDiskAttributeRequest({
                  diskId,
                  diskName: name,
                  description: news.description,
                }),
              ),
            );
          yield* syncTags(
            clients,
            "disk",
            diskId,
            tagRecord(v.tags?.tag),
            tags,
          );
          return yield* attrs(
            yield* waitForPresent({
              service: "ECS",
              operation: "ReconcileDisk",
              read: getDisk(clients, diskId),
              ready: (v) =>
                v.size === news.size &&
                v.diskName === name &&
                tagsEqual(tagRecord(v.tags?.tag), tags),
              wait: options.wait,
            }),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* requireRegion(Disk.Type, clients.regionId, output.regionId);
          if (!(yield* getDisk(clients, output.diskId))) return;
          yield* retryingSdkCall("ECS", "DeleteDisk", () =>
            clients.ecs.deleteDisk(
              new ECS.DeleteDiskRequest({ diskId: output.diskId }),
            ),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitForAbsent({
            service: "ECS",
            operation: "DeleteDisk",
            read: getDisk(clients, output.diskId),
            wait: options.wait,
          });
        }),
      };
    }),
  );
