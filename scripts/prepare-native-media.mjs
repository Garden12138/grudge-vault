import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
export const nativeMediaTool = join(repository, "apps/desktop/build/native/grudge-vault-media");

export function prepareNativeMedia() {
  if (process.platform !== "darwin") return;
  const sources = ["media-tool.swift", "image-conversion.swift"].map((name) => join(repository, "native/macos", name));
  const fingerprint = sources.reduce((hash, source) => hash.update(readFileSync(source)), createHash("sha256"))
    .update("universal-macos13-v1").digest("hex");
  const marker = `${nativeMediaTool}.sha256`;
  try {
    if (readFileSync(marker, "utf8") === fingerprint && readFileSync(nativeMediaTool).length > 0) return;
  } catch { /* Build missing or stale generated artifacts. */ }
  const staging = mkdtempSync(join(tmpdir(), "grudge-vault-native-media-build-"));
  try {
    const run = (executable, args) => {
      const result = spawnSync(executable, args, { stdio: "inherit", env: {
        ...process.env, CLANG_MODULE_CACHE_PATH: join(staging, "cache"), SWIFT_MODULE_CACHE_PATH: join(staging, "cache")
      } });
      if (result.error || result.status !== 0) throw new Error("Unable to build the native media helper.");
    };
    const binaries = ["arm64", "x86_64"].map((arch) => {
      const binary = join(staging, `media-${arch}`);
      run("/usr/bin/xcrun", ["swiftc", "-parse-as-library", "-O", "-target", `${arch}-apple-macos13.0`,
        "-module-cache-path", join(staging, "cache"), ...sources, "-o", binary]);
      return binary;
    });
    mkdirSync(dirname(nativeMediaTool), { recursive: true });
    run("/usr/bin/lipo", ["-create", ...binaries, "-output", nativeMediaTool]);
    writeFileSync(marker, fingerprint);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) prepareNativeMedia();
