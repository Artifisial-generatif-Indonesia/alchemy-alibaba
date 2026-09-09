import { afterEach, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertNodeVersion } from "./package-manager.mjs";

const requirement = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).engines.node;
test.each(["22.12.0", "22.22.1", "24.0.0", "26.5.0"])("release runtime accepts Node %s", version => {
  expect(() => assertNodeVersion(requirement, version)).not.toThrow();
});
test.each(["20.19.0", "22.11.0"])("release runtime rejects Node %s", version => {
  expect(() => assertNodeVersion(requirement, version)).toThrow("Use Node >=22.12.0");
});

const directories = [];
afterEach(() => directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

function environmentWith(overrides, inherited = process.env) {
  const names = new Set(Object.keys(overrides).map(name => name.toLowerCase()));
  const env = Object.fromEntries(Object.entries(inherited)
    .filter(([name]) => !names.has(name.toLowerCase())));
  return { ...env, ...overrides };
}

function run(mode = "success", args = [], inheritedEnv = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "alchemy-publish-test-"));
  directories.push(root);
  mkdirSync(path.join(root, "scripts"));
  for (const file of ["publish-release.mjs", "package-manager.mjs"]) {
    copyFileSync(new URL(file, import.meta.url), path.join(root, "scripts", file));
  }
  writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "alchemy-alibaba", version: "0.2.0",
    engines: { node: requirement },
    publishConfig: { registry: "https://registry.npmjs.org/", access: "public", tag: "latest" },
  }));
  writeFileSync(path.join(root, ".gitignore"),
    readFileSync(new URL("../.gitignore", import.meta.url), "utf8") + "\ncalls.jsonl\n");
  writeFileSync(path.join(root, "fake-pnpm.cjs"), `
    const fs = require("node:fs"), crypto = require("node:crypto");
    const args = process.argv.slice(2), mode = process.env.RELEASE_TEST_MODE;
    fs.appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
    if (args[0] === "--version") console.log("11.25.0");
    else if (args[0] === "whoami") {
      if (mode === "auth-failure") process.exit(1);
      console.log("test-publisher");
    } else if (args[0] === "install") {
      if (mode === "install-failure") process.exit(1);
      if (mode === "local-stores") {
        for (const directory of ["global/v11", "package-manager-store/v11/files/00", ".pnpm-store/v11"]) {
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(directory + "/generated", "pnpm generated data");
        }
      }
      if (mode === "tracked-change") fs.appendFileSync("package.json", "\\n");
    } else if (args[0] === "run") {
      if (mode === "checks-failure") process.exit(1);
      const out = "artifacts/0.2.0/", tarball = "alchemy-alibaba-0.2.0.tgz";
      const bytes = Buffer.from("synthetic package");
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const integrity = "sha512-" + crypto.createHash("sha512").update(bytes).digest("base64");
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(out + tarball, mode === "tampered" ? "different bytes" : bytes);
      fs.writeFileSync(out + "SHA256SUMS", sha256 + "  " + tarball + "\\n");
      fs.writeFileSync(out + "verification.json", JSON.stringify({
        name: "alchemy-alibaba", version: "0.2.0", tag: "latest", tarball, sha256, integrity,
      }));
    } else if (args[0] === "publish") {
      if (mode === "publish-failure") process.exit(1);
    } else if (args[0] === "view") {
      const v = JSON.parse(fs.readFileSync("artifacts/0.2.0/verification.json"));
      console.log(JSON.stringify(args[2] === "dist.integrity"
        ? (mode === "registry-mismatch" ? "sha512-wrong" : v.integrity) : v.version));
    } else process.exit(99);
  `);
  const git = args => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init"]);
  git(["add", "."]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
  if (mode === "dirty") writeFileSync(path.join(root, "untracked.txt"), "uncommitted");
  const result = spawnSync(process.execPath, [path.join(root, "scripts/publish-release.mjs"), ...args], {
    cwd: root, encoding: "utf8",
    env: environmentWith(
      { npm_execpath: path.join(root, "fake-pnpm.cjs"), RELEASE_TEST_MODE: mode },
      { ...process.env, ...inheritedEnv },
    ),
  });
  const calls = existsSync(path.join(root, "calls.jsonl"))
    ? readFileSync(path.join(root, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
  return { ...result, calls };
}

test("installs and validates before publishing the exact artifact, then verifies the registry", () => {
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls.map(args => args[0])).toEqual(["whoami", "install", "run", "publish", "view", "view"]);
  const publish = result.calls.find(args => args[0] === "publish");
  expect(publish[1].split(path.sep).join("/")).toMatch(/artifacts\/0.2.0\/alchemy-alibaba-0.2.0.tgz$/);
  expect(publish.slice(2)).toEqual(["--ignore-scripts", "--no-git-checks", "--tag", "latest", "--access", "public", "--registry=https://registry.npmjs.org/"]);
});

test("dry run validates without authentication or registry publication", () => {
  const result = run("success", ["--dry-run"]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls.map(args => args[0])).toEqual(["install", "run", "publish"]);
  expect(result.calls.at(-1)).toContain("--dry-run");
});

test.each(["NPM_EXECPATH", "NpM_ExEcPaTh"])(
  "replaces inherited %s without invoking it",
  inheritedName => {
    const result = run("success", ["--dry-run"], {
      [inheritedName]: path.join("C:\\", "must-not-run", "pnpm.exe"),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.map(args => args[0])).toEqual(["install", "run", "publish"]);
  },
);

test("local pnpm stores created during installation do not block publication", () => {
  const result = run("local-stores");
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls.filter(args => args[0] === "publish")).toHaveLength(1);
});

test.each(["dirty", "tracked-change", "auth-failure", "install-failure", "checks-failure", "tampered"])("%s prevents publication", mode => {
  const result = run(mode);
  expect(result.status).not.toBe(0);
  expect(result.calls.some(args => args[0] === "publish")).toBe(false);
});

test.each(["publish-failure", "registry-mismatch"])("%s fails without retrying publication", mode => {
  const result = run(mode);
  expect(result.status).not.toBe(0);
  expect(result.calls.filter(args => args[0] === "publish")).toHaveLength(1);
  expect(result.stderr).toMatch(/before (retrying|any retry)/i);
});
