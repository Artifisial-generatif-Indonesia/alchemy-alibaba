import { afterEach, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directories = [];
afterEach(() => directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

function run(mode = "success", args = []) {
  const root = mkdtempSync(path.join(tmpdir(), "alchemy-publish-test-"));
  directories.push(root);
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(new URL("./publish-release.mjs", import.meta.url), path.join(root, "scripts/publish-release.mjs"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "alchemy-alibaba", version: "0.2.0",
    publishConfig: { registry: "https://registry.npmjs.org/", access: "public", tag: "latest" },
  }));
  writeFileSync(path.join(root, ".gitignore"), "artifacts/\ncalls.jsonl\n");
  writeFileSync(path.join(root, "fake-npm.cjs"), `
    const fs = require("node:fs"), crypto = require("node:crypto");
    const args = process.argv.slice(2), mode = process.env.RELEASE_TEST_MODE;
    fs.appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
    if (args[0] === "--version") console.log("11.19.1");
    else if (args[0] === "whoami") {
      if (mode === "auth-failure") process.exit(1);
      console.log("test-publisher");
    } else if (args[0] === "ci") {
      if (mode === "install-failure") process.exit(1);
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
    env: { ...process.env, npm_execpath: path.join(root, "fake-npm.cjs"), RELEASE_TEST_MODE: mode },
  });
  const calls = readFileSync(path.join(root, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  return { ...result, calls };
}

test("installs and validates before publishing the exact artifact, then verifies the registry", () => {
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls.map(args => args[0])).toEqual(["--version", "whoami", "ci", "run", "publish", "view", "view"]);
  const publish = result.calls.find(args => args[0] === "publish");
  expect(publish[1]).toMatch(/artifacts\/0.2.0\/alchemy-alibaba-0.2.0.tgz$/);
  expect(publish.slice(2)).toEqual(["--ignore-scripts", "--tag", "latest", "--access", "public", "--registry=https://registry.npmjs.org/"]);
});

test("dry run validates without authentication or registry publication", () => {
  const result = run("success", ["--dry-run"]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls.map(args => args[0])).toEqual(["--version", "ci", "run", "publish"]);
  expect(result.calls.at(-1)).toContain("--dry-run");
});

test.each(["dirty", "auth-failure", "install-failure", "checks-failure", "tampered"])("%s prevents publication", mode => {
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
