import * as ACR from "@alicloud/cr20181201";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { AlibabaClients } from "../clients.ts";
import { acrSdkCall, isNotFound, retryingAcrSdkCall } from "../error.ts";
import {
  physicalName,
  requireValue,
  waitForAbsent,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Without } from "../internal/model-input.ts";
import type { Providers } from "../providers.ts";

export type RepositorySettings = Without<
  ACR.CreateRepositoryRequest,
  | "instanceId"
  | "repoName"
  | "repoNamespaceName"
  | "repoType"
  | "summary"
> & {
  /** Required by CreateRepository and UpdateRepository. */
  readonly repoType: "PUBLIC" | "PRIVATE";
  /** Required by CreateRepository and UpdateRepository. */
  readonly summary: string;
};

export interface RepositoryProps {
  readonly instanceId: string;
  readonly namespaceName: string;
  readonly name?: string;
  readonly settings: RepositorySettings;
}

export interface RepositoryAttributes {
  readonly instanceId: string;
  readonly namespaceName: string;
  readonly repositoryId?: string;
  readonly name: string;
  readonly status?: string;
  readonly type?: string;
  readonly summary?: string;
  readonly detail?: string;
  readonly tagImmutability: boolean;
  readonly createdAt?: number;
  readonly modifiedAt?: number;
  readonly resourceGroupId?: string;
}

export type Repository = Resource<
  "Alibaba.ACR.Repository",
  RepositoryProps,
  RepositoryAttributes,
  never,
  Providers
>;

export const Repository = Resource<Repository>("Alibaba.ACR.Repository");

const toAttributes = (
  instanceId: string,
  namespaceName: string,
  name: string,
  body: ACR.GetRepositoryResponseBody,
): RepositoryAttributes => ({
  instanceId,
  namespaceName: body.repoNamespaceName ?? namespaceName,
  repositoryId: body.repoId,
  name: body.repoName ?? name,
  status: body.repoStatus,
  type: body.repoType,
  summary: body.summary,
  detail: body.detail,
  tagImmutability: body.tagImmutability ?? false,
  createdAt: body.createTime,
  modifiedAt: body.modifiedTime,
  resourceGroupId: body.resourceGroupId,
});

const settingsMatch = (
  body: ACR.GetRepositoryResponseBody,
  settings: RepositorySettings,
) =>
  (settings.repoType === undefined || body.repoType === settings.repoType) &&
  (settings.summary === undefined || body.summary === settings.summary) &&
  (settings.detail === undefined || body.detail === settings.detail) &&
  (settings.tagImmutability === undefined ||
    body.tagImmutability === settings.tagImmutability);

export interface RepositoryProviderOptions {
  readonly wait?: WaitOptions;
}

/** ACR repositories have no ownership metadata and are silently adoptable. */
export const RepositoryProvider = (options: RepositoryProviderOptions = {}) =>
  Provider.effect(
    Repository,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const get = (instanceId: string, namespaceName: string, name: string) =>
        retryingAcrSdkCall("GetRepository", () =>
          clients.acr.getRepository(
            new ACR.GetRepositoryRequest({
              instanceId,
              repoNamespaceName: namespaceName,
              repoName: name,
            }),
          ),
        ).pipe(
          Effect.map((response) => response.body),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
      return {
        version: 1,
        stables: [
          "instanceId",
          "namespaceName",
          "repositoryId",
          "name",
          "createdAt",
        ] as const,
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds.instanceId === undefined ||
            olds.namespaceName === undefined
          ) {
            return undefined;
          }
          return olds.instanceId !== news.instanceId ||
            olds.namespaceName !== news.namespaceName ||
            olds.name !== news.name
            ? ({ action: "replace" } as const)
            : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const instanceId = olds.instanceId ?? output?.instanceId;
          const namespaceName = olds.namespaceName ?? output?.namespaceName;
          if (instanceId === undefined || namespaceName === undefined) {
            return undefined;
          }
          const name = yield* physicalName(id, olds.name ?? output?.name, 128);
          const body = yield* get(instanceId, namespaceName, name);
          return body === undefined
            ? undefined
            : toAttributes(instanceId, namespaceName, name, body);
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = yield* physicalName(id, news.name ?? output?.name, 128);
          let body = yield* get(news.instanceId, news.namespaceName, name);
          if (body === undefined) {
            yield* acrSdkCall("CreateRepository", () =>
              clients.acr.createRepository(
                new ACR.CreateRepositoryRequest({
                  ...news.settings,
                  instanceId: news.instanceId,
                  repoNamespaceName: news.namespaceName,
                  repoName: name,
                }),
              ),
            );
          } else if (!settingsMatch(body, news.settings)) {
            const repositoryId = yield* requireValue(
              body.repoId,
              Repository.Type,
              "UpdateRepository",
              "ACR returned a repository without repoId",
            );
            yield* acrSdkCall("UpdateRepository", () =>
              clients.acr.updateRepository(
                new ACR.UpdateRepositoryRequest({
                  ...news.settings,
                  instanceId: news.instanceId,
                  repoId: repositoryId,
                  repoNamespaceName: news.namespaceName,
                  repoName: name,
                }),
              ),
            );
          }
          body = yield* waitForPresent({
            service: "ACR",
            operation: "ReconcileRepository",
            read: get(news.instanceId, news.namespaceName, name),
            ready: (value) =>
              value.repoStatus?.toLowerCase() === "normal" &&
              settingsMatch(value, news.settings),
            wait: options.wait,
          });
          return toAttributes(news.instanceId, news.namespaceName, name, body);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryingAcrSdkCall("DeleteRepository", () =>
            clients.acr.deleteRepository(
              new ACR.DeleteRepositoryRequest({
                instanceId: output.instanceId,
                repoId: output.repositoryId,
                repoNamespaceName: output.namespaceName,
                repoName: output.name,
              }),
            ),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitForAbsent({
            service: "ACR",
            operation: "DeleteRepository",
            read: get(output.instanceId, output.namespaceName, output.name),
            wait: options.wait,
          });
        }),
      };
    }),
  );
