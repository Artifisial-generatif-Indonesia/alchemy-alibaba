import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option, Redacted } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePasswordFile, readPasswordFile, writePasswordFile } from "./secret-file.ts";

const directories: string[] = [];

const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), "rds-access-secret-"));
  directories.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("secret files", () => {
  it("returns none for a missing file", async () => {
    const path = join(await directory(), "missing");
    const result = await Effect.runPromise(readPasswordFile(path));
    expect(Option.isNone(result)).toBe(true);
  });

  it("writes and reads a generated password with mode 0600", async () => {
    const path = join(await directory(), "nested", "account.password");
    let generated = 0;
    const first = await Effect.runPromise(
      ensurePasswordFile(path, () => {
        generated += 1;
        return "generated-password";
      }),
    );
    const second = await Effect.runPromise(
      ensurePasswordFile(path, () => {
        generated += 1;
        return "other-password";
      }),
    );
    expect(Redacted.value(first)).toBe("generated-password");
    expect(Redacted.value(second)).toBe("generated-password");
    expect(generated).toBe(1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readFile(path, "utf8")).trim()).toBe("generated-password");
  });

  it("never overwrites an existing password file", async () => {
    const path = join(await directory(), "existing");
    await writeFile(path, "original\n");
    await chmod(path, 0o600);
    const password = await Effect.runPromise(
      ensurePasswordFile(path, () => "replacement"),
    );
    expect(Redacted.value(password)).toBe("original");
    expect((await readFile(path, "utf8")).trim()).toBe("original");
  });

  it("refuses to write over an existing file through the low-level writer", async () => {
    const path = join(await directory(), "taken");
    await writeFile(path, "original\n");
    await expect(
      Effect.runPromise(writePasswordFile(path, Redacted.make("replacement"))),
    ).rejects.toThrow(/Could not write/);
  });

  it("refuses a password file readable by other users", async () => {
    const path = join(await directory(), "world-readable");
    await writeFile(path, "exposed\n");
    await chmod(path, 0o644);
    await expect(Effect.runPromise(readPasswordFile(path))).rejects.toThrow(/chmod 600/);
  });
});
