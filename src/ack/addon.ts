import * as ACK from "@alicloud/cs20151215";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { AlibabaClients } from "../clients.ts";
import { isNotFound, retryingSdkCall, sdkCall } from "../error.ts";
import {
  requestOrContinueDelete,
  requireValue,
  waitFor,
  waitForAbsent,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { ModelInput, Without } from "../internal/model-input.ts";
import type { Providers } from "../providers.ts";
import { waitForTask } from "./task.ts";

export interface AddonProps {
  readonly clusterId: string;
  readonly name: string;
  readonly version: string;
  readonly config?: string;
  /** Extra upgrade controls, such as canary policy and current version. */
  readonly upgrade?: Without<
    ACK.UpgradeClusterAddonsRequestBody,
    "componentName" | "nextVersion" | "config"
  >;
  readonly uninstall?: Without<
    ACK.UnInstallClusterAddonsRequestAddons,
    "name"
  >;
}

export interface AddonAttributes {
  readonly clusterId: string;
  readonly name: string;
  readonly version?: string;
  readonly config?: string;
  readonly state: string;
}

export type Addon = Resource<
  "Alibaba.ACK.Addon",
  AddonProps,
  AddonAttributes,
  never,
  Providers
>;

export const Addon = Resource<Addon>("Alibaba.ACK.Addon");

const toAttributes = (
  clusterId: string,
  name: string,
  addon: ACK.DescribeClusterAddonInstanceResponseBody,
): AddonAttributes => ({
  clusterId,
  name: addon.name ?? name,
  version: addon.version,
  config: addon.config,
  state: addon.state ?? "Unknown",
});

const ready = (addon: ACK.DescribeClusterAddonInstanceResponseBody) =>
  addon.state?.toLowerCase() === "active";

const deleting = (addon: ACK.DescribeClusterAddonInstanceResponseBody) => {
  const state = addon.state?.toLowerCase();
  return state === "deleting" || state === "uninstalling";
};

export interface AddonProviderOptions {
  readonly wait?: WaitOptions;
}

/**
 * ACK has no tag or metadata field on addon instances. Existing addons are
 * therefore silently adoptable by compound identity (clusterId + name).
 */
export const AddonProvider = (options: AddonProviderOptions = {}) =>
  Provider.effect(
    Addon,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;

      const observe = (clusterId: string, name: string) =>
        retryingSdkCall("ACK", "DescribeClusterAddonInstance", () =>
          clients.ack.describeClusterAddonInstance(clusterId, name),
        ).pipe(
          Effect.map((response) => {
            const body = response.body;
            return body?.state?.toLowerCase() === "deleted" ? undefined : body;
          }),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );

      return {
        version: 1,
        stables: ["clusterId", "name"] as const,

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds.clusterId === undefined || olds.name === undefined) {
            return undefined;
          }
          return olds.clusterId !== news.clusterId || olds.name !== news.name
            ? ({ action: "replace" } as const)
            : undefined;
        }),

        read: Effect.fn(function* ({ olds, output }) {
          const clusterId = olds.clusterId ?? output?.clusterId;
          const name = olds.name ?? output?.name;
          if (clusterId === undefined || name === undefined) return undefined;
          const addon = yield* observe(clusterId, name);
          return addon === undefined
            ? undefined
            : toAttributes(clusterId, name, addon);
        }),

        reconcile: Effect.fn(function* ({ news, output }) {
          let addon = yield* observe(news.clusterId, news.name);
          if (addon === undefined) {
            const response = yield* sdkCall("ACK", "InstallClusterAddons", () =>
              clients.ack.installClusterAddons(
                news.clusterId,
                new ACK.InstallClusterAddonsRequest({
                  body: [
                    {
                      name: news.name,
                      version: news.version,
                      config: news.config,
                    },
                  ],
                }),
              ),
            );
            yield* waitForTask({
              client: clients.ack,
              operation: "InstallClusterAddons",
              taskId: response.body?.taskId,
              wait: options.wait,
            });
          } else {
            if (addon.version !== news.version) {
              const response = yield* sdkCall("ACK", "UpgradeClusterAddons", () =>
                clients.ack.upgradeClusterAddons(
                  news.clusterId,
                  new ACK.UpgradeClusterAddonsRequest({
                    body: [
                      {
                        ...news.upgrade,
                        componentName: news.name,
                        nextVersion: news.version,
                        config: news.config,
                      },
                    ],
                  }),
                ),
              );
              yield* waitForTask({
                client: clients.ack,
                operation: "UpgradeClusterAddons",
                taskId: response.body?.taskId,
                wait: options.wait,
              });
            } else if (addon.config !== news.config) {
              yield* sdkCall("ACK", "ModifyClusterAddon", () =>
                clients.ack.modifyClusterAddon(
                  news.clusterId,
                  news.name,
                  new ACK.ModifyClusterAddonRequest({ config: news.config }),
                ),
              );
            }
          }

          addon = yield* waitForPresent({
            service: "ACK",
            operation: "ReconcileClusterAddon",
            read: observe(news.clusterId, news.name),
            ready: (value) =>
              ready(value) &&
              value.version === news.version &&
              value.config === news.config,
            wait: options.wait,
          });
          return toAttributes(news.clusterId, output?.name ?? news.name, addon);
        }),

        delete: Effect.fn(function* ({ output, olds }) {
          const addon = yield* observe(output.clusterId, output.name);
          if (addon === undefined) return;
          if (!deleting(addon)) {
            const response = yield* requestOrContinueDelete({
              request: retryingSdkCall("ACK", "UnInstallClusterAddons", () =>
                clients.ack.unInstallClusterAddons(
                  output.clusterId,
                  new ACK.UnInstallClusterAddonsRequest({
                    addons: [{ ...olds.uninstall, name: output.name }],
                  }),
                ),
              ),
              read: observe(output.clusterId, output.name),
              deleting,
            });
            yield* waitForTask({
              client: clients.ack,
              operation: "UnInstallClusterAddons",
              taskId: response?.body?.taskId,
              wait: options.wait,
            });
          }
          yield* waitForAbsent({
            service: "ACK",
            operation: "UnInstallClusterAddons",
            read: observe(output.clusterId, output.name),
            wait: options.wait,
          });
        }),
      };
    }),
  );
