import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { Effect, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildGrantStatements,
  buildVerificationQueries,
  interpretVerification,
} from "./grants.ts";
import { Postgres, postgresLayer } from "./sql-runner.ts";

const externalUrl = process.env["RDS_ACCESS_TEST_PG_URL"];
const startDocker = process.env["RDS_ACCESS_TEST_PG_DOCKER"] === "1";
const dockerAvailable = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const enabled = externalUrl !== undefined || (startDocker && dockerAvailable);
const skipReason =
  externalUrl !== undefined
    ? ""
    : "set RDS_ACCESS_TEST_PG_URL or RDS_ACCESS_TEST_PG_DOCKER=1 with Docker to run";
if (!enabled) {
  // eslint-disable-next-line no-console -- visible in check output
  console.log(`PostgreSQL integration skipped: ${skipReason}`);
}

const account = { name: "gateway_ro", password: `T3st-${randomBytes(8).toString("hex")}` };
const options = {
  database: "postgres",
  account: account.name,
  schemas: ["public", "shop"],
  ownerRoles: ["postgres"],
};

interface Target {
  readonly adminUrl: Redacted.Redacted<string>;
  readonly accountUrl: Redacted.Redacted<string>;
  readonly stop: () => Promise<void>;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });

const waitForPostgres = async (url: string): Promise<void> => {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
    try {
      await client.connect();
      await client.end();
      return;
    } catch (cause) {
      await client.end().catch(() => undefined);
      if (Date.now() > deadline) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
};

const startTarget = async (): Promise<Target> => {
  if (externalUrl !== undefined) {
    const parsed = new URL(externalUrl);
    return {
      adminUrl: Redacted.make(externalUrl),
      accountUrl: Redacted.make(
        `postgres://${account.name}:${encodeURIComponent(account.password)}@${parsed.hostname}:${parsed.port}/${parsed.pathname.slice(1)}`,
      ),
      stop: async () => undefined,
    };
  }
  if (!dockerAvailable) {
    throw new Error("Docker is not available; set RDS_ACCESS_TEST_PG_URL instead");
  }
  const port = await freePort();
  const container = `rds-access-pg-${randomBytes(4).toString("hex")}`;
  const adminUrl = `postgres://postgres:${encodeURIComponent(account.password)}@127.0.0.1:${port}/postgres`;
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-d",
      "--name",
      container,
      "-e",
      `POSTGRES_PASSWORD=${account.password}`,
      "-p",
      `127.0.0.1:${port}:5432`,
      "postgres:17.6",
    ],
    { stdio: "ignore" },
  );
  await waitForPostgres(adminUrl);
  return {
    adminUrl: Redacted.make(adminUrl),
    accountUrl: Redacted.make(
      `postgres://${account.name}:${encodeURIComponent(account.password)}@127.0.0.1:${port}/postgres`,
    ),
    stop: async () => {
      execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    },
  };
};

describe.runIf(enabled)("PostgreSQL integration", () => {
  let target: Target;
  const layer = postgresLayer();

  beforeAll(async () => {
    target = await startTarget();
  }, 120_000);

  afterAll(async () => {
    await target?.stop();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Postgres>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));

  const runStatements = (url: Redacted.Redacted<string>, statements: ReadonlyArray<string>) =>
    run(
      Effect.gen(function* () {
        const postgres = yield* Postgres;
        return yield* postgres.run(url, statements);
      }),
    );

  const setup = () =>
    runStatements(target.adminUrl, [
      `DROP TABLE IF EXISTS shop.future_items`,
      `DROP TABLE IF EXISTS public.assignments`,
      `DROP TABLE IF EXISTS shop.customers`,
      `DROP ROLE IF EXISTS ${account.name}`,
      `DROP SCHEMA IF EXISTS shop CASCADE`,
      `CREATE SCHEMA shop`,
      `CREATE TABLE public.assignments (id integer PRIMARY KEY, label text)`,
      `CREATE TABLE shop.customers (id integer PRIMARY KEY, email text)`,
      `INSERT INTO public.assignments VALUES (1, 'one')`,
      `INSERT INTO shop.customers VALUES (1, 'one@example.test')`,
      `CREATE ROLE ${account.name} LOGIN PASSWORD '${account.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    ]);

  const identity = () =>
    run(
      Effect.gen(function* () {
        const postgres = yield* Postgres;
        return yield* postgres.query(
          target.accountUrl,
          buildVerificationQueries(options).identity,
        );
      }),
    );

  it("runs the generated identity query and grants against a real server", async () => {
    await setup();
    await runStatements(
      target.adminUrl,
      buildGrantStatements(options).map((item) => item.statement),
    );
    const row = (await identity()).rows[0];
    expect(row).toMatchObject({
      database: "postgres",
      username: account.name,
      read_only: "on",
      schema_usage: true,
      schema_create: false,
      can_read_all: true,
      can_write_any: false,
    });
    const defaults = await run(
      Effect.gen(function* () {
        const postgres = yield* Postgres;
        return yield* postgres.query(
          target.accountUrl,
          buildVerificationQueries(options).defaultPrivileges!,
        );
      }),
    );
    expect(interpretVerification(options, [row!], defaults.rows)).toEqual({
      verified: true,
      issues: [],
    });
  }, 60_000);

  it("detects CREATE on one of several schemas", async () => {
    await runStatements(target.adminUrl, [
      `GRANT CREATE ON SCHEMA shop TO ${account.name}`,
    ]);
    const rows = (await identity()).rows;
    expect(rows[0]).toMatchObject({ schema_create: true });
    const verification = interpretVerification(options, rows);
    expect(verification.verified).toBe(false);
    expect(verification.issues.join(" ")).toContain("CREATE is still allowed");
  }, 60_000);

  it("detects the missing default privilege for a new owner/schema pair", async () => {
    const extra = {
      ...options,
      schemas: ["public", "shop", "other"],
    };
    await runStatements(target.adminUrl, [`CREATE SCHEMA IF NOT EXISTS other`]);
    const defaults = await run(
      Effect.gen(function* () {
        const postgres = yield* Postgres;
        return yield* postgres.query(
          target.accountUrl,
          buildVerificationQueries(extra).defaultPrivileges!,
        );
      }),
    );
    const verification = interpretVerification(extra, (await identity()).rows, defaults.rows);
    expect(verification.verified).toBe(false);
    expect(verification.issues.join(" ")).toContain(
      "default SELECT for future tables is missing for postgres in other",
    );
  }, 60_000);

  it("makes future tables readable through default privileges", async () => {
    await runStatements(target.adminUrl, [
      `CREATE TABLE shop.future_items (id integer PRIMARY KEY, label text)`,
      `INSERT INTO shop.future_items VALUES (1, 'future')`,
    ]);
    const result = await run(
      Effect.gen(function* () {
        const postgres = yield* Postgres;
        return yield* postgres.query(
          target.accountUrl,
          "SELECT label FROM shop.future_items ORDER BY id",
        );
      }),
    );
    expect(result.rows).toEqual([{ label: "future" }]);
  }, 60_000);
});
