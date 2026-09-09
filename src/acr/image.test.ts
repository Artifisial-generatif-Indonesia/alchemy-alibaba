import ACRClient, * as ACR from "@alicloud/cr20181201";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import {
  Artifacts,
  makeScopedArtifacts,
  createArtifactStore,
} from "alchemy/Artifacts";
import { Docker } from "alchemy/Docker/Docker";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AlibabaClients } from "../clients.ts";
import { withTempDir } from "../protocol/harness.ts";
import {
  alchemyTestRuntime,
  resourceBase,
  testClientSet,
  testConfig,
} from "../test-support.ts";
import { Image, ImageProvider } from "./image.ts";

class Registry extends ACRClient {
  tokens = 0;
  digest = `sha256:${"a".repeat(64)}`;
  override async getAuthorizationToken() {
    this.tokens++;
    return new ACR.GetAuthorizationTokenResponse({
      body: new ACR.GetAuthorizationTokenResponseBody({
        isSuccess: true,
        tempUsername: "temporary-user",
        authorizationToken: "fake-registry-secret",
      }),
    });
  }
  override async getRepoTag() {
    return new ACR.GetRepoTagResponse({
      body: new ACR.GetRepoTagResponseBody({
        isSuccess: true,
        digest: this.digest,
      }),
    });
  }
}

it("delegates builds and pushes to upstream Docker and returns the observed immutable ACR digest", async () => {
  await withTempDir(async (directory) => {
    await writeFile(join(directory, "Dockerfile"), "FROM scratch\n");
    const registry = new Registry(testConfig());
    const calls: string[] = [];
    const image = {
      build: () =>
        Effect.sync(() => {
          calls.push("build");
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      inspect: () =>
        Effect.succeed({
          Id: "local-image-id",
          Created: "2026-01-01T00:00:00Z",
        }),
      push: (
        _ref: string,
        credentials: { password: Redacted.Redacted<string> },
      ) =>
        Effect.sync(() => {
          expect(Redacted.isRedacted(credentials.password)).toBe(true);
          expect(Redacted.value(credentials.password)).toBe(
            "fake-registry-secret",
          );
          calls.push("push");
          return { stdout: "pushed", stderr: "", exitCode: 0 };
        }),
      remove: () =>
        Effect.sync(() => {
          calls.push("remove");
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
    };
    // Any unexpected Docker operation fails; there is no daemon or command fallback.
    const docker = new Proxy(
      { image },
      {
        get(target, name) {
          if (name === "image") return target.image;
          throw new Error(`Unexpected Docker operation ${String(name)}`);
        },
      },
    ) as unknown as Docker["Service"];
    const dependencies = Layer.mergeAll(
      NodeFileSystem.layer,
      NodePath.layer,
      Layer.succeed(Docker, docker),
      Layer.succeed(AlibabaClients, testClientSet({ acr: registry })),
    );
    const props = {
      instanceId: "registry-test",
      repositoryId: "repo-test",
      repositoryUri: "registry.example/test/api",
      tag: "release-1",
      build: { context: directory },
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Image.Provider;
        const output = yield* provider.reconcile({
          ...resourceBase("image"),
          news: props,
          olds: undefined,
          output: undefined,
        });
        expect(
          yield* provider.read!({
            ...resourceBase("image"),
            olds: props,
            output,
          }),
        ).toEqual(output);
        yield* provider.delete({
          ...resourceBase("image"),
          olds: props,
          output,
        });
        return output;
      }).pipe(
        Effect.provide(
          ImageProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
            Layer.provide(dependencies),
          ),
        ),
        Effect.provide(alchemyTestRuntime),
        Effect.provideService(
          Artifacts,
          makeScopedArtifacts(createArtifactStore(), "image"),
        ),
      ),
    );
    expect(result.imageUri).toBe(
      `registry.example/test/api@${registry.digest}`,
    );
    expect(calls).toEqual(["build", "push", "remove"]);
    expect(registry.tokens).toBe(1);
    expect(JSON.stringify(result)).not.toContain("fake-registry-secret");
  });
});
