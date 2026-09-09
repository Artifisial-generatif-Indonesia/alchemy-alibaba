import { isResolved } from "alchemy/Diff";
import type { ClusterLike } from "alchemy/Kubernetes/Connection";
import {
  Manifest,
  ManifestProvider,
  type ManifestProps,
} from "alchemy/Kubernetes/Manifest";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AlibabaInvariantError } from "../error.ts";
import type { Providers } from "../providers.ts";

export interface SecretProps {
  readonly cluster: ClusterLike;
  readonly name: string;
  readonly namespace: string;
  /** Plain values wrapped in Redacted; encoded at the Kubernetes request boundary. */
  readonly data: Readonly<Record<string, Redacted.Redacted<string>>>;
  readonly type?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly annotations?: Readonly<Record<string, string>>;
}

/** A redacted Secret contract using Alchemy's existing Manifest lifecycle. */
export type Secret = Resource<
  "Kubernetes.Secret",
  SecretProps,
  Manifest["Attributes"],
  never,
  Providers
>;
export const Secret = Resource<Secret>("Kubernetes.Secret");

const manifest = (
  props: SecretProps,
  data: Record<string, string> = {},
): ManifestProps => ({
  cluster: props.cluster,
  manifest: {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: props.name,
      namespace: props.namespace,
      labels: props.labels,
      annotations: props.annotations,
    },
    type: props.type ?? "Opaque",
    data,
  },
});

// Kubernetes validation errors can echo the submitted Secret, including base64 data.
const sanitizeError = (operation: string) =>
  Effect.mapError(
    () =>
      new AlibabaInvariantError({
        resourceType: Secret.Type,
        operation,
        message: `Kubernetes Secret ${operation} failed; response details are withheld because they may contain secret data`,
      }),
  );

export const SecretProvider = () =>
  Provider.effect(
    Secret,
    Effect.gen(function* () {
      const upstream = yield* Manifest.Provider;
      return {
        version: 1,
        stables: upstream.stables,
        diff: Effect.fn(function* ({ olds, news, ...context }) {
          if (!isResolved(news)) return;
          return yield* upstream.diff!({
            ...context,
            olds: manifest(olds),
            news: manifest(news),
          });
        }),
        read: Effect.fn(function* ({ olds, ...context }) {
          return yield* upstream.read!({
            ...context,
            olds: manifest(olds),
          }).pipe(sanitizeError("read"));
        }),
        reconcile: Effect.fn(function* ({ news, olds, ...context }) {
          const data: Record<string, string> = {};
          for (const [key, value] of Object.entries(news.data)) {
            if (!Redacted.isRedacted(value))
              return yield* new AlibabaInvariantError({
                resourceType: Secret.Type,
                operation: "ValidateSecret",
                message: "Kubernetes Secret data must use Redacted.make",
              });
            data[key] = yield* Effect.sync(() =>
              Buffer.from(Redacted.value(value), "utf8").toString("base64"),
            );
          }
          return yield* upstream
            .reconcile({
              ...context,
              news: manifest(news, data),
              olds: olds === undefined ? undefined : manifest(olds),
            })
            .pipe(sanitizeError("apply"));
        }),
        delete: Effect.fn(function* ({ olds, ...context }) {
          return yield* upstream
            .delete({ ...context, olds: manifest(olds) })
            .pipe(sanitizeError("delete"));
        }),
      };
    }),
  ).pipe(Layer.provide(ManifestProvider()));
