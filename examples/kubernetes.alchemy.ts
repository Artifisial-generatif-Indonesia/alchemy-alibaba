import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Alibaba from "../src/index.ts";

// Compilation example. Supply persistent protected state before any real apply.
export default Alchemy.Stack(
  "ExampleAckWorkload",
  {
    providers: Layer.mergeAll(
      Alibaba.providersFromEnvironment(),
      Alibaba.Kubernetes.providers(),
    ),
    state: Alchemy.inMemoryState(),
  },
  Effect.gen(function* () {
    const clusterId = yield* Config.string("EXAMPLE_ACK_CLUSTER_ID");
    const namespaceName = yield* Config.string("EXAMPLE_KUBERNETES_NAMESPACE");
    const image = yield* Config.string("EXAMPLE_IMAGE_DIGEST_URI");
    const databaseUrl = yield* Config.string("EXAMPLE_DATABASE_URL").pipe(
      Config.map(Redacted.make),
    );
    const cluster = Alibaba.ACK.clusterConnection(clusterId);
    const namespace = yield* Alibaba.Kubernetes.Manifest("Namespace", {
      cluster,
      manifest: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: namespaceName },
      },
    });
    const secret = yield* Alibaba.Kubernetes.Secret("RuntimeSecret", {
      cluster,
      namespace: namespace.name,
      name: "runtime",
      data: { DATABASE_URL: databaseUrl },
    });
    const workload = yield* Alibaba.Kubernetes.Manifest("Api", {
      cluster,
      manifest: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "api", namespace: secret.namespace },
        spec: {
          selector: { matchLabels: { app: "api" } },
          template: {
            metadata: { labels: { app: "api" } },
            spec: {
              containers: [
                {
                  name: "api",
                  image,
                  envFrom: [{ secretRef: { name: secret.name } }],
                },
              ],
            },
          },
        },
      },
    });
    return { namespace: namespace.name, deployment: workload.name };
  }),
);
