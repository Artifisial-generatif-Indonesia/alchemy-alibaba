import * as ECS from "@alicloud/ecs20140526";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { isDeepStrictEqual } from "node:util";
import { AlibabaClients } from "../clients.ts";
import {
  AlibabaInvariantError,
  AlibabaPaginationLimitError,
  retryingSdkCall,
} from "../error.ts";
import {
  requireRegion,
  requireValue,
  waitForAbsent,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Providers } from "../providers.ts";
import { missing, unique } from "./internal.ts";

/** One outbound rule. Exactly one destination is required; unrelated rules remain unmanaged. */
export interface SecurityGroupEgressProps {
  readonly securityGroupId: string;
  readonly ipProtocol: "tcp" | "udp" | "icmp" | "all";
  /** ECS format, for example 22/22, 443/443, or -1/-1. */
  readonly portRange: string;
  readonly destCidrIp?: string;
  readonly ipv6DestCidrIp?: string;
  readonly destGroupId?: string;
  readonly policy?: "accept" | "drop";
  readonly priority?: number;
}
export interface SecurityGroupEgressAttributes
  extends SecurityGroupEgressProps {
  readonly regionId: string;
  readonly securityGroupRuleId: string;
}
export type SecurityGroupEgress = Resource<
  "Alibaba.ECS.SecurityGroupEgress",
  SecurityGroupEgressProps,
  SecurityGroupEgressAttributes,
  never,
  Providers
>;
export const SecurityGroupEgress = Resource<SecurityGroupEgress>(
  "Alibaba.ECS.SecurityGroupEgress",
);
const normalized = (props: SecurityGroupEgressProps) => ({
  securityGroupId: props.securityGroupId,
  ipProtocol: props.ipProtocol,
  portRange: props.portRange,
  destCidrIp: props.destCidrIp,
  ipv6DestCidrIp: props.ipv6DestCidrIp,
  destGroupId: props.destGroupId,
  policy: props.policy ?? "accept",
  priority: props.priority ?? 1,
});
const matchesRule = (
  value: ECS.DescribeSecurityGroupAttributeResponseBodyPermissionsPermission,
  props: SecurityGroupEgressProps,
) =>
  value.direction === "egress" &&
  value.policy?.toLowerCase() === (props.policy ?? "accept") &&
  value.nicType === "intranet" &&
  value.ipProtocol?.toLowerCase() === props.ipProtocol &&
  value.portRange === props.portRange &&
  (value.destCidrIp || undefined) === props.destCidrIp &&
  (value.ipv6DestCidrIp || undefined) === props.ipv6DestCidrIp &&
  (value.destGroupId || undefined) === props.destGroupId &&
  Number(value.priority) === (props.priority ?? 1);
const drift = () =>
  new AlibabaInvariantError({
    resourceType: SecurityGroupEgress.Type,
    operation: "Observe",
    message:
      "Managed egress rule was changed externally; restore or remove that rule before reapplying to avoid leaving unintended access",
  });
export const SecurityGroupEgressProvider = (
  options: { readonly wait?: WaitOptions } = {},
) =>
  Provider.effect(
    SecurityGroupEgress,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const get = Effect.fn("ECS.SecurityGroupEgress.read")(function* (
        props: SecurityGroupEgressProps,
        ruleId?: string,
      ) {
        let nextToken: string | undefined;
        const matches: ECS.DescribeSecurityGroupAttributeResponseBodyPermissionsPermission[] =
          [];
        for (let page = 0; page < 200; page++) {
          const response = yield* retryingSdkCall(
            "ECS",
            "DescribeSecurityGroupAttribute",
            () =>
              clients.ecs.describeSecurityGroupAttribute(
                new ECS.DescribeSecurityGroupAttributeRequest({
                  regionId: clients.regionId,
                  securityGroupId: props.securityGroupId,
                  direction: "egress",
                  maxResults: 100,
                  nextToken,
                }),
              ),
          ).pipe(
            Effect.catchIf(missing("InvalidSecurityGroupId.NotFound"), () =>
              Effect.succeed(undefined),
            ),
          );
          if (response === undefined) return undefined;
          const permissions = yield* requireValue(
            response.body?.permissions?.permission,
            SecurityGroupEgress.Type,
            "DescribeSecurityGroupAttribute",
            "ECS permission inventory is missing",
          );
          for (const value of permissions) {
            if (
              ruleId !== undefined
                ? value.securityGroupRuleId === ruleId
                : value.direction === "egress" &&
                  value.policy?.toLowerCase() === (props.policy ?? "accept") &&
                  value.nicType === "intranet" &&
                  value.ipProtocol?.toLowerCase() === props.ipProtocol &&
                  value.portRange === props.portRange &&
                  (value.destCidrIp || undefined) === props.destCidrIp &&
                  (value.ipv6DestCidrIp || undefined) ===
                    props.ipv6DestCidrIp &&
                  (value.destGroupId || undefined) === props.destGroupId &&
                  Number(value.priority) === (props.priority ?? 1)
            )
              matches.push(value);
          }
          nextToken = response.body?.nextToken;
          if (!nextToken)
            return yield* unique(matches, SecurityGroupEgress.Type);
        }
        return yield* new AlibabaPaginationLimitError({
          service: "ECS",
          operation: "DescribeSecurityGroupAttribute",
          pageSize: 100,
          maxPages: 200,
          observedItems: matches.length,
          message: "ECS permission inventory did not terminate",
        });
      });
      const attrs = Effect.fn("ECS.SecurityGroupEgress.attributes")(function* (
        props: SecurityGroupEgressProps,
        rule: ECS.DescribeSecurityGroupAttributeResponseBodyPermissionsPermission,
      ) {
        return {
          ...normalized(props),
          regionId: clients.regionId,
          securityGroupRuleId: yield* requireValue(
            rule.securityGroupRuleId,
            SecurityGroupEgress.Type,
            "DescribeSecurityGroupAttribute",
            "Missing security group rule id",
          ),
        };
      });
      return {
        version: 1,
        stables: ["securityGroupId", "regionId"] as const,
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (!isDeepStrictEqual(normalized(olds), normalized(news)))
            return { action: "replace" } as const;
          if (output !== undefined) {
            yield* requireRegion(
              SecurityGroupEgress.Type,
              clients.regionId,
              output.regionId,
            );
            const value = yield* get(olds, output.securityGroupRuleId);
            if (value === undefined) return { action: "update" } as const;
            if (!matchesRule(value, olds)) return yield* drift();
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          yield* requireRegion(
            SecurityGroupEgress.Type,
            clients.regionId,
            output?.regionId,
          );
          const value = yield* get(olds, output?.securityGroupRuleId);
          if (
            value !== undefined &&
            output !== undefined &&
            !matchesRule(value, olds)
          )
            return yield* drift();
          return value === undefined ? undefined : yield* attrs(olds, value);
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          if (
            [news.destCidrIp, news.ipv6DestCidrIp, news.destGroupId].filter(
              (v) => v !== undefined,
            ).length !== 1
          )
            return yield* new AlibabaInvariantError({
              resourceType: SecurityGroupEgress.Type,
              operation: "Validate",
              message:
                "Exactly one security group rule destination must be specified",
            });
          yield* requireRegion(
            SecurityGroupEgress.Type,
            clients.regionId,
            output?.regionId,
          );
          if (output !== undefined) {
            const saved = yield* get(news, output.securityGroupRuleId);
            if (saved !== undefined && !matchesRule(saved, news))
              return yield* drift();
          }
          if ((yield* get(news)) === undefined)
            yield* retryingSdkCall("ECS", "AuthorizeSecurityGroupEgress", () =>
              clients.ecs.authorizeSecurityGroupEgress(
                new ECS.AuthorizeSecurityGroupEgressRequest({
                  regionId: clients.regionId,
                  securityGroupId: news.securityGroupId,
                  ipProtocol: news.ipProtocol,
                  portRange: news.portRange,
                  destCidrIp: news.destCidrIp,
                  ipv6DestCidrIp: news.ipv6DestCidrIp,
                  destGroupId: news.destGroupId,
                  priority: String(news.priority ?? 1),
                  policy: news.policy ?? "accept",
                  nicType: "intranet",
                }),
              ),
            );
          return yield* attrs(
            news,
            yield* waitForPresent({
              service: "ECS",
              operation: "AuthorizeSecurityGroupEgress",
              read: get(news),
              ready: (value) => value.securityGroupRuleId !== undefined,
              wait: options.wait,
            }),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* requireRegion(
            SecurityGroupEgress.Type,
            clients.regionId,
            output.regionId,
          );
          if ((yield* get(output, output.securityGroupRuleId)) === undefined)
            return;
          yield* retryingSdkCall("ECS", "RevokeSecurityGroupEgress", () =>
            clients.ecs.revokeSecurityGroupEgress(
              new ECS.RevokeSecurityGroupEgressRequest({
                regionId: clients.regionId,
                securityGroupId: output.securityGroupId,
                securityGroupRuleId: [output.securityGroupRuleId],
              }),
            ),
          ).pipe(
            Effect.catchIf(
              (error) =>
                missing("InvalidSecurityGroupId.NotFound")(error) ||
                missing("InvalidSecurityGroupRuleId.NotFound")(error),
              () => Effect.void,
            ),
          );
          yield* waitForAbsent({
            service: "ECS",
            operation: "RevokeSecurityGroupEgress",
            read: get(output, output.securityGroupRuleId),
            wait: options.wait,
          });
        }),
      };
    }),
  );
