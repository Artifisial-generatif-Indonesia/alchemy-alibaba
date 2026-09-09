import * as ECS from "@alicloud/ecs20140526";
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
import { requireRecoveryOwnership, uniqueMatch } from "../internal/identity.ts";
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

/** Imports an OpenSSH public key. Private keys stay outside the resource graph. */
export interface KeyPairProps {
  readonly name?: string;
  readonly publicKey: string;
  readonly tags?: Readonly<Record<string, string>>;
}
export interface KeyPairAttributes {
  readonly name: string;
  readonly fingerprint: string;
  readonly publicKey?: string;
  readonly regionId: string;
  readonly tags: Readonly<Record<string, string>>;
}
export type KeyPair = Resource<
  "Alibaba.ECS.KeyPair",
  KeyPairProps,
  KeyPairAttributes,
  never,
  Providers
>;
export const KeyPair = Resource<KeyPair>("Alibaba.ECS.KeyPair");
const keyMaterial = (value: string) =>
  value.trim().split(/\s+/).slice(0, 2).join(" ");
export const KeyPairProvider = (
  options: { readonly wait?: WaitOptions } = {},
) =>
  Provider.effect(
    KeyPair,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const inventory = (name?: string) =>
        paginate({
          service: "ECS",
          operation: "DescribeKeyPairs",
          page: ({ pageNumber, pageSize }) =>
            retryingSdkCall("ECS", "DescribeKeyPairs", () =>
              clients.ecs.describeKeyPairs(
                new ECS.DescribeKeyPairsRequest({
                  regionId: clients.regionId,
                  keyPairName: name,
                  includePublicKey: true,
                  pageNumber,
                  pageSize,
                }),
              ),
            ).pipe(
              Effect.map((r) => ({
                items: r.body?.keyPairs?.keyPair ?? [],
                totalCount: r.body?.totalCount,
              })),
              Effect.catchIf(isNotFound, () => Effect.succeed({ items: [] })),
            ),
        });
      const get = (name: string) =>
        inventory(name).pipe(
          Effect.flatMap((items) =>
            uniqueMatch(
              items.filter((v) => v.keyPairName === name),
              KeyPair.Type,
            ),
          ),
        );
      const attrs = Effect.fn("ECS.KeyPair.attributes")(function* (
        v: ECS.DescribeKeyPairsResponseBodyKeyPairsKeyPair,
      ) {
        return {
          name: yield* requireValue(
            v.keyPairName,
            KeyPair.Type,
            "Read",
            "Missing key pair name",
          ),
          fingerprint: yield* requireValue(
            v.keyPairFingerPrint,
            KeyPair.Type,
            "Read",
            "Missing key pair fingerprint",
          ),
          publicKey: v.publicKey,
          regionId: clients.regionId,
          tags: userTags(tagRecord(v.tags?.tag)),
        };
      });
      return {
        version: 1,
        stables: ["name", "fingerprint", "regionId"],
        list: () => inventory().pipe(Effect.flatMap(Effect.forEach(attrs))),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return;
          if (
            olds.name !== news.name ||
            keyMaterial(olds.publicKey) !== keyMaterial(news.publicKey)
          )
            return {
              action: "replace",
              deleteFirst: olds.name === news.name && news.name !== undefined,
            };
          if (output) {
            yield* requireRegion(
              KeyPair.Type,
              clients.regionId,
              output.regionId,
            );
            const v = yield* get(output.name);
            if (
              !v ||
              !tagsEqual(userTags(tagRecord(v.tags?.tag)), news.tags ?? {})
            )
              return { action: "update" };
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          yield* requireRegion(
            KeyPair.Type,
            clients.regionId,
            output?.regionId,
          );
          const v = yield* get(
            output?.name ?? (yield* physicalName(id, olds.name, 128)),
          );
          if (!v) return;
          const result = yield* attrs(v);
          return (yield* hasAlchemyTags(id, tagRecord(v.tags?.tag)))
            ? result
            : Unowned(result);
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          yield* requireRegion(
            KeyPair.Type,
            clients.regionId,
            output?.regionId,
          );
          if (news.publicKey.includes("PRIVATE KEY"))
            return yield* new AlibabaInvariantError({
              resourceType: KeyPair.Type,
              operation: "Validate",
              message: "KeyPair requires an OpenSSH public key",
            });
          const name = yield* physicalName(id, news.name ?? output?.name, 128),
            tags = yield* desiredTags(id, news.tags);
          let v = yield* get(name);
          if (v && !output)
            yield* requireRecoveryOwnership(
              id,
              KeyPair.Type,
              tagRecord(v.tags?.tag),
            );
          if (!v) {
            yield* retryingSdkCall("ECS", "ImportKeyPair", () =>
              clients.ecs.importKeyPair(
                new ECS.ImportKeyPairRequest({
                  regionId: clients.regionId,
                  keyPairName: name,
                  publicKeyBody: news.publicKey,
                  tag: tagList(tags),
                }),
              ),
            );
            v = yield* waitForPresent({
              service: "ECS",
              operation: "ImportKeyPair",
              read: get(name),
              ready: () => true,
              wait: options.wait,
            });
          }
          if (
            v.publicKey &&
            keyMaterial(v.publicKey) !== keyMaterial(news.publicKey)
          )
            return yield* new AlibabaInvariantError({
              resourceType: KeyPair.Type,
              operation: "ObserveIdentity",
              message: "Existing key pair contains different key material",
            });
          yield* syncTags(
            clients,
            "keypair",
            name,
            tagRecord(v.tags?.tag),
            tags,
          );
          return yield* attrs(
            yield* waitForPresent({
              service: "ECS",
              operation: "ReconcileKeyPair",
              read: get(name),
              ready: (v) => tagsEqual(tagRecord(v.tags?.tag), tags),
              wait: options.wait,
            }),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* requireRegion(KeyPair.Type, clients.regionId, output.regionId);
          if (!(yield* get(output.name))) return;
          yield* retryingSdkCall("ECS", "DeleteKeyPairs", () =>
            clients.ecs.deleteKeyPairs(
              new ECS.DeleteKeyPairsRequest({
                regionId: clients.regionId,
                keyPairNames: JSON.stringify([output.name]),
              }),
            ),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitForAbsent({
            service: "ECS",
            operation: "DeleteKeyPairs",
            read: get(output.name),
            wait: options.wait,
          });
        }),
      };
    }),
  );
