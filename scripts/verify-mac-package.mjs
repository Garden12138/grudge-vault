import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { assertPackageRuntimeIdentity } from "./package-runtime-identity.mjs";
import { verifyMacZipArchive } from "./verify-mac-zip.mjs";

const output = resolve(process.argv[2] ?? "release");
const preview = process.argv.includes("--preview");
const productName = preview ? "Grudge Vault 测试版" : "Grudge Vault";
const expectedIdentity = preview ? "com.grudgevault.desktop.preview" : "com.grudgevault.desktop";
const sourceMatch = process.argv.includes("--source-match");
const sourceRoot = join(dirname(dirname(fileURLToPath(import.meta.url))), "apps/desktop");
const candidates = readdirSync(output, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
  .map((entry) => join(output, entry.name, `${productName}.app`))
  .filter(existsSync);

if (candidates.length !== 1) {
  throw new Error(`Expected exactly one Mac app in ${output}; found ${candidates.length}.`);
}

const app = candidates[0];
const executable = join(app, "Contents", "MacOS", productName);
const asar = join(app, "Contents", "Resources", "app.asar");
const mediaTool = join(app, "Contents", "Resources", "bin", "grudge-vault-media");
if (!statSync(executable).isFile() || !statSync(asar).isFile()) {
  throw new Error("Packaged app is missing its executable or ASAR archive.");
}
if (!statSync(mediaTool).isFile() || !(statSync(mediaTool).mode & 0o111)) {
  throw new Error("Packaged app is missing its executable native media helper.");
}
const architectures = spawnSync("/usr/bin/lipo", [mediaTool, "-verify_arch", "arm64", "x86_64"], { encoding: "utf8" });
if (architectures.error || architectures.status !== 0) throw new Error("Native media helper must include both Mac architectures.");
// Verify the bundled helper itself, without developer tools, network or real user media.
const mediaProbeDirectory = mkdtempSync(join(tmpdir(), "grudge-vault-package-media-"));
try {
  const source = join(mediaProbeDirectory, "synthetic.wav");
  const segment = join(mediaProbeDirectory, "segment.wav");
  const wav = Buffer.alloc(44 + 1600);
  wav.write("RIFF", 0); wav.writeUInt32LE(1636, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(1600, 40); wav.writeInt16LE(1024, 44);
  writeFileSync(source, wav, { mode: 0o600 });
  const runMedia = (args) => {
    const result = spawnSync(mediaTool, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 64_000 });
    if (result.error || result.status !== 0) throw new Error("Bundled native media helper could not process a synthetic fixture.");
    return JSON.parse(result.stdout);
  };
  const probe = runMedia(["probe", source]);
  const exported = runMedia(["segment", source, segment, "audio", "0", "100", "64000"]);
  if (probe.ok !== true || probe.durationMs !== 100 || probe.hasAudio !== true || probe.hasVideo !== false ||
      exported.ok !== true || exported.durationMs !== 100 || !readFileSync(segment).equals(wav)) {
    throw new Error("Bundled native media helper did not preserve the synthetic PCM fixture.");
  }
  const fixture = JSON.parse(readFileSync(fileURLToPath(new globalThis.URL("../tests/fixtures/native-image/synthetic.json", import.meta.url)), "utf8"));
  const imageSource = join(mediaProbeDirectory, "synthetic.heic"), imageCopy = join(mediaProbeDirectory, "converted.image");
  const original = Buffer.from(fixture.single, "base64");
  writeFileSync(imageSource, original, { mode: 0o600 });
  const image = runMedia(["image", imageSource, imageCopy, "7000000"]);
  const converted = readFileSync(imageCopy);
  if (image.ok !== true || image.format !== "png" || image.width !== 64 || image.height !== 96 ||
      !converted.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      converted.readUInt32BE(16) !== 64 || converted.readUInt32BE(20) !== 96 ||
      converted.includes(Buffer.from("GV_SYNTHETIC_PRIVATE_IMAGE_METADATA")) ||
      !readFileSync(imageSource).equals(original)) {
    throw new Error("Bundled image helper did not preserve the synthetic image dimensions, direction or original.");
  }
} finally { rmSync(mediaProbeDirectory, { recursive: true, force: true }); }
const infoPlist = join(app, "Contents", "Info.plist");
for (const [field, expected] of [["CFBundleIdentifier", expectedIdentity], ["CFBundleExecutable", productName]]) {
  const value = spawnSync("/usr/bin/plutil", ["-extract", field, "raw", "-o", "-", infoPlist], { encoding: "utf8" });
  if (value.error || value.status !== 0 || value.stdout.trim() !== expected) {
    throw new Error(`Packaged app has the wrong ${field}; expected ${expected}.`);
  }
}
const iconName = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleIconFile", "raw", "-o", "-", infoPlist], { encoding: "utf8" });
const icon = join(app, "Contents", "Resources", "icon.icns");
if (iconName.error || iconName.status !== 0 || iconName.stdout.trim() !== "icon.icns" || !existsSync(icon)) {
  throw new Error("Packaged app is missing its Grudge Vault icon.");
}
if (sourceMatch && (!readFileSync(icon).equals(readFileSync(join(sourceRoot, "build/icon.icns"))) ||
    !readFileSync(mediaTool).equals(readFileSync(join(sourceRoot, "build/native/grudge-vault-media"))))) {
  throw new Error("Packaged icon or native media helper does not match the current build.");
}

if (process.argv.includes("--installers")) {
  for (const extension of ["dmg", "zip"]) {
    const installers = readdirSync(output).filter((name) => name.endsWith(`-mac-${process.arch}.${extension}`));
    if (installers.length !== 1) throw new Error(`Expected one ${process.arch} Mac ${extension} in ${output}; found ${installers.length}.`);
    const installer = join(output, installers[0]);
    if (extension === "dmg") {
      const verified = spawnSync("/usr/bin/hdiutil", ["verify", installer], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
      if (verified.error || verified.status !== 0) throw new Error(`DMG verification failed: ${verified.error?.message ?? verified.stderr}`);
    } else {
      verifyMacZipArchive(installer, app, productName);
    }
  }
}

const probe = `
  const fs = require("node:fs");
  const path = require("node:path");
  const asar = process.argv[1];
  const assertRuntimeIdentity = (${assertPackageRuntimeIdentity.toString()});
  assertRuntimeIdentity(JSON.parse(fs.readFileSync(path.join(asar, "package.json"), "utf8")), ${preview});
  process.stdout.write("GRUDGE_VAULT_RUNTIME_IDENTITY_OK\\n");
  for (const name of ["out/main/index.js", "out/preload/index.cjs", "out/renderer/index.html"]) {
    if (!fs.statSync(path.join(asar, name)).isFile()) throw new Error("Missing bundled entry: " + name);
  }
  if (${sourceMatch}) {
    const sourceRoot = ${JSON.stringify(sourceRoot)};
    const entries = ["out/main/index.js", "out/preload/index.cjs", "out/renderer/index.html",
      ...fs.readdirSync(path.join(sourceRoot, "out/renderer/assets")).map(name => "out/renderer/assets/" + name)];
    for (const name of entries) {
      if (!fs.readFileSync(path.join(asar, name)).equals(fs.readFileSync(path.join(sourceRoot, name)))) {
        throw new Error("Bundled entry does not match the current production build: " + name);
      }
    }
    const main = fs.readFileSync(path.join(asar, "out/main/index.js"), "utf8");
    if (main.includes("__gvE2eFailWorkspaceClose") || main.includes("Synthetic close failure")) {
      throw new Error("An E2E fault hook must not appear in a production package.");
    }
    process.stdout.write("GRUDGE_VAULT_SOURCE_MATCH_OK " + entries.length + "\\n");
  }
  const Database = require(path.join(asar, "node_modules/better-sqlite3"));
  const database = new Database(":memory:");
  try {
    if (database.prepare("SELECT 1 AS value").get().value !== 1) throw new Error("SQLite smoke query failed");
  } finally {
    database.close();
  }
  process.stdout.write("GRUDGE_VAULT_PACKAGE_OK\\n");
`;
const result = spawnSync(executable, ["-e", probe, asar], {
  encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
});
if (result.error || result.status !== 0 || !result.stdout.includes("GRUDGE_VAULT_PACKAGE_OK")) {
  throw new Error(`Packaged app smoke test failed: ${result.error?.message || result.stderr || result.stdout || result.status}`);
}
process.stdout.write(`Verified packaged Mac ${preview ? "preview" : "app"}, identity, icon, native media helper, SQLite runtime${sourceMatch ? " and current production build" : ""}${process.argv.includes("--installers") ? " and installers" : ""}: ${app}\n`);
