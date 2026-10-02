import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessRunnerPort } from "@grudge-vault/media-pipeline";
import { MacNativeImageConverter } from "./native-image-conversion";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function png() {
  const value = Buffer.alloc(24);
  value.set([137, 80, 78, 71, 13, 10, 26, 10]); value.write("IHDR", 12);
  value.writeUInt32BE(96, 16); value.writeUInt32BE(64, 20); return value;
}
async function fixture(callback?: (input: Parameters<ProcessRunnerPort["run"]>[0]) => Promise<unknown>) {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-image-contract-")); roots.push(root);
  const directories: string[] = [];
  const run = vi.fn(async (input: Parameters<ProcessRunnerPort["run"]>[0]) => {
    const custom = callback ? await callback(input) : undefined;
    if (!custom) await writeFile(input.args[2]!, png(), { mode: 0o600 });
    return { exitCode: 0, stdout: Buffer.from(JSON.stringify(custom ?? { ok: true, format: "png", width: 96, height: 64 })), stderr: Buffer.alloc(0) };
  });
  const adapter = new MacNativeImageConverter({ executable: "/synthetic/native-helper", platform: "darwin", runner: { run },
    createTemporaryDirectory: async (prefix) => {
      const path = await mkdtemp(join(root, prefix)); directories.push(path); return path;
    } });
  return { root, run, adapter, directories };
}
const original = Buffer.from("synthetic HEIC bytes: protocol unit test only");

describe.skipIf(process.platform === "win32")("private native image conversion contract", () => {
  it("uses bounded private files and returns only the copied representation", async () => {
    const test = await fixture(async (input) => {
      expect(input.executable).toBe("/synthetic/native-helper");
      expect(input.args[0]).toBe("image"); expect(input.args[3]).toBe("7000000");
      expect(input.maxOutputBytes).toBe(64_000); expect(input.timeoutMs).toBe(120_000);
      expect((await lstat(input.cwd!)).mode & 0o777).toBe(0o700);
      expect((await lstat(input.args[1]!)).mode & 0o777).toBe(0o600);
      expect((await readFile(input.args[1]!)).equals(original)).toBe(true);
      return undefined;
    });
    const result = await test.adapter.convert({ mimeType: "image/heic", bytes: original });
    expect(result).toMatchObject({ mimeType: "image/png", width: 96, height: 64 });
    expect(Buffer.from(result.bytes).equals(png())).toBe(true);
    expect(original.toString()).toContain("synthetic HEIC bytes");
    for (const directory of test.directories) await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["jpeg", "malformed", "oversize", "wrong header", "wrong permission", "missing", "private diagnostic", "throw"] as const)(
    "handles %s without retaining processing copies or exposing framework details", async (mode) => {
      const test = await fixture(async (input) => {
        if (mode === "throw") throw new Error("private-source-name.heic framework trace");
        if (mode === "private diagnostic") return { ok: true, format: "png", width: 96, height: 64, privatePath: "/private-source-name.heic" };
        if (mode === "malformed") return { ok: "private-source-name.heic" };
        if (mode === "missing") return { ok: true, format: "png", width: 96, height: 64 };
        const bytes = mode === "oversize" ? Buffer.alloc(7_000_001) : mode === "wrong header" ? Buffer.from("not PNG")
          : mode === "jpeg" ? Buffer.from([255, 216, 255, 224, 1, 2]) : png();
        await writeFile(input.args[2]!, bytes, { mode: 0o600 });
        if (mode === "wrong permission") await chmod(input.args[2]!, 0o644);
        return { ok: true, format: mode === "jpeg" ? "jpeg" : "png", width: 96, height: 64 };
      });
      const pending = test.adapter.convert({ mimeType: "image/heic", bytes: original });
      if (mode === "jpeg") await expect(pending).resolves.toMatchObject({ mimeType: "image/jpeg" });
      else {
        await expect(pending).rejects.toMatchObject({ code: "MEDIA_PROCESSING_FAILED" });
        await expect(pending).rejects.not.toThrow("private-source-name");
      }
      for (const directory of test.directories) await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("preserves the cancellation reason and cleans only after the process runner returns", async () => {
    const controller = new AbortController();
    const reason = new globalThis.DOMException("Synthetic cancellation", "AbortError");
    const test = await fixture(async (input) => {
      controller.abort(reason);
      expect(input.signal?.aborted).toBe(true);
      expect((await lstat(input.cwd!)).isDirectory()).toBe(true);
      return { ok: false, code: "MEDIA_PROCESSING_FAILED" };
    });
    await expect(test.adapter.convert({ mimeType: "image/heic", bytes: original }, controller.signal)).rejects.toBe(reason);
    for (const directory of test.directories) await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["unknown file", "symlink", "changed marker"] as const)("refuses destructive cleanup of %s", async (mode) => {
    const test = await fixture(async (input) => {
      if (mode === "unknown file") await writeFile(join(input.cwd!, "not-created-by-converter"), "synthetic");
      if (mode === "symlink") await symlink(input.args[1]!, input.args[2]!);
      if (mode === "changed marker") await writeFile(join(input.cwd!, "owner"), "changed");
      return { ok: false, code: "MODALITY_UNAVAILABLE" };
    });
    await expect(test.adapter.convert({ mimeType: "image/heic", bytes: original })).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
    expect((await lstat(test.directories[0]!)).isDirectory()).toBe(true);
  });

  it("rejects unsupported input, platform, and oversized sources before creating copies", async () => {
    const test = await fixture();
    await expect(test.adapter.convert({ mimeType: "image/png", bytes: original })).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
    await expect(test.adapter.convert({ mimeType: "image/heic", bytes: Buffer.alloc(20 * 1024 * 1024 + 1) })).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
    const unsupported = new MacNativeImageConverter({ executable: "/synthetic/helper", platform: "linux", runner: { run: test.run },
      createTemporaryDirectory: async () => { throw new Error("Must not create copies"); } });
    await expect(unsupported.convert({ mimeType: "image/heic", bytes: original })).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
    expect(test.directories).toEqual([]); expect(test.run).not.toHaveBeenCalled();
  });

  it("snapshots source bytes before asynchronous directory creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-image-snapshot-")); roots.push(root);
    const input = Buffer.from(original);
    const run = vi.fn(async (request: Parameters<ProcessRunnerPort["run"]>[0]) => {
      expect((await readFile(request.args[1]!)).equals(original)).toBe(true);
      await writeFile(request.args[2]!, png(), { mode: 0o600 });
      return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true, format: "png", width: 96, height: 64 })), stderr: Buffer.alloc(0) };
    });
    const adapter = new MacNativeImageConverter({ executable: "/synthetic/native-helper", platform: "darwin", runner: { run },
      createTemporaryDirectory: async (prefix) => { input.fill(0); return mkdtemp(join(root, prefix)); } });
    await expect(adapter.convert({ mimeType: "image/heic", bytes: input })).resolves.toMatchObject({ mimeType: "image/png" });
    expect(run).toHaveBeenCalledOnce();
  });
});
