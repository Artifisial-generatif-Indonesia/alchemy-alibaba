import { NodeServices } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it, vi } from "vitest";
import { RdsApi, type rdsApiLayer } from "./alibaba.ts";
import { makeCommand } from "./cli.ts";

const env = {
  ALIBABA_CLOUD_REGION: "ap-southeast-5",
  ALIBABA_CLOUD_PROFILE: "development",
  RDS_ACCESS_INSTANCE_ID: "pgm-example",
  RDS_ACCESS_DEVELOPER: "alice@example.com",
};
const flags = [
  "--instance",
  "pgm-other",
  "--region",
  "cn-hangzhou",
  "--developer",
  "bob@example.com",
  "--profile",
  "other",
];

function harness(environment: Record<string, string> = env) {
  const verify = vi.fn<RdsApi["Service"]["verifyInstance"]>(() => Effect.void);
  const createLayer = vi.fn<typeof rdsApiLayer>(() =>
    Layer.succeed(RdsApi, {
      verifyInstance: verify,
      groups: () => Effect.succeed([]),
      setGroup: () => Effect.die("Unexpected write"),
    }),
  );
  const detect = vi.fn(
    (request: import("effect/unstable/http/HttpClientRequest").HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response('{"ip":"203.0.113.20"}', {
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
  );
  const command = makeCommand(createLayer);
  const run = (args: string[]) =>
    Effect.runPromise(
      Command.runWith(command, { version: "0.1.0", renderErrors: false })(args).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(environment),
        ),
        Effect.provideService(HttpClient.HttpClient, HttpClient.make(detect)),
      ),
    );
  return { run, createLayer, verify, detect };
}

describe("CLI configuration", () => {
  it("loads project settings and named profile from the environment", async () => {
    const h = harness();
    await h.run(["plan", "--ip", "203.0.113.10", "--json"]);
    expect(h.createLayer).toHaveBeenCalledWith({
      regionId: env.ALIBABA_CLOUD_REGION,
      profile: "development",
    });
    expect(h.verify).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "pgm-example", developer: "alice@example.com" }),
    );
    expect(h.detect).not.toHaveBeenCalled();
  });

  it("lets flags override environment settings", async () => {
    const h = harness();
    await h.run(["plan", ...flags, "--ip", "203.0.113.10", "--json"]);
    expect(h.createLayer).toHaveBeenCalledWith({ regionId: "cn-hangzhou", profile: "other" });
    expect(h.verify).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "pgm-other", developer: "bob@example.com" }),
    );
  });

  it("uses the default credential chain when a profile is not selected", async () => {
    const { ALIBABA_CLOUD_PROFILE: _, ...environment } = env;
    const h = harness(environment);
    await h.run(["plan", "--ip", "203.0.113.10", "--json"]);
    expect(h.createLayer).toHaveBeenCalledWith({
      regionId: env.ALIBABA_CLOUD_REGION,
      profile: undefined,
    });
  });

  it("automatically detects IPs, but revoke does not need an IP lookup", async () => {
    const h = harness();
    await h.run(["plan", "--json"]);
    expect(h.detect).toHaveBeenCalledTimes(1);
    await h.run(["revoke", "--json"]);
    expect(h.detect).toHaveBeenCalledTimes(1);
  });

  it("requires a developer identity before contacting Alibaba", async () => {
    const { RDS_ACCESS_DEVELOPER: _, ...environment } = env;
    const h = harness(environment);
    await expect(h.run(["refresh", "--ip", "203.0.113.10"])).rejects.toThrow();
    expect(h.createLayer).not.toHaveBeenCalled();
    expect(h.detect).not.toHaveBeenCalled();
  });

  it("rejects a broad IP and conflicting plan options without network calls", async () => {
    const h = harness();
    await expect(h.run(["refresh", "--ip", "0.0.0.0/0"])).rejects.toThrow();
    await expect(h.run(["plan", "--revoke", "--ip", "203.0.113.10"])).rejects.toThrow(
      "Use --revoke or --ip",
    );
    expect(h.createLayer).not.toHaveBeenCalled();
    expect(h.detect).not.toHaveBeenCalled();
  });
});
