import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export async function prepareRelease(tag, directory, version) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || tag !== `v${version}`) {
    throw new Error("Release tag must match the desktop package version.");
  }
  const targets = ["linux-x64.AppImage", "win-x64.exe", "mac-arm64.dmg", "mac-arm64.zip", "mac-x64.dmg", "mac-x64.zip"];
  const installers = targets.map(target => `Grudge Vault-${version}-${target}`).sort();
  const expected = new Set([...installers, "SHA256SUMS"]);
  for (const name of await readdir(directory)) {
    if (!expected.has(name)) throw new Error(`Unexpected release file: ${name}`);
  }
  const checksums = [];
  for (const name of installers) {
    const path = join(directory, name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
      throw new Error(`Installer must be a nonempty regular file: ${name}`);
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    checksums.push(`${hash.digest("hex")}  ${name}`);
  }
  await writeFile(join(directory, "SHA256SUMS"), `${checksums.join("\n")}\n`);
  return installers;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = dirname(dirname(fileURLToPath(import.meta.url)));
  const { version } = JSON.parse(await readFile(join(repository, "apps/desktop/package.json"), "utf8"));
  const installers = await prepareRelease(process.argv[2] ?? "", resolve(process.argv[3] ?? "release"), version);
  process.stdout.write(`Verified ${installers.length} installers for v${version}; SHA256SUMS created.\n`);
}
