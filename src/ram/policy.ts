import * as RAM from "@alicloud/ram20150501";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { hasAlchemyTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import { AlibabaClients } from "../clients.ts";
import { isNotFound, retryingSdkCall } from "../error.ts";
import { requireRecoveryOwnership } from "../internal/identity.ts";
import {
  desiredTags,
  physicalName,
  tagsEqual,
  userTags,
  waitForAbsent,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import { jsonConfigMatches } from "../internal/observation.ts";
import type { Providers } from "../providers.ts";
import { ramTags, tagList, type PolicyDocument } from "./internal.ts";

export interface PolicyProps {
  readonly name?: string;
  readonly document: PolicyDocument;
  readonly description?: string;
  readonly tags?: Readonly<Record<string, string>>;
}
export interface PolicyAttributes {
  readonly name: string;
  readonly policyType: "Custom";
  readonly defaultVersion?: string;
  readonly document: string;
  readonly description?: string;
  readonly tags: Readonly<Record<string, string>>;
}
export type Policy = Resource<
  "Alibaba.RAM.Policy",
  PolicyProps,
  PolicyAttributes,
  never,
  Providers
>;
export const Policy = Resource<Policy>("Alibaba.RAM.Policy");
export const PolicyProvider = (options: { readonly wait?: WaitOptions } = {}) =>
  Provider.effect(
    Policy,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const tags = ramTags(clients, "policy");
      const get = (name: string) =>
        retryingSdkCall("RAM", "GetPolicy", () =>
          clients.ram.getPolicy(
            new RAM.GetPolicyRequest({
              policyName: name,
              policyType: "Custom",
            }),
          ),
        ).pipe(
          Effect.map((r) =>
            r.body?.policy
              ? {
                  policy: r.body.policy,
                  document:
                    r.body.defaultPolicyVersion?.policyDocument ??
                    r.body.policy.policyDocument,
                }
              : undefined,
          ),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
      const attrs = Effect.fn("RAM.Policy.attributes")(function* (
        name: string,
        value: NonNullable<Effect.Success<ReturnType<typeof get>>>,
      ) {
        return {
          name,
          policyType: "Custom" as const,
          defaultVersion: value.policy.defaultVersion,
          document: value.document ?? "",
          description: value.policy.description,
          tags: userTags(yield* tags.read(name)),
        };
      });
      return {
        version: 1,
        stables: ["name", "policyType"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return;
          if (olds.name !== news.name) return { action: "replace" };
          if (output) {
            const value = yield* get(output.name);
            if (
              !value ||
              !jsonConfigMatches(
                value.document,
                JSON.stringify(news.document),
              ) ||
              (news.description !== undefined &&
                value.policy.description !== news.description) ||
              !tagsEqual(
                userTags(yield* tags.read(output.name)),
                news.tags ?? {},
              )
            )
              return { action: "update" };
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.name ?? (yield* physicalName(id, olds.name, 128));
          const value = yield* get(name);
          if (!value) return;
          const result = yield* attrs(name, value);
          return (yield* hasAlchemyTags(id, yield* tags.read(name)))
            ? result
            : Unowned(result);
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = yield* physicalName(id, news.name ?? output?.name, 128);
          const desired = yield* desiredTags(id, news.tags);
          let value = yield* get(name);
          if (value && !output)
            yield* requireRecoveryOwnership(
              id,
              Policy.Type,
              yield* tags.read(name),
            );
          if (!value) {
            yield* retryingSdkCall("RAM", "CreatePolicy", () =>
              clients.ram.createPolicy(
                new RAM.CreatePolicyRequest({
                  policyName: name,
                  policyDocument: JSON.stringify(news.document),
                  description: news.description,
                  tag: tagList(desired),
                }),
              ),
            );
            value = yield* waitForPresent({
              service: "RAM",
              operation: "CreatePolicy",
              read: get(name),
              ready: () => true,
              wait: options.wait,
            });
          }
          if (!jsonConfigMatches(value.document, JSON.stringify(news.document)))
            yield* retryingSdkCall("RAM", "CreatePolicyVersion", () =>
              clients.ram.createPolicyVersion(
                new RAM.CreatePolicyVersionRequest({
                  policyName: name,
                  policyDocument: JSON.stringify(news.document),
                  setAsDefault: true,
                  rotateStrategy:
                    "DeleteOldestNonDefaultVersionWhenLimitExceeded",
                }),
              ),
            );
          if (
            news.description !== undefined &&
            value.policy.description !== news.description
          )
            yield* retryingSdkCall("RAM", "UpdatePolicyDescription", () =>
              clients.ram.updatePolicyDescription(
                new RAM.UpdatePolicyDescriptionRequest({
                  policyName: name,
                  newDescription: news.description,
                }),
              ),
            );
          yield* tags.sync(name, desired);
          return yield* attrs(
            name,
            yield* waitForPresent({
              service: "RAM",
              operation: "ReconcilePolicy",
              read: get(name),
              ready: (v) =>
                jsonConfigMatches(v.document, JSON.stringify(news.document)) &&
                (news.description === undefined ||
                  v.policy.description === news.description),
              wait: options.wait,
            }),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          if (!(yield* get(output.name))) return;
          // Delete owned non-default versions; do not detach policies from external principals.
          const versions = yield* retryingSdkCall(
            "RAM",
            "ListPolicyVersions",
            () =>
              clients.ram.listPolicyVersions(
                new RAM.ListPolicyVersionsRequest({ policyName: output.name }),
              ),
          );
          for (const version of versions.body?.policyVersions?.policyVersion ??
            [])
            if (!version.isDefaultVersion && version.versionId)
              yield* retryingSdkCall("RAM", "DeletePolicyVersion", () =>
                clients.ram.deletePolicyVersion(
                  new RAM.DeletePolicyVersionRequest({
                    policyName: output.name,
                    versionId: version.versionId,
                  }),
                ),
              );
          yield* retryingSdkCall("RAM", "DeletePolicy", () =>
            clients.ram.deletePolicy(
              new RAM.DeletePolicyRequest({
                policyName: output.name,
                cascadingDelete: false,
              }),
            ),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitForAbsent({
            service: "RAM",
            operation: "DeletePolicy",
            read: get(output.name),
            wait: options.wait,
          });
        }),
      };
    }),
  );
