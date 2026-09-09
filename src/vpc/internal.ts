import * as VPC from "@alicloud/vpc20160428";
import { diffTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import type { AlibabaClientSet } from "../clients.ts";
import { retryingSdkCall } from "../error.ts";

export const tagList = (tags: Readonly<Record<string, string>>) =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));
export const tagRecord = (
  tags: readonly { key?: string; value?: string }[] = [],
) =>
  Object.fromEntries(
    tags.flatMap(({ key, value }) =>
      key === undefined || value === undefined ? [] : [[key, value]],
    ),
  );

export const syncTags = Effect.fn("VPC.syncTags")(function* (
  clients: AlibabaClientSet,
  resourceType: "EIP" | "NATGATEWAY",
  resourceId: string,
  observed: Record<string, string>,
  desired: Record<string, string>,
) {
  const { removed, upsert } = diffTags(observed, desired);
  if (upsert.length)
    yield* retryingSdkCall("VPC", "TagResources", () =>
      clients.vpc.tagResources(
        new VPC.TagResourcesRequest({
          regionId: clients.regionId,
          resourceType,
          resourceId: [resourceId],
          tag: upsert.map(({ Key, Value }) => ({ key: Key, value: Value })),
        }),
      ),
    );
  if (removed.length)
    yield* retryingSdkCall("VPC", "UnTagResources", () =>
      clients.vpc.unTagResources(
        new VPC.UnTagResourcesRequest({
          regionId: clients.regionId,
          resourceType,
          resourceId: [resourceId],
          tagKey: removed,
          all: false,
        }),
      ),
    );
});
