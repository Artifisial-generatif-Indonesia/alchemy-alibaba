import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPnpm } from "../../../scripts/package-manager.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const temp = await mkdtemp(path.join(tmpdir(), "rds-access-package-"));
const pnpm = (args, cwd = root) =>
  runPnpm(args, {
    cwd,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 10 * 1024 * 1024,
  });
try {
  await rm(path.join(root, "dist"), { recursive: true, force: true });
  pnpm(["run", "build"]);
  const packed = JSON.parse(
    pnpm(["pack", "--config.ignore-scripts=true", "--json", "--pack-destination", temp]),
  );
  assert.equal(packed.name, pkg.name);
  assert.equal(packed.version, pkg.version);
  const files = new Set(packed.files.map((file) => file.path));
  for (const expected of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/bin.js",
    "dist/index.js",
    "dist/index.d.ts",
  ]) {
    assert.ok(files.has(expected), `Missing ${expected}`);
  }
  for (const file of files) {
    assert.ok(
      ["package.json", "README.md", "LICENSE"].includes(file) ||
        /^dist\/[a-z]+\.(js|d\.ts)$/.test(file),
      `Unexpected file ${file}`,
    );
  }
  assert.match(await readFile(path.join(root, "dist/bin.js"), "utf8"), /^#!\/usr\/bin\/env node\n/);
  const tarball = path.join(temp, path.basename(packed.filename));
  const consumer = path.join(temp, "consumer");
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      packageManager: "pnpm@11.25.0",
      dependencies: { [pkg.name]: `file:${tarball}`, effect: pkg.dependencies.effect },
    }),
  );
  // No provider peers or repository overrides: exercise this package on its own.
  await writeFile(
    path.join(consumer, "pnpm-workspace.yaml"),
    'allowBuilds:\n  "@alicloud/openapi-core": false\n  "msgpackr-extract": false\n',
  );
  pnpm(["install", "--no-frozen-lockfile", "--registry=https://registry.npmjs.org/"], consumer);
  const installed = JSON.parse(pnpm(["list", "--depth", "Infinity", "--json"], consumer));
  assert.doesNotMatch(
    JSON.stringify(installed),
    /"(?:alchemy|alchemy-alibaba)":/,
    "Helper must not install Alchemy",
  );
  const output = pnpm(["exec", "rds-access", "--help"], consumer);
  assert.match(output, /refresh/);
  assert.match(output, /revoke/);
  assert.match(pnpm(["exec", "rds-access", "refresh", "--help"], consumer), /--developer/);
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const api = await import('${pkg.name}'); if (typeof api.refreshAccess !== 'function') process.exit(1);`,
    ],
    {
      cwd: consumer,
      timeout: 30_000,
      stdio: "pipe",
    },
  );
  await writeFile(
    path.join(consumer, "consumer.ts"),
    `import { Effect } from "effect";\nimport { refreshAccess, rdsApiLayer } from "${pkg.name}";\nconst target = { instanceId: "pgm-example", regionId: "ap-southeast-5", developer: "alice", networkType: "MIX" as const };\nconst program = refreshAccess(target, "203.0.113.1").pipe(Effect.provide(rdsApiLayer({ regionId: target.regionId })));\nvoid program;\n`,
  );
  execFileSync(
    process.execPath,
    [
      path.join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--skipLibCheck",
      "consumer.ts",
    ],
    {
      cwd: consumer,
      timeout: 60_000,
      stdio: "pipe",
    },
  );
  const outputDirectory = path.resolve(root, "../../artifacts/rds-access");
  await mkdir(outputDirectory, { recursive: true });
  const filename = path.basename(packed.filename);
  await cp(tarball, path.join(outputDirectory, filename));
  const bytes = await readFile(tarball);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  await writeFile(
    path.join(outputDirectory, "SHA256SUMS"),
    `${sha256}  ${filename}\n`,
  );
  await writeFile(
    path.join(outputDirectory, "verification.json"),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      tag: pkg.publishConfig.tag,
      node: process.versions.node,
      pnpm: pnpm(["--version"]).trim(),
      tarball: filename,
      sha256,
      integrity,
      fileCount: files.size,
      cliVerified: true,
      consumerTypecheck: true,
      noAlchemyDependency: true,
    }, null, 2) + "\n",
  );
  console.log(
    `Verified ${pkg.name}@${pkg.version}: ${files.size} files, CLI, exports and consumer types; no Alchemy dependency.`,
  );
  console.log(`Tarball: ${path.join(outputDirectory, filename)}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
