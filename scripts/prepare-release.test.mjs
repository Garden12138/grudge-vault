import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareRelease } from "./prepare-release.mjs";

const files = [
  "Grudge Vault-0.2.1-linux-x64.AppImage", "Grudge Vault-0.2.1-win-x64.exe",
  "Grudge Vault-0.2.1-mac-arm64.dmg", "Grudge Vault-0.2.1-mac-arm64.zip",
  "Grudge Vault-0.2.1-mac-x64.dmg", "Grudge Vault-0.2.1-mac-x64.zip"
];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of files) await writeFile(join(root, name), `synthetic installer: ${name}`);
  return root;
}

test("hashes all six installers using their published GitHub download names", async t => {
  const root = await fixture(t);
  assert.deepEqual(await prepareRelease("v0.2.1", root, "0.2.1"), [...files].sort());
  const checksums = await readFile(join(root, "SHA256SUMS"), "utf8");
  assert.equal(checksums.trim().split("\n").length, 6);
  for (const name of files) {
    await rename(join(root, name), join(root, name.replaceAll(" ", ".")));
  }
  for (const line of checksums.trim().split("\n")) {
    const [expected, name] = line.split("  ");
    const downloadedBytes = await readFile(join(root, name));
    assert.equal(createHash("sha256").update(downloadedBytes).digest("hex"), expected);
  }
});

test("rejects a missing platform rather than publishing a partial release", async t => {
  const root = await fixture(t); await rm(join(root, files[1]));
  await assert.rejects(prepareRelease("v0.2.1", root, "0.2.1"), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "SHA256SUMS")), { code: "ENOENT" });
});

test("rejects source archives and unrelated files from the release asset directory", async t => {
  const root = await fixture(t); await writeFile(join(root, "Source code.zip"), "source only");
  await assert.rejects(prepareRelease("v0.2.1", root, "0.2.1"), /Unexpected release file/);
});

test("rejects empty installers and directories presented as installer files", async t => {
  const root = await fixture(t); await writeFile(join(root, files[0]), "");
  await assert.rejects(prepareRelease("v0.2.1", root, "0.2.1"), /nonempty regular file/);
  await rm(join(root, files[0])); await mkdir(join(root, files[0]));
  await assert.rejects(prepareRelease("v0.2.1", root, "0.2.1"), /nonempty regular file/);
});

test("rejects symlinked installers", async t => {
  const root = await fixture(t); await rm(join(root, files[0]));
  await symlink(join(root, files[1]), join(root, files[0]), "file");
  await assert.rejects(prepareRelease("v0.2.1", root, "0.2.1"), /nonempty regular file/);
});

test("rejects invalid tags or a package version that differs from the tag", async t => {
  const root = await fixture(t);
  await assert.rejects(prepareRelease("v0.2.0", root, "0.2.1"), /must match/);
  await assert.rejects(prepareRelease("v0.2.1-extra", root, "0.2.1"), /must match/);
});
