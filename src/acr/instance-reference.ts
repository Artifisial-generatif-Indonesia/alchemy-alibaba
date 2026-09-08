import * as ACR from "@alicloud/cr20181201";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { AlibabaClients } from "../clients.ts";
import { isNotFound, retryingAcrSdkCall } from "../error.ts";
import { requireValue } from "../internal/lifecycle.ts";
import type { Providers } from "../providers.ts";

export interface InstanceReferenceProps {
  readonly instanceId: string;
}

export interface InstanceReferenceAttributes {
  readonly instanceId: string;
  readonly instanceName?: string;
  readonly specification?: string;
  readonly status?: string;
  readonly resourceGroupId?: string;
  readonly createdAt?: number;
  readonly modifiedAt?: number;
  readonly tags: Readonly<Record<string, string>>;
}

export type InstanceReference = Resource<
  "Alibaba.ACR.InstanceReference",
  InstanceReferenceProps,
  InstanceReferenceAttributes,
  never,
  Providers
>;

export const InstanceReference = Resource<InstanceReference>(
  "Alibaba.ACR.InstanceReference",
);

const toAttributes = (body: ACR.GetInstanceResponseBody) =>
  Effect.gen(function* () {
    const instanceId = yield* requireValue(
      body.instanceId,
      InstanceReference.Type,
      "GetInstance",
      "ACR returned an instance without instanceId",
    );
    return {
      instanceId,
      instanceName: body.instanceName,
      specification: body.instanceSpecification,
      status: body.instanceStatus,
      resourceGroupId: body.resourceGroupId,
      createdAt: body.createTime,
      modifiedAt: body.modifiedTime,
      tags: Object.fromEntries(
        (body.tags ?? []).flatMap((tag) =>
          tag.tagKey === undefined || tag.tagValue === undefined
            ? []
            : [[tag.tagKey, tag.tagValue] as const],
        ),
      ),
    } satisfies InstanceReferenceAttributes;
  });

/** ACR exposes no create/delete lifecycle for paid Enterprise instances. */
export const InstanceReferenceProvider = () =>
  Provider.effect(
    InstanceReference,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const get = (instanceId: string) =>
        retryingAcrSdkCall("GetInstance", () =>
          clients.acr.getInstance(new ACR.GetInstanceRequest({ instanceId })),
        ).pipe(
          Effect.map((response) => response.body),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
      return {
        version: 1,
        nuke: { skip: true },
        stables: ["instanceId"] as const,
        read: Effect.fn(function* ({ olds, output }) {
          const instanceId = olds.instanceId ?? output?.instanceId;
          if (instanceId === undefined) return undefined;
          const body = yield* get(instanceId);
          return body === undefined ? undefined : yield* toAttributes(body);
        }),
        reconcile: Effect.fn(function* ({ news }) {
          const body = yield* get(news.instanceId).pipe(
            Effect.flatMap((value) =>
              requireValue(
                value,
                InstanceReference.Type,
                "GetInstance",
                `ACR instance ${news.instanceId} was not found`,
              ),
            ),
          );
          return yield* toAttributes(body);
        }),
        delete: () => Effect.void,
      };
    }),
  );
