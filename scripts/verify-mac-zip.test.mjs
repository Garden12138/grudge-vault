import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { verifyMacZipArchive } from "./verify-mac-zip.mjs";

function fixture(productName) {
  const root = mkdtempSync(join(tmpdir(), "gv-packaged-zip-test-"));
  const app = join(root, `${productName}.app`), archive = join(root, "synthetic.zip");
  const entries = new Map();
  for (const member of ["Info.plist", "Resources/app.asar", "Resources/icon.icns", "Resources/bin/grudge-vault-media"]) {
    const path = join(app, "Contents", member);
    mkdirSync(join(path, ".."), { recursive: true });
    const bytes = Buffer.from(`synthetic:${member}`); writeFileSync(path, bytes);
    entries.set(`${productName}.app/Contents/${member}`, bytes);
  }
  return { root, app, archive, entries };
}

for (const productName of ["Grudge Vault", "Grudge Vault 测试版"]) {
  test(`verifies ${productName} ZIP using exact member bytes, never display-name parsing`, () => {
    const f = fixture(productName), calls = [];
    try {
      const run = (executable, args, options) => {
        calls.push(args); assert.equal(executable, "/usr/bin/unzip"); assert.equal(args[1], f.archive);
        if (args[0] === "-tq") return { status: 0, stdout: "No errors detected." };
        assert.equal(args[0], "-p"); assert.equal(options.encoding, undefined);
        return { status: 0, stdout: f.entries.get(args[2]) };
      };
      assert.equal(verifyMacZipArchive(f.archive, f.app, productName, run), 4);
      assert.equal(calls.length, 5); assert.ok(calls.every((args) => !args.includes("-Z")));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

for (const mode of ["missing", "changed", "duplicate", "process-error", "integrity-error"]) {
  test(`rejects ${mode} installer output without accepting its display name`, () => {
    const f = fixture("Grudge Vault 测试版");
    try {
      let reads = 0;
      const run = (_executable, args) => {
        if (args[0] === "-tq") return { status: mode === "integrity-error" ? 2 : 0, stdout: "" };
        reads += 1;
        const bytes = f.entries.get(args[2]);
        return mode === "missing" ? { status: 11, stdout: Buffer.alloc(0) }
          : mode === "process-error" ? { status: null, error: new Error("synthetic process failure"), stdout: bytes }
            : { status: 0, stdout: mode === "duplicate" ? Buffer.concat([bytes, bytes]) : Buffer.from("synthetic changed bytes") };
      };
      assert.throws(() => verifyMacZipArchive(f.archive, f.app, "Grudge Vault 测试版", run));
      assert.equal(reads, mode === "integrity-error" ? 0 : 1);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("rejects an unexpected product name before running an extractor", () => {
  let called = false;
  assert.throws(() => verifyMacZipArchive("unused", "unused", "../unexpected", () => { called = true; }));
  assert.equal(called, false);
});
