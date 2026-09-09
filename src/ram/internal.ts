import * as RAM from "@alicloud/ram20150501";
import { diffTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import type { AlibabaClientSet } from "../clients.ts";
import {
  AlibabaPaginationLimitError,
  retryingSdkCall,
  type AlibabaProviderError,
} from "../error.ts";

export type PolicyDocument = Readonly<Record<string, unknown>>;
export const tagList = (tags: Readonly<Record<string, string>>) =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));
export const pages = Effect.fn("RAM.pages")(function* <T>(
  operation: string,
  fetch: (
    marker?: string,
  ) => Effect.Effect<
    { items: readonly T[]; next?: string },
    AlibabaProviderError
  >,
) {
  const result: T[] = [];
  let marker: string | undefined;
  const visited = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const page = yield* fetch(marker);
    result.push(...page.items);
    if (!page.next) return result;
    if (visited.has(page.next)) break;
    visited.add(page.next);
    marker = page.next;
  }
  return yield* new AlibabaPaginationLimitError({
    service: "RAM",
    operation,
    maxPages: 200,
    pageSize: 100,
    observedItems: result.length,
    message: "RAM pagination did not terminate",
  });
});

export const ramTags = (
  clients: AlibabaClientSet,
  resourceType: "role" | "policy",
) => {
  const read = (name: string) =>
    pages("ListTagResources", (nextToken) =>
      retryingSdkCall("RAM", "ListTagResources", () =>
        clients.ram.listTagResources(
          new RAM.ListTagResourcesRequest({
            resourceType,
            resourceNames: [name],
            pageSize: 100,
            nextToken,
          }),
        ),
      ).pipe(
        Effect.map((r) => ({
          items: r.body?.tagResources ?? [],
          next: r.body?.nextToken,
        })),
      ),
    ).pipe(
      Effect.map((items) =>
        Object.fromEntries(
          items.flatMap((t) =>
            t.tagKey === undefined || t.tagValue === undefined
              ? []
              : [[t.tagKey, t.tagValue]],
          ),
        ),
      ),
    );
  const sync = Effect.fn("RAM.syncTags")(function* (
    name: string,
    desired: Record<string, string>,
  ) {
    const { removed, upsert } = diffTags(yield* read(name), desired);
    if (upsert.length)
      yield* retryingSdkCall("RAM", "TagResources", () =>
        clients.ram.tagResources(
          new RAM.TagResourcesRequest({
            resourceType,
            resourceNames: [name],
            tag: upsert.map(({ Key, Value }) => ({ key: Key, value: Value })),
          }),
        ),
      );
    if (removed.length)
      yield* retryingSdkCall("RAM", "UntagResources", () =>
        clients.ram.untagResources(
          new RAM.UntagResourcesRequest({
            resourceType,
            resourceNames: [name],
            tagKeys: removed,
            all: false,
          }),
        ),
      );
  });
  return { read, sync };
};
