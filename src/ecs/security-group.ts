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
  isAmbiguousCreate,
  retryingSdkCall,
} from "../error.ts";
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
  waitUntilAccepted,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Providers } from "../providers.ts";
import { missing, syncTags, tagList, tagRecord, unique } from "./internal.ts";

export interface SecurityGroupProps {
  readonly name?: string;
  readonly vpcId: string;
  readonly description?: string;
  readonly tags?: Readonly<Record<string, string>>;
}
export interface SecurityGroupAttributes {
  readonly securityGroupId: string;
  readonly name: string;
  readonly vpcId: string;
  readonly regionId: string;
  readonly description?: string;
  readonly tags: Readonly<Record<string, string>>;
}
export type SecurityGroup = Resource<
  "Alibaba.ECS.SecurityGroup",
  SecurityGroupProps,
  SecurityGroupAttributes,
  never,
  Providers
>;
export const SecurityGroup = Resource<SecurityGroup>(
  "Alibaba.ECS.SecurityGroup",
);
type Observed =
  ECS.DescribeSecurityGroupsResponseBodySecurityGroupsSecurityGroup;
const absent = missing("InvalidSecurityGroupId.NotFound");
export const SecurityGroupProvider = (
  options: { readonly wait?: WaitOptions } = {},
) =>
  Provider.effect(
    SecurityGroup,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const inventory = (
        query: {
          securityGroupId?: string;
          securityGroupName?: string;
          vpcId?: string;
        } = {},
      ) =>
        paginate({
          service: "ECS",
          operation: "DescribeSecurityGroups",
          page: ({ pageNumber, pageSize }) =>
            retryingSdkCall("ECS", "DescribeSecurityGroups", () =>
              clients.ecs.describeSecurityGroups(
                new ECS.DescribeSecurityGroupsRequest({
                  ...query,
                  regionId: clients.regionId,
                  pageNumber,
                  pageSize,
                }),
              ),
            ).pipe(
              Effect.flatMap((response) =>
                requireValue(
                  response.body?.securityGroups?.securityGroup,
                  SecurityGroup.Type,
                  "DescribeSecurityGroups",
                  "ECS security group inventory is missing",
                ).pipe(
                  Effect.map((items) => ({
                    items,
                    totalCount: response.body?.totalCount,
                  })),
                ),
              ),
            ),
        });
      const get = (id: string) =>
        inventory({ securityGroupId: id }).pipe(
          Effect.flatMap((items) =>
            unique(
              items.filter((item) => item.securityGroupId === id),
              SecurityGroup.Type,
            ),
          ),
          Effect.catchIf(absent, () => Effect.succeed(undefined)),
        );
      const find = (name: string, vpcId: string) =>
        inventory({ securityGroupName: name, vpcId }).pipe(
          Effect.flatMap((items) =>
            unique(
              items.filter(
                (item) =>
                  item.securityGroupName === name && item.vpcId === vpcId,
              ),
              SecurityGroup.Type,
            ),
          ),
        );
      const observe = (id: string | undefined, name: string, vpcId: string) =>
        id === undefined ? find(name, vpcId) : get(id);
      const attrs = Effect.fn("ECS.SecurityGroup.attributes")(function* (
        value: Observed,
      ) {
        return {
          securityGroupId: yield* requireValue(
            value.securityGroupId,
            SecurityGroup.Type,
            "DescribeSecurityGroups",
            "Missing security group id",
          ),
          name: yield* requireValue(
            value.securityGroupName,
            SecurityGroup.Type,
            "DescribeSecurityGroups",
            "Missing security group name",
          ),
          vpcId: yield* requireValue(
            value.vpcId,
            SecurityGroup.Type,
            "DescribeSecurityGroups",
            "Missing VPC id",
          ),
          regionId: clients.regionId,
          description: value.description,
          tags: userTags(tagRecord(value.tags?.tag)),
        } satisfies SecurityGroupAttributes;
      });
      return {
        version: 1,
        stables: ["securityGroupId", "vpcId", "regionId"] as const,
        nuke: { dependsOn: ["Alibaba.VPC.*"] },
        list: () =>
          inventory().pipe(
            Effect.flatMap((items) => Effect.forEach(items, attrs)),
          ),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (olds.name !== news.name || olds.vpcId !== news.vpcId)
            return { action: "replace" } as const;
          if (output !== undefined) {
            yield* requireRegion(
              SecurityGroup.Type,
              clients.regionId,
              output.regionId,
            );
            const current = yield* get(output.securityGroupId);
            if (current === undefined) return { action: "replace" } as const;
            if (
              !tagsEqual(
                userTags(tagRecord(current.tags?.tag)),
                news.tags ?? {},
              ) ||
              (news.description !== undefined &&
                current.description !== news.description)
            )
              return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          yield* requireRegion(
            SecurityGroup.Type,
            clients.regionId,
            output?.regionId,
          );
          const name = yield* physicalName(id, olds.name ?? output?.name, 128);
          const value = yield* observe(
            output?.securityGroupId,
            name,
            olds.vpcId,
          );
          if (value === undefined) return undefined;
          const attributes = yield* attrs(value);
          return (yield* hasAlchemyTags(id, tagRecord(value.tags?.tag)))
            ? attributes
            : Unowned(attributes);
        }),
        reconcile: Effect.fn(function* ({
          id,
          instanceId: generation,
          news,
          output,
        }) {
          yield* requireRegion(
            SecurityGroup.Type,
            clients.regionId,
            output?.regionId,
          );
          const name = yield* physicalName(id, news.name ?? output?.name, 128);
          const tags = yield* desiredTags(id, news.tags);
          let value = yield* observe(output?.securityGroupId, name, news.vpcId);
          if (value === undefined) {
            const response = yield* retryingSdkCall(
              "ECS",
              "CreateSecurityGroup",
              () =>
                clients.ecs.createSecurityGroup(
                  new ECS.CreateSecurityGroupRequest({
                    regionId: clients.regionId,
                    vpcId: news.vpcId,
                    securityGroupName: name,
                    securityGroupType: "normal",
                    description: news.description,
                    tag: tagList(tags),
                    clientToken: `create-${generation}`,
                  }),
                ),
            ).pipe(
              Effect.catchIf(isAmbiguousCreate, (error) =>
                waitForPresent({
                  service: "ECS",
                  operation: "RecoverSecurityGroup",
                  read: find(name, news.vpcId),
                  ready: (value) => value.securityGroupId !== undefined,
                  wait: options.wait,
                }).pipe(
                  Effect.map((value) => ({
                    body: { securityGroupId: value.securityGroupId },
                  })),
                  Effect.catch(() => Effect.fail(error)),
                ),
              ),
            );
            value = yield* waitForPresent({
              service: "ECS",
              operation: "CreateSecurityGroup",
              read: observe(response.body?.securityGroupId, name, news.vpcId),
              ready: (value) => value.securityGroupId !== undefined,
              wait: options.wait,
            });
          }
          if (
            value.vpcId !== news.vpcId ||
            value.securityGroupType !== "normal"
          )
            return yield* new AlibabaInvariantError({
              resourceType: SecurityGroup.Type,
              operation: "Reconcile",
              message:
                "Observed security group VPC or type differs from the requested identity",
            });
          const securityGroupId = yield* requireValue(
            value.securityGroupId,
            SecurityGroup.Type,
            "Reconcile",
            "Missing security group id",
          );
          if (
            news.description !== undefined &&
            value.description !== news.description
          )
            yield* retryingSdkCall("ECS", "ModifySecurityGroupAttribute", () =>
              clients.ecs.modifySecurityGroupAttribute(
                new ECS.ModifySecurityGroupAttributeRequest({
                  regionId: clients.regionId,
                  securityGroupId,
                  description: news.description,
                }),
              ),
            );
          yield* syncTags(
            clients,
            "securitygroup",
            securityGroupId,
            tagRecord(value.tags?.tag),
            tags,
          );
          return yield* attrs(
            yield* waitForPresent({
              service: "ECS",
              operation: "ReconcileSecurityGroup",
              read: get(securityGroupId),
              ready: (value) =>
                (news.description === undefined ||
                  value.description === news.description) &&
                tagsEqual(tagRecord(value.tags?.tag), tags),
              wait: options.wait,
            }),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* requireRegion(
            SecurityGroup.Type,
            clients.regionId,
            output.regionId,
          );
          if ((yield* get(output.securityGroupId)) === undefined) return;
          yield* waitUntilAccepted({
            service: "ECS",
            operation: "DeleteSecurityGroup",
            request: retryingSdkCall("ECS", "DeleteSecurityGroup", () =>
              clients.ecs.deleteSecurityGroup(
                new ECS.DeleteSecurityGroupRequest({
                  regionId: clients.regionId,
                  securityGroupId: output.securityGroupId,
                }),
              ),
            ).pipe(Effect.catchIf(absent, () => Effect.void)),
            retryIf: (error) =>
              error.code === "DependencyViolation" ||
              error.code === "DependencyViolation.SecurityGroup",
            wait: options.wait,
          });
          yield* waitForAbsent({
            service: "ECS",
            operation: "DeleteSecurityGroup",
            read: get(output.securityGroupId),
            wait: options.wait,
          });
        }),
      };
    }),
  );
