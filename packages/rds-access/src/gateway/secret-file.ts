import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Option, Predicate, Redacted } from "effect";
import { AccessError } from "../model.ts";

const failure = (path: string, action: string, code?: string) =>
  new AccessError({
    ...(code === undefined ? {} : { code }),
    message:
      `Could not ${action} secret file ${path}. ` +
      "Secrets are only read from 0600 files; they are never accepted as command-line arguments.",
  });

const errorCode = (cause: unknown): string | undefined => {
  if (Predicate.isObject(cause) && "code" in cause && typeof cause.code === "string") {
    return cause.code;
  }
  return undefined;
};

/** Reads a password file, returning none when it does not exist. */
export const readPasswordFile = (
  path: string,
): Effect.Effect<Option.Option<Redacted.Redacted<string>>, AccessError> =>
  Effect.gen(function* () {
    if (process.platform !== "win32") {
      const insecure = yield* Effect.tryPromise({
        try: async () => {
          try {
            const info = await stat(path);
            return (info.mode & 0o077) !== 0;
          } catch (cause) {
            if (errorCode(cause) === "ENOENT") return false;
            throw cause;
          }
        },
        catch: (cause) => failure(path, "inspect", errorCode(cause)),
      });
      if (insecure) {
        return yield* Effect.fail(
          new AccessError({
            message:
              `Secret file ${path} is readable by other users. ` +
              "Run chmod 600 on it; secrets must stay private to this account.",
          }),
        );
      }
    }
    const value = yield* Effect.tryPromise({
      try: async () => {
        try {
          const content = await readFile(path, "utf8");
          const trimmed = content.trim();
          return trimmed.length === 0 ? undefined : trimmed;
        } catch (cause) {
          if (errorCode(cause) === "ENOENT") return undefined;
          throw cause;
        }
      },
      catch: (cause) => failure(path, "read", errorCode(cause)),
    });
    return Option.fromUndefinedOr(value).pipe(Option.map(Redacted.make));
  });

export const writePasswordFile = (
  path: string,
  password: Redacted.Redacted<string>,
): Effect.Effect<void, AccessError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(path), { recursive: true, mode: 0o700 }),
      catch: (cause) => failure(path, "create the directory for", errorCode(cause)),
    });
    yield* Effect.tryPromise({
      try: () => writeFile(path, `${Redacted.value(password)}\n`, { mode: 0o600, flag: "wx" }),
      catch: (cause) => failure(path, "write", errorCode(cause)),
    });
    yield* Effect.tryPromise({
      try: () => chmod(path, 0o600),
      catch: (cause) => failure(path, "restrict", errorCode(cause)),
    });
  });

/** Reads an existing password or writes a newly generated one (0600, no overwrite). */
export const ensurePasswordFile = (
  path: string,
  generate: () => string,
): Effect.Effect<Redacted.Redacted<string>, AccessError> =>
  Effect.gen(function* () {
    const existing = yield* readPasswordFile(path);
    if (Option.isSome(existing)) return existing.value;
    const password = Redacted.make(generate());
    const created = yield* writePasswordFile(path, password).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.code === "EEXIST",
        () => Effect.succeed(false),
      ),
    );
    if (created) return password;
    // Another process created it first; use theirs.
    const afterRace = yield* readPasswordFile(path);
    if (Option.isSome(afterRace)) return afterRace.value;
    return yield* Effect.fail(failure(path, "read"));
  });
