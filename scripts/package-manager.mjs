import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

export function assertNodeVersion(requirement, version = process.versions.node) {
  const match = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(requirement);
  assert.ok(match, "Expected a minimum Node version in engines.node");
  const minimum = match.slice(1).map(Number);
  const actual = version.split(".").map(Number);
  const difference = actual.map((part, index) => part - minimum[index]).find(value => value !== 0) ?? 0;
  assert.ok(difference >= 0, `Use Node ${requirement}; found ${version}`);
}

// pnpm may be a JavaScript CLI or a standalone executable.
export function runPnpm(args, options) {
  const cli = process.env.npm_execpath;
  assert.ok(cli && path.basename(cli).includes("pnpm"), "Run this script through pnpm run");
  const javascript = /\.[cm]?js$/.test(cli);
  return execFileSync(javascript ? process.execPath : cli, javascript ? [cli, ...args] : args, options);
}
