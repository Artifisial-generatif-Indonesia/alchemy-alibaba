import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

// pnpm may be a JavaScript CLI or a standalone executable.
export function runPnpm(args, options) {
  const cli = process.env.npm_execpath;
  assert.ok(cli && path.basename(cli).includes("pnpm"), "Run this script through pnpm run");
  const javascript = /\.[cm]?js$/.test(cli);
  return execFileSync(javascript ? process.execPath : cli, javascript ? [cli, ...args] : args, options);
}
