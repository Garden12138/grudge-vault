import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { prepareNativeMedia } from "./prepare-native-media.mjs";

if (process.platform === "darwin") {
  prepareNativeMedia();
  const moduleCache = mkdtempSync(join(tmpdir(), "grudge-vault-swift-cache-"));
  try {
    const result = spawnSync("/usr/bin/swift", ["scripts/generate-mac-icon.swift", "apps/desktop/build"], {
      stdio: "inherit", env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache, SWIFT_MODULE_CACHE_PATH: moduleCache }
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Unable to generate the Mac icon: ${result.error?.message ?? result.status}`);
    }
  } finally {
    rmSync(moduleCache, { recursive: true, force: true });
  }
}
