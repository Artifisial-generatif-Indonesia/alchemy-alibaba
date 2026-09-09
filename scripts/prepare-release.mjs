import { runPnpm } from "./package-manager.mjs";
import { parse, stringify } from "yaml";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, "Prepare a release version");
const lock = parse(await readFile(path.join(root, "pnpm-lock.yaml"), "utf8"));
const workspace = parse(await readFile(path.join(root, "pnpm-workspace.yaml"), "utf8"));
assert.deepEqual(lock.overrides, workspace.overrides, "Lockfile overrides must match workspace settings");
for (const section of ["dependencies", "devDependencies"]) {
  for (const [name, specifier] of Object.entries(pkg[section])) {
    assert.equal(lock.importers["."][section][name].specifier, specifier, `Lockfile mismatch for ${name}`);
  }
}
assert.equal(pkg.publishConfig.tag, "latest");
assert.equal(pkg.publishConfig.access, "public");
assert.equal(pkg.publishConfig.registry, "https://registry.npmjs.org/");
assert.equal(process.versions.node.split(".")[0], "22", "Release validation uses Node 22");
const pnpm = (args, cwd = root) => runPnpm(args, {
  cwd, encoding: "utf8", timeout: 300_000, maxBuffer: 10 * 1024 * 1024,
  env: { ...process.env, ALCHEMY_TELEMETRY_DISABLED: "1" },
});
const pnpmVersion = pnpm(["--version"]).trim();

const output = path.join(root, "artifacts", pkg.version);
await rm(output, { recursive: true, force: true });

// Rebuild from an empty output directory so removed modules cannot ship accidentally.
await rm(path.join(root, "dist"), { recursive: true, force: true });
pnpm(["run", "build"]);
const temp = await mkdtemp(path.join(tmpdir(), "alchemy-release-"));
try {
  console.log(`Packing ${pkg.name}@${pkg.version} for the ${pkg.publishConfig.tag} channel`);
  const packed = JSON.parse(pnpm(["pack", "--config.ignore-scripts=true", "--json", "--pack-destination", temp]));
  const filename = path.basename(packed.filename);
  assert.equal(packed.name, pkg.name);
  assert.equal(packed.version, pkg.version);
  const files = new Set(packed.files.map(file => file.path));
  const expected = new Set(["package.json", "README.md", "LICENSE", "SUPPORT-MATRIX.md", "SPEC-COVERAGE.md", "LIVE-VALIDATION.md", "CHANGELOG.md", "RELEASE.md", "ECS.md", "COMPOSITION.md"]);
  async function compiledFiles(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (name === "protocol") continue;
      if (entry.isDirectory()) await compiledFiles(path.join(directory, entry.name), name);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "test-support.ts") {
        expected.add(`dist/${name.slice(0, -3)}.js`);
        expected.add(`dist/${name.slice(0, -3)}.d.ts`);
      }
    }
  }
  await compiledFiles(path.join(root, "src"));
  assert.deepEqual([...files].sort(), [...expected].sort(), "Unexpected or missing package files");
  for (const exported of Object.values(pkg.exports)) {
    for (const target of [exported.import, exported.types]) assert.ok(files.has(target.replace(/^\.\//, "")), `Missing export ${target}`);
  }
  const tarball = path.join(temp, filename);
  const consumer = path.join(temp, "consumer");
  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({
    private: true, type: "module", packageManager: pkg.packageManager,
    dependencies: { ...pkg.peerDependencies, [pkg.name]: `file:${tarball}` },
  }, null, 2));
  await writeFile(path.join(consumer, "pnpm-workspace.yaml"), stringify(workspace));
  console.log("Installing the tarball in a fresh consumer with the documented overrides");
  pnpm(["install", "--no-frozen-lockfile", "--registry=https://registry.npmjs.org/"], consumer);
  const audit = JSON.parse(pnpm(["audit", "--json", "--registry=https://registry.npmjs.org/"], consumer));
  const advisories = ["info", "low", "moderate", "high", "critical"]
    .reduce((total, severity) => total + audit.metadata.vulnerabilities[severity], 0);
  assert.equal(advisories, 0, "Consumer audit must be clean");
  const imports = Object.keys(pkg.exports).map(key => pkg.name + (key === "." ? "" : key.slice(1)));
  await writeFile(path.join(consumer, "imports.mjs"), imports.map(name => `await import(${JSON.stringify(name)});`).join("\n"));
  execFileSync(process.execPath, ["imports.mjs"], { cwd: consumer, timeout: 60_000, stdio: "pipe" });
  await writeFile(path.join(consumer, "consumer.ts"), `import * as Alibaba from "${pkg.name}";\nimport type { InstanceProps } from "${pkg.name}/rds";\nconst props: InstanceProps = { engine: "PostgreSQL", engineVersion: "16.0", DBInstanceClass: "example", DBInstanceStorage: 20, DBInstanceNetType: "Intranet", payType: "Postpaid", securityIPList: "127.0.0.1" };\nimport type { InstanceProps as EcsProps } from "${pkg.name}/ecs";\nconst vm: EcsProps = { imageId: "image", instanceType: "type", vSwitchId: "vswitch", securityGroupIds: ["group"] };\nvoid vm; void Alibaba.ECS.Instance; void props; void Alibaba.RDS.Instance;\n`);
  execFileSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--skipLibCheck", "consumer.ts"], { cwd: consumer, timeout: 60_000, stdio: "pipe" });
  const bytes = await readFile(tarball);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  await mkdir(output, { recursive: true });
  await cp(tarball, path.join(output, filename));
  await writeFile(path.join(output, "SHA256SUMS"), `${sha256}  ${filename}\n`);
  await cp(path.join(root, "CHANGELOG.md"), path.join(output, "release-notes.md"));
  await writeFile(path.join(output, "verification.json"), JSON.stringify({
    name: pkg.name, version: pkg.version, tag: pkg.publishConfig.tag,
    node: process.versions.node, pnpm: pnpmVersion, tarball: filename,
    sha256, integrity, fileCount: files.size,
    verifiedImports: imports, consumerTypecheck: true, consumerAdvisories: 0,
    peerDependencies: pkg.peerDependencies, requiredConsumerOverrides: workspace.overrides,
  }, null, 2) + "\n");
  console.log(`Verified ${files.size} files, ${imports.length} imports, consumer types, and audit. Artifacts: ${output}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
