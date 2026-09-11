import { Effect, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import { Postgres, postgresLayer, type PostgresClient } from "./sql-runner.ts";

const url = Redacted.make("postgres://gateway_ro:top-secret@host:5432/odin");

function harness(query: PostgresClient["query"]) {
  const close = vi.fn(async () => undefined);
  const client: PostgresClient = { query, close };
  const layer = postgresLayer({ connect: () => Effect.succeed(client) });
  const run = <A, E>(effect: Effect.Effect<A, E, Postgres>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  return { client, close, run };
}

describe("postgres runner", () => {
  it("runs statements in order and closes the client", async () => {
    const statements: string[] = [];
    const h = harness(async (sql) => {
      statements.push(sql);
      return { rows: [{ ok: true }], rowCount: 1 };
    });
    const results = await h.run(
      Effect.gen(function* () {
        const postgres = yield* Postgres;
        return yield* postgres.run(url, ["GRANT SELECT", "ALTER DEFAULT PRIVILEGES"]);
      }),
    );
    expect(statements).toEqual(["GRANT SELECT", "ALTER DEFAULT PRIVILEGES"]);
    expect(results).toHaveLength(2);
    expect(results[0]!.rows).toEqual([{ ok: true }]);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("redacts the connection secret from failures", async () => {
    const h = harness(async () => {
      throw new Error("password authentication failed for user top-secret");
    });
    try {
      await h.run(
        Effect.gen(function* () {
          const postgres = yield* Postgres;
          return yield* postgres.query(url, "select 1");
        }),
      );
      expect.fail("Expected failure");
    } catch (error) {
      expect(String(error)).toContain("[redacted]");
      expect(String(error)).not.toContain("top-secret");
    }
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("normalizes non-object rows", async () => {
    const h = harness(async () => ({ rows: [42], rowCount: 1 }));
    const result = await h.run(
      Effect.gen(function* () {
        const postgres = yield* Postgres;
        return yield* postgres.query(url, "select 42");
      }),
    );
    expect(result.rows).toEqual([{ value: 42 }]);
  });
});
