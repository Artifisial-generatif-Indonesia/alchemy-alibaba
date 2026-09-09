import * as ACK from "@alicloud/cs20151215";
import {
  ClusterAdapter,
  ClusterNotFoundError,
  type ClusterAdapterService,
} from "alchemy/Kubernetes/ClusterAdapter";
import type { Connection } from "alchemy/Kubernetes/Connection";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as YAML from "yaml";
import { AlibabaClients } from "../clients.ts";
import {
  AlibabaInvariantError,
  isNotFound,
  retryingSdkCall,
} from "../error.ts";
import { requireRegion, requireValue } from "../internal/lifecycle.ts";

declare module "alchemy/Kubernetes/Connection" {
  interface AuthRegistry {
    "alibaba-ack": {
      clusterId: string;
      regionId?: string;
      privateIpAddress?: boolean;
      temporaryDurationMinutes?: number;
    };
  }
}

export interface KubeconfigOptions {
  /** Use the private API endpoint. Defaults to true. */
  readonly privateIpAddress?: boolean;
  /** Temporary credential lifetime, 15–4320 minutes. Defaults to 180. */
  readonly temporaryDurationMinutes?: number;
  readonly regionId?: string;
}

/** Serializable connection identity; credentials are fetched when connecting. */
export const clusterConnection = (
  clusterId: string,
  options: KubeconfigOptions = {},
): Connection => ({
  auth: { kind: "alibaba-ack", clusterId, ...options },
});

/** Fetch a temporary ACK kubeconfig without persisting its private key as an attribute. */
export const getKubeconfig = Effect.fn("ACK.getKubeconfig")(function* (
  clusterId: string,
  options: KubeconfigOptions = {},
) {
  const clients = yield* AlibabaClients;
  yield* requireRegion(
    "Alibaba.ACK.Kubeconfig",
    clients.regionId,
    options.regionId,
  );
  const duration = options.temporaryDurationMinutes ?? 180;
  if (!Number.isInteger(duration) || duration < 15 || duration > 4320) {
    return yield* new AlibabaInvariantError({
      resourceType: "Alibaba.ACK.Kubeconfig",
      operation: "Validate",
      message: "Kubeconfig duration must be an integer from 15 to 4320 minutes",
    });
  }
  const response = yield* retryingSdkCall(
    "ACK",
    "DescribeClusterUserKubeconfig",
    () =>
      clients.ack.describeClusterUserKubeconfig(
        clusterId,
        new ACK.DescribeClusterUserKubeconfigRequest({
          privateIpAddress: options.privateIpAddress ?? true,
          temporaryDurationMinutes: duration,
        }),
      ),
  );
  const config = yield* requireValue(
    response.body?.config,
    "Alibaba.ACK.Kubeconfig",
    "DescribeClusterUserKubeconfig",
    "ACK returned no kubeconfig",
  );
  if (response.body?.expiration !== undefined) {
    const expiresAt = DateTime.make(response.body.expiration);
    if (
      Option.isNone(expiresAt) ||
      DateTime.toEpochMillis(expiresAt.value) <=
        DateTime.toEpochMillis(yield* DateTime.now)
    ) {
      return yield* new AlibabaInvariantError({
        resourceType: "Alibaba.ACK.Kubeconfig",
        operation: "ValidateExpiration",
        message: "ACK returned expired or invalid kubeconfig credentials",
      });
    }
  }
  yield* decodeKubeconfig(config);
  return {
    config: Redacted.make(config),
    expiration: response.body?.expiration,
  };
});

const Kubeconfig = Schema.Struct({
  "current-context": Schema.String,
  clusters: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      cluster: Schema.Struct({
        server: Schema.String,
        "certificate-authority-data": Schema.String,
      }),
    }),
  ),
  contexts: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      context: Schema.Struct({ cluster: Schema.String, user: Schema.String }),
    }),
  ),
  users: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      user: Schema.Struct({
        token: Schema.optional(Schema.String),
        "client-certificate-data": Schema.optional(Schema.String),
        "client-key-data": Schema.optional(Schema.String),
      }),
    }),
  ),
});

const decodeKubeconfig = Effect.fn("ACK.decodeKubeconfig")(function* (
  raw: string,
) {
  const invalid = () =>
    new AlibabaInvariantError({
      resourceType: "Alibaba.ACK.Connection",
      operation: "ParseKubeconfig",
      message: "ACK returned an invalid or unsupported kubeconfig",
    });
  const parsed = yield* Effect.try({
    try: () => YAML.parse(raw),
    catch: invalid,
  });
  const config = yield* Schema.decodeUnknownEffect(Kubeconfig)(parsed).pipe(
    Effect.mapError(invalid),
  );
  const context = config.contexts.find(
    (item) => item.name === config["current-context"],
  )?.context;
  const cluster = config.clusters.find(
    (item) => item.name === context?.cluster,
  )?.cluster;
  const user = config.users.find((item) => item.name === context?.user)?.user;
  if (!cluster || !user || !cluster.server.startsWith("https://"))
    return yield* invalid();
  if (
    !user.token &&
    !(user["client-certificate-data"] && user["client-key-data"])
  )
    return yield* invalid();
  return { cluster, user };
});

/** Auth-only ACK adapter for the upstream Kubernetes resources. */
export const KubernetesAdapter = Layer.effect(
  ClusterAdapter("alibaba-ack"),
  Effect.gen(function* () {
    const clients = yield* AlibabaClients;
    return {
      kind: "Kubernetes.ClusterAdapter",
      connect: Effect.fn("ACK.KubernetesAdapter.connect")(function* (
        connection: Connection,
      ) {
        if (connection.auth.kind !== "alibaba-ack")
          return yield* new AlibabaInvariantError({
            resourceType: "Alibaba.ACK.Connection",
            operation: "Connect",
            message: "Expected alibaba-ack authentication",
          });
        const auth = connection.auth;
        const credentials = yield* getKubeconfig(auth.clusterId, auth).pipe(
          Effect.provideService(AlibabaClients, clients),
          Effect.catchIf(
            (error) =>
              error._tag === "AlibabaProviderError" && isNotFound(error),
            () =>
              Effect.fail(
                new ClusterNotFoundError({
                  message: "ACK cluster no longer exists",
                }),
              ),
          ),
        );
        const { cluster, user } = yield* decodeKubeconfig(
          Redacted.value(credentials.config),
        );
        const clientCert =
          user["client-certificate-data"] && user["client-key-data"]
            ? yield* Effect.sync(() => ({
                certificate: Buffer.from(
                  user["client-certificate-data"]!,
                  "base64",
                ).toString("utf8"),
                key: Buffer.from(user["client-key-data"]!, "base64").toString(
                  "utf8",
                ),
              }))
            : undefined;
        return {
          endpoint: connection.endpoint ?? cluster.server,
          certificateAuthorityData:
            connection.certificateAuthorityData ??
            cluster["certificate-authority-data"],
          headers: Effect.succeed<Record<string, string>>(
            user.token ? { Authorization: `Bearer ${user.token}` } : {},
          ),
          clientCert,
        };
      }),
    } satisfies ClusterAdapterService;
  }),
);
