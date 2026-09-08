import * as ACR from "@alicloud/cr20181201";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { AlibabaClients } from "../clients.ts";
import { acrSdkCall, isNotFound, retryingAcrSdkCall } from "../error.ts";
import {
  waitForAbsent,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Providers } from "../providers.ts";

export interface VpcEndpointLinkProps {
  readonly instanceId: string;
  readonly vpcId: string;
  readonly vswitchId: string;
  readonly moduleName?: "Registry" | "Chart";
  readonly enablePrivateZoneRecord?: boolean;
}

export interface VpcEndpointLinkAttributes extends VpcEndpointLinkProps {
  readonly status: string;
  readonly ip?: string;
  readonly issue?: string;
  readonly defaultAccess: boolean;
  readonly domains: readonly string[];
}

export type VpcEndpointLink = Resource<
  "Alibaba.ACR.VpcEndpointLink",
  VpcEndpointLinkProps,
  VpcEndpointLinkAttributes,
  never,
  Providers
>;

export const VpcEndpointLink = Resource<VpcEndpointLink>(
  "Alibaba.ACR.VpcEndpointLink",
);

export interface VpcEndpointLinkProviderOptions {
  readonly wait?: WaitOptions;
}

const moduleName = (value: "Registry" | "Chart" | undefined) =>
  value ?? "Registry";

/** ACR VPC links have compound identity and no ownership metadata. */
export const VpcEndpointLinkProvider = (
  options: VpcEndpointLinkProviderOptions = {},
) =>
  Provider.effect(
    VpcEndpointLink,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const observe = (props: VpcEndpointLinkProps) =>
        retryingAcrSdkCall("GetInstanceVpcEndpoint", () =>
          clients.acr.getInstanceVpcEndpoint(
            new ACR.GetInstanceVpcEndpointRequest({
              instanceId: props.instanceId,
              moduleName: moduleName(props.moduleName),
            }),
          ),
        ).pipe(
          Effect.map((response) => {
            const link = response.body?.linkedVpcs?.find(
              (item) =>
                item.vpcId === props.vpcId && item.vswitchId === props.vswitchId,
            );
            return link === undefined
              ? undefined
              : {
                  ...props,
                  moduleName: moduleName(props.moduleName),
                  status: link.status ?? "Unknown",
                  ip: link.ip,
                  issue: link.issue,
                  defaultAccess: link.defaultAccess ?? false,
                  domains: response.body?.domains ?? [],
                } satisfies VpcEndpointLinkAttributes;
          }),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
      return {
        version: 1,
        stables: ["instanceId", "vpcId", "vswitchId", "moduleName"] as const,
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds.instanceId === undefined ||
            olds.vpcId === undefined ||
            olds.vswitchId === undefined
          ) {
            return undefined;
          }
          return olds.instanceId !== news.instanceId ||
            olds.vpcId !== news.vpcId ||
            olds.vswitchId !== news.vswitchId ||
            moduleName(olds.moduleName) !== moduleName(news.moduleName) ||
            (olds.enablePrivateZoneRecord ?? false) !==
              (news.enablePrivateZoneRecord ?? false)
            ? ({ action: "replace" } as const)
            : undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const instanceId = olds.instanceId ?? output?.instanceId;
          const vpcId = olds.vpcId ?? output?.vpcId;
          const vswitchId = olds.vswitchId ?? output?.vswitchId;
          if (
            instanceId === undefined ||
            vpcId === undefined ||
            vswitchId === undefined
          ) {
            return undefined;
          }
          return yield* observe({
            instanceId,
            vpcId,
            vswitchId,
            moduleName: olds.moduleName ?? output?.moduleName,
            enablePrivateZoneRecord:
              olds.enablePrivateZoneRecord ?? output?.enablePrivateZoneRecord,
          });
        }),
        reconcile: Effect.fn(function* ({ news }) {
          let link = yield* observe(news);
          if (link === undefined) {
            yield* acrSdkCall("CreateInstanceVpcEndpointLinkedVpc", () =>
              clients.acr.createInstanceVpcEndpointLinkedVpc(
                new ACR.CreateInstanceVpcEndpointLinkedVpcRequest({
                  instanceId: news.instanceId,
                  vpcId: news.vpcId,
                  vswitchId: news.vswitchId,
                  moduleName: moduleName(news.moduleName),
                  enableCreateDNSRecordInPvzt:
                    news.enablePrivateZoneRecord ?? false,
                }),
              ),
            );
          }
          link = yield* waitForPresent({
            service: "ACR",
            operation: "CreateInstanceVpcEndpointLinkedVpc",
            read: observe(news),
            ready: (value) => value.status.toLowerCase() === "running",
            wait: options.wait,
          });
          return link;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryingAcrSdkCall("DeleteInstanceVpcEndpointLinkedVpc", () =>
            clients.acr.deleteInstanceVpcEndpointLinkedVpc(
              new ACR.DeleteInstanceVpcEndpointLinkedVpcRequest({
                instanceId: output.instanceId,
                vpcId: output.vpcId,
                vswitchId: output.vswitchId,
                moduleName: moduleName(output.moduleName),
              }),
            ),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitForAbsent({
            service: "ACR",
            operation: "DeleteInstanceVpcEndpointLinkedVpc",
            read: observe(output),
            wait: options.wait,
          });
        }),
      };
    }),
  );
