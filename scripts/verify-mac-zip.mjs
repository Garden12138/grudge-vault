import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Inspect known installer members directly; native zipinfo can misrender Chinese names. */
export function verifyMacZipArchive(archive, application, productName, run = spawnSync) {
  if (!["Grudge Vault", "Grudge Vault 测试版"].includes(productName)) throw new Error("Invalid packaged product name.");
  const integrity = run("/usr/bin/unzip", ["-tq", archive], { encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  if (integrity.error || integrity.status !== 0) throw new Error("ZIP compressed data integrity verification failed.");
  const members = ["Info.plist", "Resources/app.asar", "Resources/icon.icns", "Resources/bin/grudge-vault-media"];
  for (const member of members) {
    const expected = readFileSync(join(application, "Contents", member));
    const result = run("/usr/bin/unzip", ["-p", archive, `${productName}.app/Contents/${member}`], {
      timeout: 30000, maxBuffer: Math.max(2 * 1024 * 1024, expected.length + 1)
    });
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout) || !result.stdout.equals(expected)) {
      throw new Error("ZIP required member is missing or does not match the packaged application.");
    }
  }
  return members.length;
}
