import * as ECS from "@alicloud/ecs20140526";
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
import {
  requireRegion,
  waitFor,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Providers } from "../providers.ts";
import { getDisk } from "./disk.ts";

export interface DiskAttachmentProps {
  readonly diskId: string;
  readonly instanceId: string;
}
export interface DiskAttachmentAttributes extends DiskAttachmentProps {
  readonly regionId: string;
  readonly device?: string;
}
export type DiskAttachment = Resource<
  "Alibaba.ECS.DiskAttachment",
  DiskAttachmentProps,
  DiskAttachmentAttributes,
  never,
  Providers
>;
export const DiskAttachment = Resource<DiskAttachment>(
  "Alibaba.ECS.DiskAttachment",
);
export const DiskAttachmentProvider = (
  options: { readonly wait?: WaitOptions } = {},
) =>
  Provider.effect(
    DiskAttachment,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      return {
        version: 1,
        stables: ["diskId", "instanceId", "regionId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return;
          if (
            olds.diskId !== news.diskId ||
            olds.instanceId !== news.instanceId
          )
            return { action: "replace", deleteFirst: true };
          if (output) {
            yield* requireRegion(
              DiskAttachment.Type,
              clients.regionId,
              output.regionId,
            );
            if (
              (yield* getDisk(clients, news.diskId))?.instanceId !==
              news.instanceId
            )
              return { action: "update" };
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          yield* requireRegion(
            DiskAttachment.Type,
            clients.regionId,
            output?.regionId,
          );
          const p = output ?? olds,
            v = yield* getDisk(clients, p.diskId);
          return v?.instanceId === p.instanceId
            ? { ...p, regionId: clients.regionId, device: v.device }
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          yield* requireRegion(
            DiskAttachment.Type,
            clients.regionId,
            output?.regionId,
          );
          if (
            output &&
            (output.diskId !== news.diskId ||
              output.instanceId !== news.instanceId)
          ) {
            const previous = yield* getDisk(clients, output.diskId);
            if (previous?.instanceId === output.instanceId) {
              yield* retryingSdkCall("ECS", "DetachDisk", () =>
                clients.ecs.detachDisk(
                  new ECS.DetachDiskRequest({
                    diskId: output.diskId,
                    instanceId: output.instanceId,
                    deleteWithInstance: false,
                  }),
                ),
              );
              yield* waitFor({
                service: "ECS",
                operation: "DetachPreviousDisk",
                read: getDisk(clients, output.diskId),
                ready: (v) => !v || v.status === "Available",
                wait: options.wait,
              });
            }
          }
          let v = yield* getDisk(clients, news.diskId);
          if (v?.instanceId && v.instanceId !== news.instanceId)
            return yield* new AlibabaInvariantError({
              resourceType: DiskAttachment.Type,
              operation: "AttachDisk",
              message: "Disk is already attached to another instance",
            });
          if (v?.instanceId !== news.instanceId)
            yield* retryingSdkCall("ECS", "AttachDisk", () =>
              clients.ecs.attachDisk(
                new ECS.AttachDiskRequest({
                  ...news,
                  deleteWithInstance: false,
                  bootable: false,
                }),
              ),
            );
          else if (v.deleteWithInstance !== false)
            yield* retryingSdkCall("ECS", "ModifyDiskAttribute", () =>
              clients.ecs.modifyDiskAttribute(
                new ECS.ModifyDiskAttributeRequest({
                  diskId: news.diskId,
                  deleteWithInstance: false,
                }),
              ),
            );
          v = yield* waitFor({
            service: "ECS",
            operation: "AttachDisk",
            read: getDisk(clients, news.diskId),
            ready: (v) =>
              v?.instanceId === news.instanceId &&
              v.status === "In_use" &&
              v.deleteWithInstance === false,
            wait: options.wait,
          });
          return { ...news, regionId: clients.regionId, device: v?.device };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* requireRegion(
            DiskAttachment.Type,
            clients.regionId,
            output.regionId,
          );
          if (
            (yield* getDisk(clients, output.diskId))?.instanceId !==
            output.instanceId
          )
            return;
          yield* retryingSdkCall("ECS", "DetachDisk", () =>
            clients.ecs.detachDisk(
              new ECS.DetachDiskRequest({
                diskId: output.diskId,
                instanceId: output.instanceId,
                deleteWithInstance: false,
              }),
            ),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitFor({
            service: "ECS",
            operation: "DetachDisk",
            read: getDisk(clients, output.diskId),
            ready: (v) => !v || v.status === "Available",
            wait: options.wait,
          });
        }),
      };
    }),
  );
