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
  requireValue,
  tagsEqual,
  userTags,
  waitForAbsent,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import { jsonConfigMatches } from "../internal/observation.ts";
import type { Providers } from "../providers.ts";
import { pages, ramTags, tagList, type PolicyDocument } from "./internal.ts";

export interface RoleProps {
  /** Unique account-wide name; changing it replaces the role. */
  readonly name?: string;
  readonly assumeRolePolicy: PolicyDocument;
  readonly description?: string;
  readonly maxSessionDuration?: number;
  readonly tags?: Readonly<Record<string, string>>;
}
export interface RoleAttributes {
  readonly name: string;
  readonly roleId: string;
  readonly arn: string;
  readonly assumeRolePolicy: string;
  readonly description?: string;
  readonly maxSessionDuration?: number;
  readonly tags: Readonly<Record<string, string>>;
}
export type Role = Resource<
  "Alibaba.RAM.Role",
  RoleProps,
  RoleAttributes,
  never,
  Providers
>;
export const Role = Resource<Role>("Alibaba.RAM.Role");
export const RoleProvider = (options: { readonly wait?: WaitOptions } = {}) =>
  Provider.effect(
    Role,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const tags = ramTags(clients, "role");
      const get = (name: string) =>
        retryingSdkCall("RAM", "GetRole", () =>
          clients.ram.getRole(new RAM.GetRoleRequest({ roleName: name })),
        ).pipe(
          Effect.map((r) => r.body?.role),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
      const matches = (value: RAM.GetRoleResponseBodyRole, news: RoleProps) =>
        jsonConfigMatches(
          value.assumeRolePolicyDocument,
          JSON.stringify(news.assumeRolePolicy),
        ) &&
        (news.description === undefined ||
          value.description === news.description) &&
        value.maxSessionDuration === (news.maxSessionDuration ?? 3600);
      const attrs = Effect.fn("RAM.Role.attributes")(function* (
        value: RAM.GetRoleResponseBodyRole,
      ) {
        const name = yield* requireValue(
          value.roleName,
          Role.Type,
          "Read",
          "Missing RAM role name",
        );
        return {
          name,
          roleId: yield* requireValue(
            value.roleId,
            Role.Type,
            "Read",
            "Missing RAM role id",
          ),
          arn: yield* requireValue(
            value.arn,
            Role.Type,
            "Read",
            "Missing RAM role ARN",
          ),
          assumeRolePolicy: value.assumeRolePolicyDocument ?? "",
          description: value.description,
          maxSessionDuration: value.maxSessionDuration,
          tags: userTags(yield* tags.read(name)),
        };
      });
      return {
        version: 1,
        stables: ["name", "roleId", "arn"],
        list: () =>
          pages("ListRoles", (marker) =>
            retryingSdkCall("RAM", "ListRoles", () =>
              clients.ram.listRoles(
                new RAM.ListRolesRequest({ marker, maxItems: 100 }),
              ),
            ).pipe(
              Effect.map((r) => ({
                items: r.body?.roles?.role ?? [],
                next: r.body?.isTruncated ? r.body.marker : undefined,
              })),
            ),
          ).pipe(
            Effect.flatMap(
              Effect.forEach((role) =>
                role.roleName
                  ? get(role.roleName).pipe(
                      Effect.flatMap((v) =>
                        v
                          ? attrs(v).pipe(Effect.map((a) => [a]))
                          : Effect.succeed([]),
                      ),
                    )
                  : Effect.succeed([]),
              ),
            ),
            Effect.map((groups) => groups.flat()),
          ),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return;
          if (olds.name !== news.name) return { action: "replace" };
          if (output) {
            const value = yield* get(output.name);
            if (
              !value ||
              !matches(value, news) ||
              !tagsEqual(
                userTags(yield* tags.read(output.name)),
                news.tags ?? {},
              )
            )
              return { action: "update" };
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const value = yield* get(
            output?.name ?? (yield* physicalName(id, olds.name, 64)),
          );
          if (!value) return;
          const result = yield* attrs(value);
          return (yield* hasAlchemyTags(id, yield* tags.read(result.name)))
            ? result
            : Unowned(result);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* physicalName(id, news.name ?? output?.name, 64);
          const desired = yield* desiredTags(id, news.tags);
          let value = yield* get(name);
          if (value && !output)
            yield* requireRecoveryOwnership(
              id,
              Role.Type,
              yield* tags.read(name),
            );
          if (!value) {
            yield* session.note(`Creating RAM role ${name}`);
            yield* retryingSdkCall("RAM", "CreateRole", () =>
              clients.ram.createRole(
                new RAM.CreateRoleRequest({
                  roleName: name,
                  assumeRolePolicyDocument: JSON.stringify(
                    news.assumeRolePolicy,
                  ),
                  description: news.description,
                  maxSessionDuration: news.maxSessionDuration ?? 3600,
                  tag: tagList(desired),
                }),
              ),
            );
            value = yield* waitForPresent({
              service: "RAM",
              operation: "CreateRole",
              read: get(name),
              ready: () => true,
              wait: options.wait,
            });
          }
          if (!matches(value, news))
            yield* retryingSdkCall("RAM", "UpdateRole", () =>
              clients.ram.updateRole(
                new RAM.UpdateRoleRequest({
                  roleName: name,
                  newAssumeRolePolicyDocument: JSON.stringify(
                    news.assumeRolePolicy,
                  ),
                  newDescription: news.description,
                  newMaxSessionDuration: news.maxSessionDuration ?? 3600,
                }),
              ),
            );
          yield* tags.sync(name, desired);
          return yield* attrs(
            yield* waitForPresent({
              service: "RAM",
              operation: "ReconcileRole",
              read: get(name),
              ready: (v) => matches(v, news),
              wait: options.wait,
            }),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          if (!(yield* get(output.name))) return;
          yield* retryingSdkCall("RAM", "DeleteRole", () =>
            clients.ram.deleteRole(
              new RAM.DeleteRoleRequest({ roleName: output.name }),
            ),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitForAbsent({
            service: "RAM",
            operation: "DeleteRole",
            read: get(output.name),
            wait: options.wait,
          });
        }),
      };
    }),
  );
