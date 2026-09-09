import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--dry-run"),
  "Usage: npm run release:publish [-- --dry-run]");
const dryRun = args.includes("--dry-run");
assert.equal(process.versions.node.split(".")[0], "22", "Use Node 22");
assert.ok(process.env.npm_execpath, "Run with npx --yes npm@11.19.1 run release:publish");
const npm = (args, capture = false) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
  cwd: root, stdio: capture ? "pipe" : "inherit", encoding: "utf8",
});
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
assert.equal(npm(["--version"], true).trim(), "11.19.1", "Use npx --yes npm@11.19.1 run release:publish");
const clean = () => assert.equal(execFileSync("git", ["status", "--porcelain"], {
  cwd: root, encoding: "utf8",
}).trim(), "", "Publish from a clean, committed checkout");
clean();
const pkg = json(path.join(root, "package.json"));
const registry = "--registry=https://registry.npmjs.org/";
assert.equal(pkg.publishConfig.registry, "https://registry.npmjs.org/");
assert.equal(pkg.publishConfig.tag, "latest");
assert.equal(pkg.publishConfig.access, "public");
if (!dryRun) npm(["whoami", registry]);
npm(["ci", "--no-audit", "--no-fund"]);
npm(["run", "release:prepare"]);
clean();

const output = path.join(root, "artifacts", pkg.version);
const verification = json(path.join(output, "verification.json"));
assert.equal(verification.name, pkg.name);
assert.equal(verification.version, pkg.version);
assert.equal(verification.tag, pkg.publishConfig.tag);
assert.equal(verification.tarball, `${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${pkg.version}.tgz`);
const tarball = path.join(output, verification.tarball);
const bytes = readFileSync(tarball);
const sha256 = createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256, verification.sha256, "Tarball SHA-256 mismatch");
assert.equal(readFileSync(path.join(output, "SHA256SUMS"), "utf8"), `${sha256}  ${verification.tarball}\n`);
assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, verification.integrity,
  "Tarball npm integrity mismatch");

console.log(`${dryRun ? "Dry run for" : "Publishing"} ${pkg.name}@${pkg.version}`);
try {
  npm(["publish", tarball, "--ignore-scripts", "--tag", "latest", "--access", "public", registry,
    ...(dryRun ? ["--dry-run"] : [])]);
} catch (error) {
  console.error(`Publication did not complete cleanly. Before retrying, check npm view ${pkg.name}@${pkg.version} dist.integrity and compare with ${path.join(output, "verification.json")}.`);
  throw error;
}
if (!dryRun) {
  assert.equal(JSON.parse(npm(["view", `${pkg.name}@${pkg.version}`, "dist.integrity", "--json", registry], true)),
    verification.integrity, "Published integrity differs; inspect the registry before any retry");
  assert.equal(JSON.parse(npm(["view", pkg.name, "dist-tags.latest", "--json", registry], true)),
    pkg.version, "Published latest tag differs; inspect the registry before any retry");
  console.log(`Published and verified ${pkg.name}@${pkg.version}. Git tagging and GitHub release steps are in RELEASE.md.`);
}
