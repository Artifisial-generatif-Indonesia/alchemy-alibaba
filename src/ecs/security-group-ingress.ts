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

/** An adoptable IPv4 inbound allow rule. Other group rules remain unmanaged. */
export interface SecurityGroupIngressProps {
  readonly securityGroupId: string;
  readonly ipProtocol: "tcp" | "udp" | "icmp" | "all";
  /** ECS format, for example 22/22, 443/443, or -1/-1. */
  readonly portRange: string;
  readonly sourceCidrIp: string;
  readonly priority?: number;
}
export interface SecurityGroupIngressAttributes
  extends SecurityGroupIngressProps {
  readonly regionId: string;
  readonly securityGroupRuleId: string;
}
export type SecurityGroupIngress = Resource<
  "Alibaba.ECS.SecurityGroupIngress",
  SecurityGroupIngressProps,
  SecurityGroupIngressAttributes,
  never,
  Providers
>;
export const SecurityGroupIngress = Resource<SecurityGroupIngress>(
  "Alibaba.ECS.SecurityGroupIngress",
);
const normalized = (props: SecurityGroupIngressProps) => ({
  securityGroupId: props.securityGroupId,
  ipProtocol: props.ipProtocol,
  portRange: props.portRange,
  sourceCidrIp: props.sourceCidrIp,
  priority: props.priority ?? 1,
});
const matchesRule = (
  value: ECS.DescribeSecurityGroupAttributeResponseBodyPermissionsPermission,
  props: SecurityGroupIngressProps,
) =>
  value.direction === "ingress" &&
  value.policy?.toLowerCase() === "accept" &&
  value.nicType === "intranet" &&
  value.ipProtocol?.toLowerCase() === props.ipProtocol &&
  value.portRange === props.portRange &&
  value.sourceCidrIp === props.sourceCidrIp &&
  Number(value.priority) === (props.priority ?? 1);
const drift = () =>
  new AlibabaInvariantError({
    resourceType: SecurityGroupIngress.Type,
    operation: "Observe",
    message:
      "Managed ingress rule was changed externally; restore or remove that rule before reapplying to avoid leaving unintended access",
  });
export const SecurityGroupIngressProvider = (
  options: { readonly wait?: WaitOptions } = {},
) =>
  Provider.effect(
    SecurityGroupIngress,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const get = Effect.fn("ECS.SecurityGroupIngress.read")(function* (
        props: SecurityGroupIngressProps,
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
                  direction: "ingress",
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
            SecurityGroupIngress.Type,
            "DescribeSecurityGroupAttribute",
            "ECS permission inventory is missing",
          );
          for (const value of permissions) {
            if (
              ruleId !== undefined
                ? value.securityGroupRuleId === ruleId
                : value.direction === "ingress" &&
                  value.policy?.toLowerCase() === "accept" &&
                  value.nicType === "intranet" &&
                  value.ipProtocol?.toLowerCase() === props.ipProtocol &&
                  value.portRange === props.portRange &&
                  value.sourceCidrIp === props.sourceCidrIp &&
                  Number(value.priority) === (props.priority ?? 1)
            )
              matches.push(value);
          }
          nextToken = response.body?.nextToken;
          if (!nextToken)
            return yield* unique(matches, SecurityGroupIngress.Type);
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
      const attrs = Effect.fn("ECS.SecurityGroupIngress.attributes")(function* (
        props: SecurityGroupIngressProps,
        rule: ECS.DescribeSecurityGroupAttributeResponseBodyPermissionsPermission,
      ) {
        return {
          ...normalized(props),
          regionId: clients.regionId,
          securityGroupRuleId: yield* requireValue(
            rule.securityGroupRuleId,
            SecurityGroupIngress.Type,
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
              SecurityGroupIngress.Type,
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
            SecurityGroupIngress.Type,
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
          yield* requireRegion(
            SecurityGroupIngress.Type,
            clients.regionId,
            output?.regionId,
          );
          if (output !== undefined) {
            const saved = yield* get(news, output.securityGroupRuleId);
            if (saved !== undefined && !matchesRule(saved, news))
              return yield* drift();
          }
          if ((yield* get(news)) === undefined)
            yield* retryingSdkCall("ECS", "AuthorizeSecurityGroup", () =>
              clients.ecs.authorizeSecurityGroup(
                new ECS.AuthorizeSecurityGroupRequest({
                  regionId: clients.regionId,
                  securityGroupId: news.securityGroupId,
                  ipProtocol: news.ipProtocol,
                  portRange: news.portRange,
                  sourceCidrIp: news.sourceCidrIp,
                  priority: String(news.priority ?? 1),
                  policy: "accept",
                  nicType: "intranet",
                }),
              ),
            );
          return yield* attrs(
            news,
            yield* waitForPresent({
              service: "ECS",
              operation: "AuthorizeSecurityGroup",
              read: get(news),
              ready: (value) => value.securityGroupRuleId !== undefined,
              wait: options.wait,
            }),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* requireRegion(
            SecurityGroupIngress.Type,
            clients.regionId,
            output.regionId,
          );
          if ((yield* get(output, output.securityGroupRuleId)) === undefined)
            return;
          yield* retryingSdkCall("ECS", "RevokeSecurityGroup", () =>
            clients.ecs.revokeSecurityGroup(
              new ECS.RevokeSecurityGroupRequest({
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
            operation: "RevokeSecurityGroup",
            read: get(output, output.securityGroupRuleId),
            wait: options.wait,
          });
        }),
      };
    }),
  );
