import * as Tair from "@alicloud/r-kvstore20150101";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { AlibabaClients } from "../clients.ts";
import {
  AlibabaInvariantError,
  isIncorrectInstanceState,
  isNotFound,
  isTransient,
  retryingSdkCall,
  sdkCall,
} from "../error.ts";
import {
  waitFor,
  waitForPresent,
  waitUntilAccepted,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Providers } from "../providers.ts";

export interface SecurityIpGroupProps {
  readonly instanceId: string;
  readonly name?: string;
  readonly securityIps: readonly string[];
  readonly attribute?: string;
}

export interface SecurityIpGroupAttributes {
  readonly instanceId: string;
  readonly name: string;
  readonly securityIps: readonly string[];
  readonly attribute?: string;
}

export type SecurityIpGroup = Resource<
  "Alibaba.Tair.SecurityIpGroup",
  SecurityIpGroupProps,
  SecurityIpGroupAttributes,
  never,
  Providers
>;

export const SecurityIpGroup = Resource<SecurityIpGroup>(
  "Alibaba.Tair.SecurityIpGroup",
);

type ObservedGroup =
  Tair.DescribeSecurityIpsResponseBodySecurityIpGroupsSecurityIpGroup;

const normalize = (ips: readonly string[]) =>
  [...new Set(ips.map((ip) => ip.trim()).filter((ip) => ip.length > 0))].sort();

const observedIps = (group: ObservedGroup) =>
  normalize(group.securityIpList?.split(",") ?? []);

const sameIps = (left: readonly string[], right: readonly string[]) =>
  normalize(left).join(",") === normalize(right).join(",");

// Alibaba keeps the built-in default group present and refuses to remove its
// final address. Restore the provider default instead of waiting for an empty
// group that can never exist. The enclosing Tair instance can then be deleted.
const DEFAULT_GROUP_FALLBACK_IPS = ["127.0.0.1"] as const;

const toAttributes = (
  instanceId: string,
  name: string,
  group: ObservedGroup,
): SecurityIpGroupAttributes => ({
  instanceId,
  name: group.securityIpGroupName ?? name,
  securityIps: observedIps(group),
  attribute: group.securityIpGroupAttribute,
});

/** Security IP groups expose no ownership metadata and are silently adoptable. */
export interface SecurityIpGroupProviderOptions {
  readonly wait?: WaitOptions;
}

export const SecurityIpGroupProvider = (
  options: SecurityIpGroupProviderOptions = {},
) =>
  Provider.effect(
    SecurityIpGroup,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      // Child updates can overlap parent resize/password/configuration work.
      // These mutations are idempotent; wait for Tair to release its state lock.
      const requestMutation = <Result>(
        operation: string,
        call: () => Promise<Result>,
      ) =>
        waitUntilAccepted({
          service: "Tair",
          operation,
          request: sdkCall("Tair", operation, call),
          retryIf: (error) =>
            isIncorrectInstanceState(error) || isTransient(error),
          wait: options.wait,
        });

      const get = (instanceId: string, name: string) =>
        retryingSdkCall("Tair", "DescribeSecurityIps", () =>
          clients.tair.describeSecurityIps(
            new Tair.DescribeSecurityIpsRequest({ instanceId }),
          ),
        ).pipe(
          Effect.map((response) =>
            response.body?.securityIpGroups?.securityIpGroup?.find(
              (group) => group.securityIpGroupName === name,
            ),
          ),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
      return {
        version: 1,
        stables: ["instanceId", "name"] as const,
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds.instanceId === undefined || olds.securityIps === undefined) {
            return undefined;
          }
          return olds.instanceId !== news.instanceId ||
            (olds.name ?? "default") !== (news.name ?? "default")
            ? ({ action: "replace" } as const)
            : undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const instanceId = olds.instanceId ?? output?.instanceId;
          if (instanceId === undefined) return undefined;
          const name = olds.name ?? output?.name ?? "default";
          const group = yield* get(instanceId, name);
          return group === undefined
            ? undefined
            : toAttributes(instanceId, name, group);
        }),
        reconcile: Effect.fn(function* ({ news }) {
          const name = news.name ?? "default";
          const desired = normalize(news.securityIps);
          if (desired.length === 0) {
            return yield* new AlibabaInvariantError({
              resourceType: SecurityIpGroup.Type,
              operation: "ModifySecurityIps",
              message:
                "Tair requires at least one address in a security IP group",
            });
          }
          const group = yield* get(news.instanceId, name);
          if (
            group === undefined ||
            !sameIps(observedIps(group), desired) ||
            (news.attribute !== undefined &&
              group.securityIpGroupAttribute !== news.attribute)
          ) {
            yield* requestMutation("ModifySecurityIps", () =>
              clients.tair.modifySecurityIps(
                new Tair.ModifySecurityIpsRequest({
                  instanceId: news.instanceId,
                  modifyMode: "Cover",
                  securityIpGroupName: name,
                  securityIpGroupAttribute: news.attribute,
                  securityIps: desired.join(","),
                }),
              ),
            );
          }
          const fresh = yield* waitForPresent({
            service: "Tair",
            operation: "ModifySecurityIps",
            read: get(news.instanceId, name),
            ready: (value) =>
              sameIps(observedIps(value), desired) &&
              (news.attribute === undefined ||
                value.securityIpGroupAttribute === news.attribute),
            wait: options.wait,
          });
          return toAttributes(news.instanceId, name, fresh);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (output.securityIps.length === 0) return;
          const deletingDefault = output.name === "default";
          const expected = deletingDefault ? DEFAULT_GROUP_FALLBACK_IPS : [];
          yield* requestMutation("DeleteSecurityIps", () =>
            clients.tair.modifySecurityIps(
              new Tair.ModifySecurityIpsRequest({
                instanceId: output.instanceId,
                modifyMode: deletingDefault ? "Cover" : "Delete",
                securityIpGroupName: output.name,
                securityIps: deletingDefault
                  ? expected.join(",")
                  : output.securityIps.join(","),
              }),
            ),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitFor({
            service: "Tair",
            operation: "DeleteSecurityIps",
            read: get(output.instanceId, output.name),
            ready: (value) =>
              value === undefined || sameIps(observedIps(value), expected),
            wait: options.wait,
          });
        }),
      };
    }),
  );
