import * as RDS from "@alicloud/rds20140815";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { AlibabaClients } from "../clients.ts";
import {
  AlibabaInvariantError,
  isNotFound,
  retryingSdkCall,
  sdkCall,
} from "../error.ts";
import {
  waitFor,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Without } from "../internal/model-input.ts";
import type { Providers } from "../providers.ts";

export interface SecurityIpGroupProps {
  readonly instanceId: string;
  readonly name?: string;
  readonly securityIps: readonly string[];
  readonly settings?: Without<
    RDS.ModifySecurityIpsRequest,
    "DBInstanceId" | "DBInstanceIPArrayName" | "securityIps" | "modifyMode"
  >;
  /** RDS requires at least one address; destroy resets to this list. */
  readonly resetTo?: readonly string[];
}

export interface SecurityIpGroupAttributes {
  readonly instanceId: string;
  readonly name: string;
  readonly securityIps: readonly string[];
  readonly attribute?: string;
  readonly securityIpType?: string;
}

export type SecurityIpGroup = Resource<
  "Alibaba.RDS.SecurityIpGroup",
  SecurityIpGroupProps,
  SecurityIpGroupAttributes,
  never,
  Providers
>;

export const SecurityIpGroup = Resource<SecurityIpGroup>(
  "Alibaba.RDS.SecurityIpGroup",
);

type ObservedGroup =
  RDS.DescribeDBInstanceIPArrayListResponseBodyItemsDBInstanceIPArray;

const normalize = (ips: readonly string[]) =>
  [...new Set(ips.map((ip) => ip.trim()).filter((ip) => ip.length > 0))].sort();

const observedIps = (group: ObservedGroup) =>
  normalize(group.securityIPList?.split(",") ?? []);

const sameIps = (left: readonly string[], right: readonly string[]) =>
  normalize(left).join(",") === normalize(right).join(",");

const toAttributes = (
  instanceId: string,
  name: string,
  group: ObservedGroup,
): SecurityIpGroupAttributes => ({
  instanceId,
  name: group.DBInstanceIPArrayName ?? name,
  securityIps: observedIps(group),
  attribute: group.DBInstanceIPArrayAttribute,
  securityIpType: group.securityIPType,
});

/** RDS IP arrays expose no ownership metadata and are silently adoptable. */
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
      const get = (instanceId: string, name: string) =>
        retryingSdkCall("RDS", "DescribeDBInstanceIPArrayList", () =>
          clients.rds.describeDBInstanceIPArrayList(
            new RDS.DescribeDBInstanceIPArrayListRequest({
              DBInstanceId: instanceId,
            }),
          ),
        ).pipe(
          Effect.map((response) =>
            response.body?.items?.DBInstanceIPArray?.find(
              (group) =>
                group.DBInstanceIPArrayName?.toLowerCase() ===
                name.toLowerCase(),
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
            (olds.name ?? "Default").toLowerCase() !==
              (news.name ?? "Default").toLowerCase()
            ? ({ action: "replace" } as const)
            : undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const instanceId = olds.instanceId ?? output?.instanceId;
          if (instanceId === undefined) return undefined;
          const name = olds.name ?? output?.name ?? "Default";
          const group = yield* get(instanceId, name);
          return group === undefined
            ? undefined
            : toAttributes(instanceId, name, group);
        }),
        reconcile: Effect.fn(function* ({ news }) {
          const name = news.name ?? "Default";
          const desired = normalize(news.securityIps);
          if (desired.length === 0) {
            return yield* new AlibabaInvariantError({
              resourceType: SecurityIpGroup.Type,
              operation: "ModifySecurityIps",
              message:
                "RDS requires at least one address in every security IP group",
            });
          }
          const group = yield* get(news.instanceId, name);
          const observedName = group?.DBInstanceIPArrayName ?? name;
          if (
            group === undefined ||
            !sameIps(observedIps(group), desired) ||
            (news.settings?.DBInstanceIPArrayAttribute !== undefined &&
              group.DBInstanceIPArrayAttribute !==
                news.settings.DBInstanceIPArrayAttribute) ||
            (news.settings?.securityIPType !== undefined &&
              group.securityIPType !== news.settings.securityIPType)
          ) {
            yield* sdkCall("RDS", "ModifySecurityIps", () =>
              clients.rds.modifySecurityIps(
                new RDS.ModifySecurityIpsRequest({
                  ...news.settings,
                  DBInstanceId: news.instanceId,
                  DBInstanceIPArrayName: observedName,
                  modifyMode: "Cover",
                  securityIps: desired.join(","),
                }),
              ),
            );
          }
          const fresh = yield* waitForPresent({
            service: "RDS",
            operation: "ModifySecurityIps",
            read: get(news.instanceId, name),
            ready: (value) =>
              sameIps(observedIps(value), desired) &&
              (news.settings?.DBInstanceIPArrayAttribute === undefined ||
                value.DBInstanceIPArrayAttribute ===
                  news.settings.DBInstanceIPArrayAttribute) &&
              (news.settings?.securityIPType === undefined ||
                value.securityIPType === news.settings.securityIPType),
            wait: options.wait,
          });
          return toAttributes(news.instanceId, name, fresh);
        }),
        delete: Effect.fn(function* ({ output, olds }) {
          const resetTo = normalize(olds.resetTo ?? ["127.0.0.1"]);
          if (resetTo.length === 0) {
            return yield* new AlibabaInvariantError({
              resourceType: SecurityIpGroup.Type,
              operation: "ResetSecurityIps",
              message: "RDS requires resetTo to contain at least one address",
            });
          }
          yield* retryingSdkCall("RDS", "ResetSecurityIps", () =>
            clients.rds.modifySecurityIps(
              new RDS.ModifySecurityIpsRequest({
                ...olds.settings,
                DBInstanceId: output.instanceId,
                DBInstanceIPArrayName: output.name,
                modifyMode: "Cover",
                securityIps: resetTo.join(","),
              }),
            ),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitFor({
            service: "RDS",
            operation: "ResetSecurityIps",
            read: get(output.instanceId, output.name),
            ready: (value) =>
              value === undefined || sameIps(observedIps(value), resetTo),
            wait: options.wait,
          });
        }),
      };
    }),
  );
