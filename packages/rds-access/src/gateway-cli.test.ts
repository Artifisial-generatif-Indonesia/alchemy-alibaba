import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { ConfigProvider, Console, Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { HttpClient } from "effect/unstable/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Group } from "./model.ts";
import { makeCommand } from "./cli.ts";
import { GatewayApi, type GatewaySdk } from "./gateway/alibaba.ts";
import type { PeerConnectionInfo, RouteEntryInfo } from "./gateway/model.ts";
import { Postgres, type PostgresQueryResult } from "./gateway/sql-runner.ts";

const directories: string[] = [];
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), "rds-access-cli-"));
  directories.push(path);
  return path;
};
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const peering: PeerConnectionInfo = {
  peeringId: "pcc-odin",
  name: "gateway-odin",
  status: "Activated",
  requesterVpcId: "vpc-gw",
  acceptingVpcId: "vpc-rds",
  acceptingRegionId: "ap-southeast-5",
  acceptingOwnerUid: 1,
  requesterCidrs: ["10.20.0.0/16"],
  acceptingCidrs: ["172.30.192.0/20"],
};
const route = (destinationCidrBlock: string): RouteEntryInfo => ({
  routeEntryId: "rte-1",
  destinationCidrBlock,
  nextHopId: "pcc-odin",
  nextHopType: "VpcPeer",
  status: "Available",
});
const group = (name: string, ip: string): Group => ({
  DBInstanceIPArrayName: name,
  securityIPList: ip,
  securityIPType: "IPv4",
  whitelistNetworkType: "MIX",
});

function harness() {
  const gatewayFactory = vi.fn((_options: { regionId: string; profile?: string; sdk?: GatewaySdk }) =>
    Layer.succeed(GatewayApi, {
      instance: () =>
        Effect.succeed({
          instanceId: "pgm-example",
          regionId: "ap-southeast-5",
          engine: "PostgreSQL",
          engineVersion: "18.0",
          vpcId: "vpc-rds",
          vSwitchId: "vsw-rds",
          endpoint: {
            host: "pgm-example.pgsql.ap-southeast-5.rds.aliyuncs.com",
            port: 5432,
            ipAddress: "172.30.192.10",
          },
          databases: ["odin"],
          accounts: [{ name: "gateway_ro", type: "Normal" }],
        }),
      groups: () => Effect.succeed({ all: [group("gateway", "10.20.1.151")], network: [group("gateway", "10.20.1.151")] }),
      topology: () =>
        Effect.succeed({
          instance: {
            instanceId: "i-gateway",
            privateIp: "10.20.1.151",
            vpcId: "vpc-gw",
            vSwitchId: "vsw-gw",
            status: "Running",
          },
          vpc: { vpcId: "vpc-gw", cidrBlock: "10.20.0.0/16", regionId: "ap-southeast-5", ownerId: 1 },
          vSwitch: { vSwitchId: "vsw-gw", vpcId: "vpc-gw", routeTableId: "vtb-gw" },
        }),
      vpc: (vpcId) =>
        Effect.succeed({
          vpcId,
          cidrBlock: "172.30.192.0/20",
          regionId: "ap-southeast-5",
          ownerId: 1,
        }),
      vSwitch: (vSwitchId) =>
        Effect.succeed({ vSwitchId, vpcId: "vpc-rds", routeTableId: "vtb-rds" }),
      peerings: () => Effect.succeed([peering]),
      routes: (routeTableId) =>
        Effect.succeed(routeTableId === "vtb-gw" ? [route("172.30.192.0/20")] : [route("10.20.0.0/16")]),
      createPeering: () => Effect.die("Unexpected createPeering"),
      acceptPeering: () => Effect.die("Unexpected acceptPeering"),
      createRoute: () => Effect.die("Unexpected createRoute"),
      setWhitelistGroup: () => Effect.die("Unexpected setWhitelistGroup"),
      createAccount: () => Effect.die("Unexpected createAccount"),
    }),
  );
  const postgresFactory = vi.fn(() =>
    Layer.succeed(Postgres, {
      query: (_url, sql) =>
        Effect.succeed({
          rows: [sql.includes("pg_default_acl") ? { granted: true } : {
            database: "odin",
            username: "gateway_ro",
            read_only: "on",
            schema_usage: true,
            schema_create: false,
            can_read_all: true,
            can_write_any: false,
          }],
          rowCount: 1,
        } satisfies PostgresQueryResult),
      run: () => Effect.die("Unexpected run"),
    }),
  );
  const command = makeCommand({ gateway: gatewayFactory, postgres: postgresFactory });
  const lines: string[] = [];
  const testConsole = Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => lines.push(args.join(" ")),
  });
  const run = (args: string[], environment: Record<string, string> = {}) =>
    Effect.runPromise(
      Command.runWith(command, { version: "0.1.0", renderErrors: false })(args).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(environment)),
        Effect.provideService(Console.Console, testConsole),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected HTTP request")),
        ),
      ),
    );
  return { run, lines, gatewayFactory, postgresFactory };
}

describe("gateway CLI", () => {
  it("plans with flags and environment fallbacks", async () => {
    const h = harness();
    await h.run(
      [
        "gateway",
        "plan",
        "--instance",
        "pgm-example",
        "--database",
        "odin",
        "--name",
        "Odin staging",
        "--owner-role",
        "odin_app",
        "--json",
      ],
      { ALIBABA_CLOUD_REGION: "ap-southeast-5", ALIBABA_CLOUD_PROFILE: "development" },
    );
    expect(h.gatewayFactory).toHaveBeenCalledWith({
      regionId: "ap-southeast-5",
      profile: "development",
    });
    expect(h.postgresFactory).toHaveBeenCalledTimes(1);
    const plan = JSON.parse(h.lines[0]!);
    expect(plan).toMatchObject({
      instanceId: "pgm-example",
      alias: "odin_staging",
      endpoint: { host: "pgm-example.pgsql.ap-southeast-5.rds.aliyuncs.com", database: "odin" },
    });
  });

  it("requires an account password file for apply", async () => {
    const h = harness();
    await expect(
      h.run(
        [
          "gateway",
          "apply",
        "--instance",
        "pgm-example",
        "--database",
        "odin",
        "--name",
          "Odin staging",
        ],
        { ALIBABA_CLOUD_REGION: "ap-southeast-5" },
      ),
    ).rejects.toThrow("--account-password-file");
  });

  it("generates a password file with mode 0600 and never prints the secret", async () => {
    const h = harness();
    const secretPath = join(await directory(), "secrets", "odin.password");
    await h.run(
      [
        "gateway",
        "apply",
        "--instance",
        "pgm-example",
        "--database",
        "odin",
        "--name",
        "Odin staging",
        "--account-password-file",
        secretPath,
        "--json",
      ],
      { ALIBABA_CLOUD_REGION: "ap-southeast-5" },
    );
    const password = (await readFile(secretPath, "utf8")).trim();
    expect(password.length).toBeGreaterThanOrEqual(16);
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    expect(h.lines.join("\n")).not.toContain(password);
  });

  it("uses an existing account password file without regenerating it", async () => {
    const h = harness();
    const path = join(await directory(), "existing.password");
    await writeFile(path, "existing-password\n");
    await chmod(path, 0o600);
    await h.run(
      [
        "gateway",
        "apply",
        "--instance",
        "pgm-example",
        "--database",
        "odin",
        "--name",
        "Odin staging",
        "--account-password-file",
        path,
      ],
      { ALIBABA_CLOUD_REGION: "ap-southeast-5" },
    );
    expect((await readFile(path, "utf8")).trim()).toBe("existing-password");
  });
});
