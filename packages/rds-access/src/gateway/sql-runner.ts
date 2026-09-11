import { Client } from "pg";
import { Context, Effect, Layer, Predicate, Redacted } from "effect";
import { AccessError } from "../model.ts";

export interface PostgresQueryResult {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly rowCount: number;
}

/** Narrow client seam so tests can simulate PostgreSQL without a socket. */
export interface PostgresClient {
  readonly query: (sql: string) => Promise<{
    readonly rows: ReadonlyArray<unknown>;
    readonly rowCount: number | null;
  }>;
  /** Optional batch implementation; remote clients use it to avoid round trips. */
  readonly run?: (statements: ReadonlyArray<string>) => Promise<
    ReadonlyArray<{
      readonly rows: ReadonlyArray<unknown>;
      readonly rowCount: number | null;
    }>
  >;
  readonly close: () => Promise<void>;
}

export interface PostgresOptions {
  /** Overrides the real `pg.Client`; tests inject an in-memory client. */
  readonly connect?: (url: Redacted.Redacted<string>) => Effect.Effect<PostgresClient, AccessError>;
}

export const redactedValue = (value: Redacted.Redacted<string>): string => Redacted.value(value);

const redactableValues = (secret: string | undefined): ReadonlyArray<string> => {
  if (secret === undefined || secret.length === 0) return [];
  const values = [secret];
  try {
    const parsed = new URL(secret);
    if (parsed.password.length > 0) values.push(decodeURIComponent(parsed.password));
  } catch {
    // Not a URL; the raw secret is enough.
  }
  return values;
};

const sanitize = (message: string, secret: string | undefined): string =>
  redactableValues(secret).reduce(
    (current, value) => current.replaceAll(value, "[redacted]"),
    message,
  );

export const postgresError = (cause: unknown, secret: string | undefined): AccessError => {
  const code = Predicate.isObject(cause) ? cause["code"] : undefined;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new AccessError({
    operation: "PostgreSQL",
    ...(typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code) ? { code } : {}),
    message: `PostgreSQL request failed: ${sanitize(message, secret)}`,
  });
};

const realConnect = (url: Redacted.Redacted<string>): Effect.Effect<PostgresClient, AccessError> =>
  Effect.tryPromise({
    try: async () => {
      const client = new Client({
        connectionString: Redacted.value(url),
        connectionTimeoutMillis: 10_000,
        query_timeout: 30_000,
        statement_timeout: 30_000,
        application_name: "alibaba-rds-access",
      });
      await client.connect();
      return {
        query: (sql: string) =>
          client.query(sql).then((result) => ({
            rows: result.rows as ReadonlyArray<unknown>,
            rowCount: result.rowCount,
          })),
        close: () => client.end(),
      };
    },
    catch: (cause) => postgresError(cause, Redacted.value(url)),
  });

export class Postgres extends Context.Service<
  Postgres,
  {
    readonly query: (
      url: Redacted.Redacted<string>,
      sql: string,
    ) => Effect.Effect<PostgresQueryResult, AccessError>;
    readonly run: (
      url: Redacted.Redacted<string>,
      statements: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<PostgresQueryResult>, AccessError>;
  }
>()("alibaba-rds-access/Postgres") {}

const normalizeRow = (row: unknown): Record<string, unknown> =>
  Predicate.isObject(row) ? { ...row } : { value: row };

const normalizeResult = (result: {
  readonly rows: ReadonlyArray<unknown>;
  readonly rowCount: number | null;
}): PostgresQueryResult => ({
  rows: result.rows.map(normalizeRow),
  rowCount: result.rowCount ?? 0,
});

export const postgresLayer = (options: PostgresOptions = {}) => {
  const connect = options.connect ?? realConnect;
  const withClient = <A>(
    url: Redacted.Redacted<string>,
    use: (client: PostgresClient) => Effect.Effect<A, AccessError>,
  ) =>
    Effect.gen(function* () {
      const client = yield* connect(url);
      const release = Effect.promise(() => client.close().catch(() => undefined));
      return yield* use(client).pipe(Effect.ensuring(release));
    });

  return Layer.succeed(Postgres, {
    query: Effect.fn("Postgres.query")(function* (url, sql) {
      return yield* withClient(url, (client) =>
        Effect.tryPromise({
          try: async () => normalizeResult(await client.query(sql)),
          catch: (cause) => postgresError(cause, Redacted.value(url)),
        }),
      );
    }),
    run: Effect.fn("Postgres.run")(function* (url, statements) {
      return yield* withClient(url, (client) =>
        Effect.tryPromise({
          try: async () => {
            if (client.run !== undefined) {
              const results = await client.run(statements);
              return results.map(normalizeResult);
            }
            const results: PostgresQueryResult[] = [];
            for (const sql of statements) {
              results.push(normalizeResult(await client.query(sql)));
            }
            return results;
          },
          catch: (cause) => postgresError(cause, Redacted.value(url)),
        }),
      );
    }),
  });
};

/**
 * Promise-friendly layer factory. Remote runners (for example an appliance
 * reached through Cloud Assistant) can build a client without importing Effect.
 */
export const postgresLayerFromPromise = (options: {
  readonly connect: (url: Redacted.Redacted<string>) => Promise<PostgresClient>;
}): Layer.Layer<Postgres> =>
  postgresLayer({
    connect: (url) =>
      Effect.tryPromise({
        try: () => options.connect(url),
        catch: (cause) => postgresError(cause, Redacted.value(url)),
      }),
  });

export const redactedMake = (value: string): Redacted.Redacted<string> => Redacted.make(value);

/** Runs one query through a caller-supplied Postgres layer, without Effect. */
export const runPostgresQuery = (options: {
  readonly layer: Layer.Layer<Postgres>;
  readonly url: Redacted.Redacted<string>;
  readonly sql: string;
}): Promise<PostgresQueryResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const postgres = yield* Postgres;
      return yield* postgres.query(options.url, options.sql);
    }).pipe(Effect.provide(options.layer)),
  );

/** Runs a batch of statements through a caller-supplied Postgres layer, without Effect. */
export const runPostgresStatements = (options: {
  readonly layer: Layer.Layer<Postgres>;
  readonly url: Redacted.Redacted<string>;
  readonly statements: ReadonlyArray<string>;
}): Promise<ReadonlyArray<PostgresQueryResult>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const postgres = yield* Postgres;
      return yield* postgres.run(options.url, options.statements);
    }).pipe(Effect.provide(options.layer)),
  );
