import ACKClient, * as ACK from "@alicloud/cs20151215";
import { ClusterAdapter } from "alchemy/Kubernetes/ClusterAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clusterConnection,
  getKubeconfig,
  KubernetesAdapter,
} from "../ack/kubeconfig.ts";
import { AlibabaClients } from "../clients.ts";
import { withTempDir } from "../protocol/harness.ts";
import { installLoopbackGuard } from "../protocol/loopback-guard.ts";
import {
  alchemyTestRuntime,
  resourceBase,
  testClientSet,
  testConfig,
} from "../test-support.ts";
import { Secret, SecretProvider, type SecretProps } from "./secret.ts";

class Credentials extends ACKClient {
  requests: ACK.DescribeClusterUserKubeconfigRequest[] = [];
  config = "invalid";
  expiration = "2099-01-01T00:00:00Z";
  missing = false;
  override async describeClusterUserKubeconfig(
    _clusterId: string,
    request: ACK.DescribeClusterUserKubeconfigRequest,
  ) {
    this.requests.push(request);
    if (this.missing)
      throw Object.assign(new Error("absent"), {
        code: "NotFound",
        statusCode: 404,
      });
    return new ACK.DescribeClusterUserKubeconfigResponse({
      body: new ACK.DescribeClusterUserKubeconfigResponseBody({
        config: this.config,
        expiration: this.expiration,
      }),
    });
  }
}

const config = (server: string, ca: string, user: Record<string, string>) =>
  JSON.stringify({
    "current-context": "test",
    clusters: [
      { name: "test", cluster: { server, "certificate-authority-data": ca } },
    ],
    contexts: [{ name: "test", context: { cluster: "test", user: "test" } }],
    users: [{ name: "test", user }],
  });
const clientLayer = (fake: Credentials) =>
  Layer.succeed(AlibabaClients, testClientSet({ ack: fake }));

describe("ACK Kubernetes integration", () => {
  it("fetches fresh redacted credentials per connection and selects private endpoints by default", async () => {
    const fake = new Credentials(testConfig());
    const run = Effect.gen(function* () {
      const adapter = yield* ClusterAdapter("alibaba-ack");
      fake.config = config("https://127.0.0.1", "Y2E=", {
        token: "first-token",
      });
      const first = yield* adapter.connect(clusterConnection("cluster"));
      expect(yield* first.headers).toEqual({
        Authorization: "Bearer first-token",
      });
      fake.config = config("https://127.0.0.1", "Y2E=", {
        "client-certificate-data":
          Buffer.from("test-certificate").toString("base64"),
        "client-key-data": Buffer.from("test-private-key").toString("base64"),
      });
      const second = yield* adapter.connect(
        clusterConnection("cluster", {
          privateIpAddress: false,
          temporaryDurationMinutes: 30,
        }),
      );
      expect(second.clientCert).toEqual({
        certificate: "test-certificate",
        key: "test-private-key",
      });
      expect(yield* second.headers).toEqual({});
      expect(JSON.stringify(clusterConnection("cluster"))).not.toContain("key");
      const value = yield* getKubeconfig("cluster");
      expect(Redacted.isRedacted(value.config)).toBe(true);
      expect(JSON.stringify(value)).not.toContain("test-private-key");
    });
    await Effect.runPromise(
      run.pipe(
        Effect.provide(
          KubernetesAdapter.pipe(Layer.provideMerge(clientLayer(fake))),
        ),
      ),
    );
    expect(
      fake.requests.map((r) => [
        r.privateIpAddress,
        r.temporaryDurationMinutes,
      ]),
    ).toEqual([
      [true, 180],
      [false, 30],
      [true, 180],
    ]);
  });

  it("rejects expired and malformed kubeconfigs without echoing credentials, and distinguishes a gone cluster", async () => {
    const fake = new Credentials(testConfig());
    const layer = KubernetesAdapter.pipe(Layer.provideMerge(clientLayer(fake)));
    const connect = Effect.gen(function* () {
      return yield* (yield* ClusterAdapter("alibaba-ack")).connect(
        clusterConnection("cluster"),
      );
    });
    fake.config = "private-key: [super-secret-invalid-yaml";
    await expect(
      Effect.runPromise(connect.pipe(Effect.provide(layer))),
    ).rejects.toMatchObject({
      operation: "ParseKubeconfig",
      message: "ACK returned an invalid or unsupported kubeconfig",
    });
    await expect(
      Effect.runPromise(
        getKubeconfig("cluster").pipe(Effect.provide(clientLayer(fake))),
      ),
    ).rejects.toMatchObject({ operation: "ParseKubeconfig" });
    fake.expiration = "2000-01-01T00:00:00Z";
    await expect(
      Effect.runPromise(connect.pipe(Effect.provide(layer))),
    ).rejects.toMatchObject({ operation: "ValidateExpiration" });
    fake.missing = true;
    await expect(
      Effect.runPromise(connect.pipe(Effect.provide(layer))),
    ).rejects.toMatchObject({ _tag: "Kubernetes.ClusterNotFoundError" });
    const calls = fake.requests.length;
    await expect(
      Effect.runPromise(
        getKubeconfig("cluster", { temporaryDurationMinutes: 1 }).pipe(
          Effect.provide(clientLayer(fake)),
        ),
      ),
    ).rejects.toMatchObject({ operation: "Validate" });
    expect(fake.requests).toHaveLength(calls);
  });

  it("uses upstream server-side apply for Secret creation, rotation, read and deletion with sanitized failures", async () => {
    await withTempDir(async (directory) => {
      const keyPath = join(directory, "key.pem"),
        certPath = join(directory, "cert.pem");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
        ],
        { stdio: "ignore" },
      );
      const guard = installLoopbackGuard();
      const calls: {
        method: string;
        path: string;
        data?: Record<string, string>;
      }[] = [];
      let current: Record<string, unknown> | undefined;
      let rejectApply = false;
      const server = createServer(
        { key: readFileSync(keyPath), cert: readFileSync(certPath) },
        async (request, response) => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks).toString();
          const parsed = body ? JSON.parse(body) : undefined;
          calls.push({
            method: request.method!,
            path: request.url!,
            data: parsed?.data,
          });
          response.setHeader("Content-Type", "application/json");
          if (request.headers.authorization !== "Bearer test-token") {
            response.writeHead(401).end("{}");
            return;
          }
          if (rejectApply && request.method === "PATCH") {
            response.writeHead(422).end(body);
            return;
          }
          if (request.method === "PATCH")
            current = {
              ...parsed,
              metadata: { ...parsed.metadata, uid: "test-uid" },
            };
          if (request.method === "DELETE") {
            current = undefined;
            response.end("{}");
            return;
          }
          if (!current) {
            response.writeHead(404).end("{}");
            return;
          }
          response.end(JSON.stringify(current));
        },
      );
      try {
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("No local address");
        const fake = new Credentials(testConfig());
        fake.config = config(
          `https://127.0.0.1:${address.port}`,
          readFileSync(certPath).toString("base64"),
          { token: "test-token" },
        );
        const layer = Layer.mergeAll(SecretProvider(), KubernetesAdapter).pipe(
          Layer.provide(clientLayer(fake)),
        );
        const props = (value: string): SecretProps => ({
          cluster: clusterConnection("cluster"),
          name: "runtime",
          namespace: "test",
          data: { PASSWORD: Redacted.make(value) },
        });
        const base = resourceBase("secret");
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const provider = yield* Secret.Provider;
            const first = yield* provider.reconcile({
              ...base,
              news: props("initial-secret"),
              olds: undefined,
              output: undefined,
            });
            const second = yield* provider.reconcile({
              ...base,
              news: props("rotated-secret"),
              olds: props("initial-secret"),
              output: first,
            });
            expect(second.uid).toBe(first.uid);
            expect(
              yield* provider.read!({
                ...base,
                olds: props("rotated-secret"),
                output: second,
              }),
            ).toEqual(second);
            expect(
              yield* provider.diff!({
                ...base,
                oldBindings: [],
                newBindings: [],
                olds: props("initial-secret"),
                news: { ...props("initial-secret"), name: "renamed" },
                output: first,
              }),
            ).toEqual({ action: "replace" });
            rejectApply = true;
            const failure = yield* provider
              .reconcile({
                ...base,
                news: props("failed-secret"),
                olds: props("rotated-secret"),
                output: second,
              })
              .pipe(Effect.flip);
            expect(JSON.stringify(failure)).not.toContain(
              Buffer.from("failed-secret").toString("base64"),
            );
            expect(failure.operation).toBe("apply");
            rejectApply = false;
            yield* provider.delete({
              ...base,
              olds: props("rotated-secret"),
              output: second,
            });
            expect(
              yield* provider.read!({
                ...base,
                olds: props("rotated-secret"),
                output: second,
              }),
            ).toBeUndefined();
            return second;
          }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
        );
        expect(JSON.stringify(result)).not.toContain("secret");
        expect(
          calls
            .filter((call) => call.method === "PATCH")
            .map((call) => call.data?.PASSWORD),
        ).toEqual(
          ["initial-secret", "rotated-secret", "failed-secret"].map((value) =>
            Buffer.from(value).toString("base64"),
          ),
        );
        expect(calls[0]?.path).toContain(
          "/api/v1/namespaces/test/secrets/runtime?fieldManager=alchemy",
        );
        expect(guard.escaped()).toBe(0);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        guard.uninstall();
      }
    });
  });
});
