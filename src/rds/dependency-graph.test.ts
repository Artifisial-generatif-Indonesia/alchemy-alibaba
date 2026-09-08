import * as Output from "alchemy/Output";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { Account } from "./account.ts";
import { Database } from "./database.ts";
import { Providers } from "../providers.ts";

describe("RDS dependency graph", () => {
  it("creates accounts before the database so destroy removes the database first", async () => {
    const stack = {
      name: "rds-dependency-test",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    };
    const program = Effect.gen(function* () {
      const migration = yield* Account("Migration", {
        instanceId: "rm-test",
        name: "example_migration",
        password: Redacted.make("MigrationPassword1!"),
      });
      const application = yield* Account("Application", {
        instanceId: "rm-test",
        name: "example_app",
        password: Redacted.make("ApplicationPassword1!"),
      });
      const database = yield* Database("Database", {
        instanceId: "rm-test",
        accountNames: [migration.name, application.name],
        name: "example",
        characterSetName: "UTF8,C,en_US.utf8",
      });
      return { application, database, migration };
    });

    const resources = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Stack, stack),
            Layer.succeed(Providers, {
              kind: "ProviderCollection",
              get: () => undefined,
              providers: {},
            }),
          ),
        ),
      ),
    );
    const databaseUpstreams = Object.values(
      Output.upstreamAny(resources.database.Props),
    );
    const migrationUpstreams = Object.values(
      Output.upstreamAny(resources.migration.Props),
    );
    const applicationUpstreams = Object.values(
      Output.upstreamAny(resources.application.Props),
    );

    expect(databaseUpstreams).toEqual(
      expect.arrayContaining([resources.migration, resources.application]),
    );
    expect(migrationUpstreams).not.toContain(resources.database);
    expect(applicationUpstreams).not.toContain(resources.database);
  });
});
