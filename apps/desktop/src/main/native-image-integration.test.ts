import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SafeProcessRunner } from "@grudge-vault/media-pipeline";
import { MacNativeImageConverter } from "./native-image-conversion";

const enabled = process.platform === "darwin" && process.env.GRUDGE_VAULT_NATIVE_MEDIA_TEST === "1";
const executable = resolve("apps/desktop/build/native/grudge-vault-media");
const runner = new SafeProcessRunner();
let root = "", generator = "";
async function run(tool: string, args: string[]) {
  const result = await runner.run({ executable: tool, args, cwd: root, timeoutMs: 60_000, maxOutputBytes: 64_000 });
  expect(result.exitCode, result.stderr.toString("utf8")).toBe(0);
  return result;
}
async function inspect(path: string): Promise<{ width: number; height: number; orientation: number; colors: number[][];
  hasGPS: boolean; hasExif: boolean; hasPrivateComment: boolean; exifKeys: string[]; count: number }> {
  return JSON.parse((await run(generator, ["inspect", path])).stdout.toString("utf8"));
}
function converter(maxOutputBytes?: number) {
  const directories: string[] = [];
  const adapter = new MacNativeImageConverter({ executable, ...(maxOutputBytes ? { maxOutputBytes } : {}),
    createTemporaryDirectory: async (prefix) => {
      const directory = await mkdtemp(join(root, prefix)); directories.push(directory); return directory;
    } });
  return { adapter, directories };
}
async function cleaned(directories: string[]) {
  for (const path of directories) await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe.skipIf(!enabled)("real macOS HEIC fixtures (explicit local gate)", () => {
  beforeAll(async () => {
    await access(executable);
    root = await mkdtemp(join(tmpdir(), "grudge-vault-image-fixtures-")); generator = join(root, "generate-image");
    await run("/usr/bin/xcrun", ["swiftc", "-parse-as-library", "-module-cache-path", join(root, "module-cache"),
      resolve("tests/fixtures/native-image/generate.swift"), "-o", generator]);
  }, 90_000);
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("applies orientation %s at full size and strips private photo metadata", async (orientation) => {
    const input = join(root, `synthetic-${orientation}.heic`);
    await run(generator, ["generate", input, String(orientation), "palette", "1"]);
    const original = await readFile(input); const before = await inspect(input);
    expect(before.hasGPS).toBe(true); expect(before.hasExif).toBe(true); expect(before.hasPrivateComment).toBe(true);
    const { adapter, directories } = converter();
    const result = await adapter.convert({ mimeType: "image/heic", bytes: original });
    const output = join(root, `representation-${orientation}.png`); await writeFile(output, result.bytes);
    const rendered = await inspect(output);
    expect(result.mimeType).toBe("image/png");
    expect([result.width, result.height]).toEqual(orientation >= 5 ? [64, 96] : [96, 64]);
    expect([rendered.width, rendered.height, rendered.orientation]).toEqual([result.width, result.height, 1]);
    // Four distinct blocks verify rotation/mirroring, not just swapped dimensions.
    const order = [[0, 1, 2, 3], [1, 0, 3, 2], [3, 2, 1, 0], [2, 3, 0, 1],
      [0, 2, 1, 3], [2, 0, 3, 1], [3, 1, 2, 0], [1, 3, 0, 2]][orientation - 1]!;
    const colors = [[230, 20, 20], [20, 220, 20], [20, 20, 230], [230, 220, 20]];
    for (let index = 0; index < 4; index++) for (let channel = 0; channel < 3; channel++) {
      expect(Math.abs(rendered.colors[index]![channel]! - colors[order[index]!]![channel]!)).toBeLessThan(20);
    }
    expect(rendered.hasGPS).toBe(false); expect(rendered.hasPrivateComment).toBe(false);
    expect(rendered.exifKeys.every((key) => ["ColorSpace", "PixelXDimension", "PixelYDimension"].includes(key))).toBe(true);
    expect(Buffer.from(result.bytes).includes(Buffer.from("GV_SYNTHETIC_PRIVATE_IMAGE_METADATA"))).toBe(false);
    expect(createHash("sha256").update(await readFile(input)).digest("hex")).toBe(createHash("sha256").update(original).digest("hex"));
    expect(original.equals(await readFile(input))).toBe(true);
    await cleaned(directories);
  });

  it("falls back to a labelled high-quality full-size JPEG instead of scaling a large PNG", async () => {
    const input = join(root, "synthetic-noise.heic");
    await run(generator, ["generate", input, "6", "noise", "1"]);
    const { adapter, directories } = converter(12_000);
    const result = await adapter.convert({ mimeType: "image/heic", bytes: await readFile(input) });
    expect(result.mimeType).toBe("image/jpeg"); expect([result.width, result.height]).toEqual([64, 96]);
    expect(result.bytes.length).toBeLessThanOrEqual(12_000);
    const output = join(root, "synthetic-jpeg-copy.jpg"); await writeFile(output, result.bytes);
    const rendered = await inspect(output);
    expect([rendered.width, rendered.height, rendered.orientation]).toEqual([64, 96, 1]);
    expect(rendered.hasGPS).toBe(false); expect(rendered.hasPrivateComment).toBe(false);
    expect(Buffer.from(result.bytes).includes(Buffer.from("GV_SYNTHETIC_PRIVATE_IMAGE_METADATA"))).toBe(false);
    await cleaned(directories);
  });

  it("rejects multi-image and output-over-limit HEIC without selecting a prefix or shrinking", async () => {
    const multi = join(root, "synthetic-multi.heic"), noisy = join(root, "synthetic-small-cap.heic");
    await run(generator, ["generate", multi, "1", "palette", "2"]);
    expect((await inspect(multi)).count).toBe(2);
    await run(generator, ["generate", noisy, "1", "noise", "1"]);
    for (const [path, cap] of [[multi, 7_000_000], [noisy, 1024]] as const) {
      const { adapter, directories } = converter(cap);
      await expect(adapter.convert({ mimeType: "image/heic", bytes: await readFile(path) })).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
      await cleaned(directories);
    }
  });

  it("rejects a synthetic external item reference and a truncated container", async () => {
    const source = join(root, "synthetic-reference.heic"); await run(generator, ["generate", source, "1", "palette", "1"]);
    const bytes = await readFile(source);
    const payload = bytes.indexOf(Buffer.from("iloc")) + 4;
    expect(payload).toBeGreaterThan(4);
    const version = bytes[payload]!;
    const dataReference = payload + 6 + (version === 2 ? 4 : 2) + (version === 2 ? 4 : 2) + (version > 0 ? 2 : 0);
    const referenced = Buffer.from(bytes); referenced.writeUInt16BE(1, dataReference);
    for (const invalid of [referenced, bytes.subarray(0, 15)]) {
      const { adapter, directories } = converter();
      await expect(adapter.convert({ mimeType: "image/heic", bytes: invalid })).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
      await cleaned(directories);
    }
  });

  it("rejects declared PQ/HLG and auxiliary image containers before decoder fallback", async () => {
    const source = join(root, "synthetic-hdr-tags.heic"); await run(generator, ["generate", source, "1", "palette", "1"]);
    const bytes = await readFile(source);
    const color = bytes.indexOf(Buffer.from("colr")) + 4;
    expect(bytes.subarray(color, color + 4).toString("ascii")).toBe("nclx");
    const reference = bytes.indexOf(Buffer.from("cdsc")); expect(reference).toBeGreaterThan(0);
    const auxiliary = Buffer.from(bytes); auxiliary.write("auxl", reference, "ascii");
    const invalid = [auxiliary];
    for (const transfer of [16, 18]) { const tagged = Buffer.from(bytes); tagged.writeUInt16BE(transfer, color + 6); invalid.push(tagged); }
    for (const tagged of invalid) {
      const { adapter, directories } = converter();
      await expect(adapter.convert({ mimeType: "image/heic", bytes: tagged })).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
      await cleaned(directories);
    }
  });
});
