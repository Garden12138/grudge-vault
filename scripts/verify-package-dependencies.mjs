import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Exercise the pinned packager's real collector before spending time on E2E.
// Run this with Node directly, with the same PATH as the packaging command.
const require = createRequire(import.meta.url);
const { getCollectorByPackageManager, getPackageManagerCommand, PM } = require("app-builder-lib/out/node-module-collector/index.js");
const { TmpDir } = require("builder-util");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appDirectory = join(root, "apps/desktop");
const metadata = JSON.parse(await readFile(join(appDirectory, "package.json"), "utf8"));
const temporary = new TmpDir("grudge-vault-dependency-verification");
try {
  process.stdout.write(`Packaging dependency collector: ${getPackageManagerCommand(PM.PNPM)}\n`);
  const collector = getCollectorByPackageManager(PM.PNPM, appDirectory, temporary);
  const { stdout } = await collector.asyncExec(getPackageManagerCommand(PM.PNPM), ["--version"]);
  assert.equal(typeof stdout, "string", "Packager could not read the pnpm version.");
  assert.equal(stdout.trim(), "11.23.0", "Packaging must use the pinned pnpm version.");
  const { nodeModules } = await collector.getNodeModules({ packageName: metadata.name });
  const sqlite = nodeModules.find(module => module.name === "better-sqlite3");
  assert.ok(sqlite, "Packager did not collect the required SQLite runtime.");
  assert.equal(sqlite.version, metadata.dependencies["better-sqlite3"]);
  process.stdout.write(`Verified ${nodeModules.length} runtime dependencies, including better-sqlite3 ${sqlite.version}.\n`);
} finally {
  await temporary.cleanup();
}
