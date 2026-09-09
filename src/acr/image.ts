import * as ACR from "@alicloud/cr20181201";
import { isResolved } from "alchemy/Diff";
import {
  Image as DockerImage,
  ImageProvider as DockerImageProvider,
  type ImageProps as DockerImageProps,
} from "alchemy/Docker/Image";
import { DockerLive } from "alchemy/Docker/Docker";
import type { ImageRegistry } from "alchemy/Docker/Registry";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AlibabaClients, clientsFromEnvironment } from "../clients.ts";
import { AlibabaInvariantError, retryingAcrSdkCall } from "../error.ts";
import {
  requireValue,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";

/** Separate collection because image builds require Alchemy's Docker services. */
export class ImageProviders extends Provider.ProviderCollection<ImageProviders>()(
  "Alibaba.ACR.Images",
) {}
export interface ImageProps {
  readonly instanceId: string;
  readonly repositoryId: string;
  /** Full host/namespace/repository. The repository must already exist. */
  readonly repositoryUri: string;
  /** Explicit immutable release tag. Use a new tag for changed contents. */
  readonly tag: string;
  readonly build: DockerImageProps["build"];
  readonly context?: DockerImageProps["context"];
}
export type ImageAttributes = DockerImage["Attributes"] & {
  readonly instanceId: string;
  readonly repositoryId: string;
  readonly imageUri: string;
};
export type Image = Resource<
  "Alibaba.ACR.Image",
  ImageProps,
  ImageAttributes,
  never,
  ImageProviders
>;
export const Image = Resource<Image>("Alibaba.ACR.Image");

export const getRegistryCredentials = Effect.fn("ACR.getRegistryCredentials")(
  function* (instanceId: string, server: string) {
    const clients = yield* AlibabaClients;
    const response = yield* retryingAcrSdkCall("GetAuthorizationToken", () =>
      clients.acr.getAuthorizationToken(
        new ACR.GetAuthorizationTokenRequest({ instanceId }),
      ),
    );
    const username = yield* requireValue(
      response.body?.tempUsername,
      Image.Type,
      "GetAuthorizationToken",
      "ACR returned no temporary username",
    );
    const token = yield* requireValue(
      response.body?.authorizationToken,
      Image.Type,
      "GetAuthorizationToken",
      "ACR returned no registry token",
    );
    return {
      server,
      username,
      password: Redacted.make(token),
    } satisfies ImageRegistry;
  },
);

const dockerProps = (
  props: ImageProps,
  registry?: ImageRegistry,
): DockerImageProps => ({
  name: props.repositoryUri,
  tag: props.tag,
  build: props.build,
  context: props.context,
  registry,
});
export const ImageProvider = (options: { readonly wait?: WaitOptions } = {}) =>
  Provider.effect(
    Image,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const upstream = yield* DockerImage.Provider;
      const digest = (
        props: Pick<ImageProps, "instanceId" | "repositoryId" | "tag">,
      ) =>
        retryingAcrSdkCall("GetRepoTag", () =>
          clients.acr.getRepoTag(
            new ACR.GetRepoTagRequest({
              instanceId: props.instanceId,
              repoId: props.repositoryId,
              tag: props.tag,
            }),
          ),
        ).pipe(
          Effect.map((r) => r.body?.digest),
          Effect.catchIf(
            (error) => error.code === "TAG_NOT_EXIST",
            () => Effect.succeed(undefined),
          ),
        );
      return {
        version: 1,
        diff: Effect.fn(function* ({ olds, news, ...context }) {
          if (!isResolved(news)) return;
          return yield* upstream.diff!({
            ...context,
            olds: dockerProps(olds),
            news: dockerProps(news),
          });
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return;
          const observed = yield* digest(output);
          return observed
            ? {
                ...output,
                imageUri: `${output.name}@${observed}`,
                repoDigest: `${output.name}@${observed}`,
              }
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ olds, news, ...context }) {
          const host = news.repositoryUri.split("/")[0];
          if (!host || !news.repositoryUri.includes("/") || !news.tag)
            return yield* new AlibabaInvariantError({
              resourceType: Image.Type,
              operation: "Validate",
              message:
                "ACR image requires a repository URI and explicit release tag",
            });
          const registry = yield* getRegistryCredentials(
            news.instanceId,
            host,
          ).pipe(Effect.provideService(AlibabaClients, clients));
          const result = yield* upstream.reconcile({
            ...context,
            news: dockerProps(news, registry),
            olds: olds ? dockerProps(olds) : undefined,
          });
          const observed = yield* waitForPresent({
            service: "ACR",
            operation: "GetRepoTag",
            read: digest(news),
            ready: (value) => /^sha256:[a-f0-9]{64}$/.test(value),
            wait: options.wait,
          });
          return {
            ...result,
            instanceId: news.instanceId,
            repositoryId: news.repositoryId,
            imageUri: `${news.repositoryUri}@${observed}`,
            repoDigest: `${news.repositoryUri}@${observed}`,
          };
        }),
        // Match Docker.Image ownership: remove local build artifacts. Published
        // immutable tags belong to the repository and can still back running pods.
        delete: Effect.fn(function* ({ olds, ...context }) {
          return yield* upstream.delete({
            ...context,
            olds: dockerProps(olds),
          });
        }),
      };
    }),
  ).pipe(Layer.provide(DockerImageProvider()));

/** Compose alongside Alibaba.providers; accepts the same AlibabaClients layer. */
export const imageProviders = (options: { readonly wait?: WaitOptions } = {}) =>
  Layer.effect(ImageProviders, Provider.collection([Image])).pipe(
    Layer.provide(ImageProvider(options)),
    Layer.provide(DockerLive),
  );
export const imageProvidersFromEnvironment = (
  options: { readonly wait?: WaitOptions } = {},
) =>
  imageProviders(options).pipe(
    Layer.provide(clientsFromEnvironment()),
    Layer.orDie,
  );
