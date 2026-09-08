import * as ECS from "@alicloud/ecs20140526";
import * as Effect from "effect/Effect";
import type { AlibabaClientSet } from "../clients.ts";
import {
  AlibabaInvariantError,
  retryingSdkCall,
  AlibabaProviderError,
} from "../error.ts";
import { tagsEqual } from "../internal/lifecycle.ts";

export const missing = (code: string) => (error: unknown) =>
  error instanceof AlibabaProviderError &&
  error.service === "ECS" &&
  error.code === code;

export const tagList = (tags: Readonly<Record<string, string>>) =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));

export const tagRecord = (
  tags: readonly { tagKey?: string; tagValue?: string }[] = [],
) =>
  Object.fromEntries(
    tags.flatMap((tag) =>
      tag.tagKey === undefined || tag.tagValue === undefined
        ? []
        : [[tag.tagKey, tag.tagValue]],
    ),
  );

export const syncTags = Effect.fn("ECS.syncTags")(function* (
  clients: AlibabaClientSet,
  resourceType: "instance" | "securitygroup",
  resourceId: string,
  observed: Readonly<Record<string, string>>,
  desired: Readonly<Record<string, string>>,
) {
  if (tagsEqual(observed, desired)) return;
  const changed = Object.fromEntries(
    Object.entries(desired).filter(([key, value]) => observed[key] !== value),
  );
  const removed = Object.keys(observed).filter((key) => !(key in desired));
  if (Object.keys(changed).length)
    yield* retryingSdkCall("ECS", "TagResources", () =>
      clients.ecs.tagResources(
        new ECS.TagResourcesRequest({
          regionId: clients.regionId,
          resourceType,
          resourceId: [resourceId],
          tag: tagList(changed),
        }),
      ),
    );
  if (removed.length)
    yield* retryingSdkCall("ECS", "UntagResources", () =>
      clients.ecs.untagResources(
        new ECS.UntagResourcesRequest({
          regionId: clients.regionId,
          resourceType,
          resourceId: [resourceId],
          tagKey: removed,
          all: false,
        }),
      ),
    );
});

export const unique = <T>(items: readonly T[], resourceType: string) =>
  items.length > 1
    ? Effect.fail(
        new AlibabaInvariantError({
          resourceType,
          operation: "ObserveIdentity",
          message:
            "Multiple resources match the requested identity; resolve the inventory before continuing",
        }),
      )
    : Effect.succeed(items[0]);
