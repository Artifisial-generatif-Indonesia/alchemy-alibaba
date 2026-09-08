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

export interface EndpointAclEntryProps {
  readonly instanceId: string;
  readonly endpointType?: string;
  readonly moduleName?: "Registry" | "Chart";
  readonly entry: string;
  readonly comment?: string;
}

export interface EndpointAclEntryAttributes extends EndpointAclEntryProps {
  readonly endpointEnabled: boolean;
  readonly aclEnabled: boolean;
}

export type EndpointAclEntry = Resource<
  "Alibaba.ACR.EndpointAclEntry",
  EndpointAclEntryProps,
  EndpointAclEntryAttributes,
  never,
  Providers
>;

export const EndpointAclEntry = Resource<EndpointAclEntry>(
  "Alibaba.ACR.EndpointAclEntry",
);

/** ACR ACL entries have compound identity and no ownership metadata. */
export interface EndpointAclEntryProviderOptions {
  readonly wait?: WaitOptions;
}

const endpointType = (value: string | undefined) => value ?? "Internet";
const moduleName = (value: "Registry" | "Chart" | undefined) =>
  value ?? "Registry";

export const EndpointAclEntryProvider = (
  options: EndpointAclEntryProviderOptions = {},
) =>
  Provider.effect(
    EndpointAclEntry,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const observe = (props: EndpointAclEntryProps) =>
        retryingAcrSdkCall("GetInstanceEndpoint", () =>
          clients.acr.getInstanceEndpoint(
            new ACR.GetInstanceEndpointRequest({
              instanceId: props.instanceId,
              endpointType: endpointType(props.endpointType),
              moduleName: moduleName(props.moduleName),
            }),
          ),
        ).pipe(
          Effect.map((response) => {
            const match = response.body?.aclEntries?.find(
              (entry) => entry.entry === props.entry,
            );
            return match === undefined
              ? undefined
              : {
                  ...props,
                  endpointType: endpointType(props.endpointType),
                  moduleName: moduleName(props.moduleName),
                  comment: match.comment,
                  endpointEnabled: response.body?.enable ?? false,
                  aclEnabled: response.body?.aclEnable ?? false,
                } satisfies EndpointAclEntryAttributes;
          }),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
      const create = (props: EndpointAclEntryProps) =>
        acrSdkCall("CreateInstanceEndpointAclPolicy", () =>
          clients.acr.createInstanceEndpointAclPolicy(
            new ACR.CreateInstanceEndpointAclPolicyRequest({
              instanceId: props.instanceId,
              endpointType: endpointType(props.endpointType),
              moduleName: moduleName(props.moduleName),
              entries: [{ entry: props.entry, comment: props.comment }],
            }),
          ),
        );
      const remove = (props: EndpointAclEntryProps) =>
        retryingAcrSdkCall("DeleteInstanceEndpointAclPolicy", () =>
          clients.acr.deleteInstanceEndpointAclPolicy(
            new ACR.DeleteInstanceEndpointAclPolicyRequest({
              instanceId: props.instanceId,
              endpointType: endpointType(props.endpointType),
              moduleName: moduleName(props.moduleName),
              entries: [{ entry: props.entry, comment: props.comment }],
            }),
          ),
        ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
      return {
        version: 1,
        stables: ["instanceId", "endpointType", "moduleName", "entry"] as const,
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds.instanceId === undefined || olds.entry === undefined) {
            return undefined;
          }
          return olds.instanceId !== news.instanceId ||
            endpointType(olds.endpointType) !== endpointType(news.endpointType) ||
            moduleName(olds.moduleName) !== moduleName(news.moduleName) ||
            olds.entry !== news.entry
            ? ({ action: "replace" } as const)
            : undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const instanceId = olds.instanceId ?? output?.instanceId;
          const entry = olds.entry ?? output?.entry;
          if (instanceId === undefined || entry === undefined) return undefined;
          return yield* observe({
            instanceId,
            endpointType: olds.endpointType ?? output?.endpointType,
            moduleName: olds.moduleName ?? output?.moduleName,
            entry,
            comment: olds.comment ?? output?.comment,
          });
        }),
        reconcile: Effect.fn(function* ({ news }) {
          let current = yield* observe(news);
          if (current === undefined) {
            yield* create(news);
          } else if (current.comment !== news.comment) {
            yield* remove(current);
            yield* waitForAbsent({
              service: "ACR",
              operation: "ReplaceInstanceEndpointAclPolicy",
              read: observe(news),
              wait: options.wait,
            });
            yield* create(news);
          }
          current = yield* waitForPresent({
            service: "ACR",
            operation: "CreateInstanceEndpointAclPolicy",
            read: observe(news),
            ready: (value) =>
              value.comment === news.comment &&
              value.endpointEnabled &&
              value.aclEnabled,
            wait: options.wait,
          });
          return current;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* remove(output);
          yield* waitForAbsent({
            service: "ACR",
            operation: "DeleteInstanceEndpointAclPolicy",
            read: observe(output),
            wait: options.wait,
          });
        }),
      };
    }),
  );
