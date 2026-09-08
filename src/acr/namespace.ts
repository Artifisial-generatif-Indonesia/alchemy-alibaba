import * as ACR from "@alicloud/cr20181201";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { isDeepStrictEqual } from "node:util";
import { AlibabaClients } from "../clients.ts";
import { acrSdkCall, isNotFound, retryingAcrSdkCall } from "../error.ts";
import {
  physicalName,
  waitForAbsent,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Without } from "../internal/model-input.ts";
import type { Providers } from "../providers.ts";

export type NamespaceSettings = Without<
  ACR.CreateNamespaceRequest,
  "instanceId" | "namespaceName"
>;

export interface NamespaceProps {
  readonly instanceId: string;
  readonly name?: string;
  readonly settings?: NamespaceSettings;
}

export interface NamespaceAttributes {
  readonly instanceId: string;
  readonly namespaceId?: string;
  readonly name: string;
  readonly status?: string;
  readonly autoCreateRepo: boolean;
  readonly defaultRepoType?: string;
  readonly defaultRepoConfiguration?: Without<ACR.RepoConfiguration, never>;
  readonly resourceGroupId?: string;
}

export type Namespace = Resource<
  "Alibaba.ACR.Namespace",
  NamespaceProps,
  NamespaceAttributes,
  never,
  Providers
>;

export const Namespace = Resource<Namespace>("Alibaba.ACR.Namespace");

const toAttributes = (
  instanceId: string,
  name: string,
  body: ACR.GetNamespaceResponseBody,
): NamespaceAttributes => ({
  instanceId,
  namespaceId: body.namespaceId,
  name: body.namespaceName ?? name,
  status: body.namespaceStatus,
  autoCreateRepo: body.autoCreateRepo ?? false,
  defaultRepoType: body.defaultRepoType,
  defaultRepoConfiguration: body.defaultRepoConfiguration,
  resourceGroupId: body.resourceGroupId,
});

const settingsMatch = (
  body: ACR.GetNamespaceResponseBody,
  settings: NamespaceSettings,
) =>
  (settings.autoCreateRepo === undefined ||
    body.autoCreateRepo === settings.autoCreateRepo) &&
  (settings.defaultRepoType === undefined ||
    body.defaultRepoType === settings.defaultRepoType) &&
  (settings.defaultRepoConfiguration === undefined ||
    isDeepStrictEqual(
      body.defaultRepoConfiguration,
      settings.defaultRepoConfiguration,
    ));

export interface NamespaceProviderOptions {
  readonly wait?: WaitOptions;
}

/** ACR namespaces have no ownership metadata and are silently adoptable. */
export const NamespaceProvider = (options: NamespaceProviderOptions = {}) =>
  Provider.effect(
    Namespace,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const get = (instanceId: string, name: string) =>
        retryingAcrSdkCall("GetNamespace", () =>
          clients.acr.getNamespace(
            new ACR.GetNamespaceRequest({ instanceId, namespaceName: name }),
          ),
        ).pipe(
          Effect.map((response) => response.body),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
      return {
        version: 1,
        stables: ["instanceId", "namespaceId", "name"] as const,
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds.instanceId === undefined) return undefined;
          return olds.instanceId !== news.instanceId || olds.name !== news.name
            ? ({ action: "replace" } as const)
            : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const instanceId = olds.instanceId ?? output?.instanceId;
          if (instanceId === undefined) return undefined;
          const name = yield* physicalName(id, olds.name ?? output?.name, 120);
          const body = yield* get(instanceId, name);
          return body === undefined
            ? undefined
            : toAttributes(instanceId, name, body);
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = yield* physicalName(id, news.name ?? output?.name, 120);
          const settings = news.settings ?? {};
          let body = yield* get(news.instanceId, name);
          if (body === undefined) {
            yield* acrSdkCall("CreateNamespace", () =>
              clients.acr.createNamespace(
                new ACR.CreateNamespaceRequest({
                  ...settings,
                  instanceId: news.instanceId,
                  namespaceName: name,
                }),
              ),
            );
          } else if (!settingsMatch(body, settings)) {
            yield* acrSdkCall("UpdateNamespace", () =>
              clients.acr.updateNamespace(
                new ACR.UpdateNamespaceRequest({
                  ...settings,
                  instanceId: news.instanceId,
                  namespaceName: name,
                }),
              ),
            );
          }
          body = yield* waitForPresent({
            service: "ACR",
            operation: "ReconcileNamespace",
            read: get(news.instanceId, name),
            ready: (value) =>
              value.namespaceStatus?.toLowerCase() === "normal" &&
              settingsMatch(value, settings),
            wait: options.wait,
          });
          return toAttributes(news.instanceId, name, body);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryingAcrSdkCall("DeleteNamespace", () =>
            clients.acr.deleteNamespace(
              new ACR.DeleteNamespaceRequest({
                instanceId: output.instanceId,
                namespaceName: output.name,
              }),
            ),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitForAbsent({
            service: "ACR",
            operation: "DeleteNamespace",
            read: get(output.instanceId, output.name),
            wait: options.wait,
          });
        }),
      };
    }),
  );
