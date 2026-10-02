import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeMediaSegment, NativeMediaSegmentInput } from "@grudge-vault/application";
import { SafeProcessRunner, type ProcessRunInput, type ProcessRunResult } from "@grudge-vault/media-pipeline";
import { MacNativeMediaSegmenter } from "./native-media-segments";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function response(value: unknown, exitCode = 0): ProcessRunResult {
  return { stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0), exitCode };
}
function source(bytes = Buffer.from("synthetic-media-content"), kind: "audio" | "video" = "audio"): NativeMediaSegmentInput {
  return {
    kind, mimeType: kind === "audio" ? "audio/wav" : "video/mp4", byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    async open() { return (async function* () { for (let offset = 0; offset < bytes.length; offset += 3) yield bytes.subarray(offset, offset + 3); })(); }
  };
}
async function collect(segmenter: MacNativeMediaSegmenter, input = source(), signal?: AbortSignal) {
  const result: NativeMediaSegment[] = [];
  for await (const segment of segmenter.segments(input, signal)) result.push(segment);
  return result;
}
async function setup(options: { durationMs?: number; maxSegments?: number; kind?: "audio" | "video";
  onRun?: (input: ProcessRunInput) => Promise<ProcessRunResult | undefined> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-native-contract-"));
  roots.push(root);
  const directories: string[] = [];
  const durationMs = options.durationMs ?? 270_012;
  const run = vi.fn(async (input: ProcessRunInput): Promise<ProcessRunResult> => {
    const override = await options.onRun?.(input);
    if (override) return override;
    if (input.args[0] === "probe") return response({
      ok: true, durationMs, hasAudio: true, hasVideo: options.kind === "video", pcmBytesPerSecond: 16_000
    });
    await writeFile(input.args[2]!, Buffer.from(`synthetic-${input.args[4]}-${input.args[5]}`), { mode: 0o600 });
    return response({ ok: true, durationMs: Number(input.args[5]) - Number(input.args[4]) });
  });
  const createTemporaryDirectory = vi.fn(async (prefix: string) => {
    const directory = await mkdtemp(join(root, prefix)); directories.push(directory); return directory;
  });
  const segmenter = new MacNativeMediaSegmenter({ executable: "/synthetic/grudge-vault-media", platform: "darwin",
    createTemporaryDirectory, runner: { run }, ...(options.maxSegments ? { maxSegments: options.maxSegments } : {}) });
  return { segmenter, run, root, directories, createTemporaryDirectory };
}

describe.skipIf(process.platform === "win32")("native media segmentation boundary (Unix private-file contract)", () => {
  it("streams an exact checked source and yields contiguous complete coverage in private copies", async () => {
    const input = source();
    const { segmenter, run, root, directories } = await setup({ onRun: async (call) => {
      expect((await lstat(call.cwd)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(call.cwd, "source.wav"))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(call.cwd, "source.wav"))).toEqual(Buffer.from("synthetic-media-content"));
      expect(call.executable).toBe("/synthetic/grudge-vault-media");
      expect(call.maxOutputBytes).toBe(64_000);
      expect(call.maxTemporaryBytes).toBeLessThan(600 * 1024 * 1024);
      return undefined;
    } });
    const result = await collect(segmenter, input);
    expect(result.map(({ index, startMs, endMs, sourceDurationMs, mimeType }) => ({ index, startMs, endMs, sourceDurationMs, mimeType })))
      .toEqual([
        { index: 0, startMs: 0, endMs: 120_000, sourceDurationMs: 270_012, mimeType: "audio/wav" },
        { index: 1, startMs: 120_000, endMs: 240_000, sourceDurationMs: 270_012, mimeType: "audio/wav" },
        { index: 2, startMs: 240_000, endMs: 270_012, sourceDurationMs: 270_012, mimeType: "audio/wav" }
      ]);
    expect(result.every(({ bytes }) => bytes.byteLength <= 7_000_000)).toBe(true);
    expect(run).toHaveBeenCalledTimes(4);
    expect(directories).toHaveLength(1);
    expect(await readdir(root)).toEqual([]);
  });

  it("halves oversized video ranges without skipping intervals or returning oversize bytes", async () => {
    const { segmenter, root, run } = await setup({ durationMs: 7001, kind: "video", onRun: async (call) => {
      if (call.args[0] !== "segment" || Number(call.args[5]) - Number(call.args[4]) <= 2000) return undefined;
      await writeFile(call.args[2]!, "synthetic-oversize-retry");
      return response({ ok: false, code: "SEGMENT_TOO_LARGE" }, 1);
    } });
    const result = await collect(segmenter, source(undefined, "video"));
    expect(result.length).toBeGreaterThan(3);
    expect(result[0]!.startMs).toBe(0);
    expect(result.at(-1)!.endMs).toBe(7001);
    expect(result.every(({ startMs, endMs, mimeType }, index) => endMs - startMs <= 2000 &&
      mimeType === "video/mp4" && (index === 0 || startMs === result[index - 1]!.endMs))).toBe(true);
    expect(run.mock.calls.filter(([call]) => call.args[0] === "segment").length).toBeGreaterThan(result.length);
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["size-short", "size-long", "digest"])("rejects changed source (%s) before a native or model call and cleans copies", async (change) => {
    const { segmenter, root, run } = await setup();
    const input = source();
    if (change === "size-short") input.byteSize += 1;
    if (change === "size-long") input.byteSize -= 1;
    if (change === "digest") input.sha256 = "0".repeat(64);
    await expect(collect(segmenter, input)).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["break", "throw"])("cleans copies when a consumer stops via %s", async (mode) => {
    const { segmenter, root, run } = await setup();
    const consume = async () => {
      for await (const segment of segmenter.segments(source())) {
        expect(segment.index).toBe(0);
        if (mode === "throw") throw new Error("synthetic downstream failure");
        break;
      }
    };
    if (mode === "throw") await expect(consume()).rejects.toThrow("synthetic downstream failure");
    else await consume();
    expect(run).toHaveBeenCalledTimes(2);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects a duration beyond the configured count before emitting a partial prefix", async () => {
    const { segmenter, run, root } = await setup({ maxSegments: 2 });
    await expect(collect(segmenter)).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["malformed", "duration", "oversize-file", "symlink"])("rejects untrusted helper output (%s) without private diagnostics", async (failure) => {
    const privateMessage = "synthetic-private-diary-and-path";
    const { segmenter, root } = await setup({ onRun: async (call) => {
      if (call.args[0] !== "segment") return undefined;
      if (failure === "malformed") return { stdout: Buffer.from(privateMessage), stderr: Buffer.from(privateMessage), exitCode: 1 };
      if (failure === "symlink") await symlink(join(call.cwd, "source.wav"), call.args[2]!);
      else await writeFile(call.args[2]!, Buffer.alloc(failure === "oversize-file" ? 7_000_001 : 100));
      return response({ ok: true, durationMs: Number(call.args[5]) - Number(call.args[4]) + (failure === "duration" ? 100 : 0) });
    } });
    await expect(collect(segmenter)).rejects.toMatchObject({ code: "MEDIA_PROCESSING_FAILED" });
    await expect(collect(segmenter)).rejects.not.toThrow(privateMessage);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses helper-declared unsupported tracks and masks framework messages", async () => {
    const { segmenter, root } = await setup({ onRun: async () => response({ ok: false, code: "MODALITY_UNAVAILABLE" }, 1) });
    await expect(collect(segmenter)).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
    expect(await readdir(root)).toEqual([]);
  });

  it("does not create processing copies for unsupported platforms or over-limit inputs", async () => {
    const { createTemporaryDirectory, segmenter } = await setup();
    await expect(collect(segmenter, { ...source(), byteSize: 500 * 1024 * 1024 + 1 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const unavailable = new MacNativeMediaSegmenter({ executable: "/synthetic/helper", platform: "linux", createTemporaryDirectory });
    await expect(collect(unavailable)).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
    expect(createTemporaryDirectory).not.toHaveBeenCalled();
  });

  it("does not remove a supplied non-private directory or its neighboring files", async () => {
    const { directories, root } = await setup();
    const directory = await mkdtemp(join(root, "native-media-")); directories.push(directory);
    await chmod(directory, 0o755);
    await writeFile(join(directory, "keep"), "synthetic unrelated content");
    const segmenter = new MacNativeMediaSegmenter({ executable: "/synthetic/helper", platform: "darwin", createTemporaryDirectory: async () => directory });
    await expect(collect(segmenter)).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
    expect(await readFile(join(directory, "keep"), "utf8")).toBe("synthetic unrelated content");
  });

  it("reports cleanup failure without deleting a replaced ownership marker", async () => {
    const { segmenter, root, directories } = await setup({ onRun: async (call) => {
      await writeFile(join(call.cwd, "owner"), "synthetic unknown owner");
      return response({ ok: false, code: "MODALITY_UNAVAILABLE" }, 1);
    } });
    await expect(collect(segmenter)).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
    expect(await readFile(join(directories[0]!, "owner"), "utf8")).toBe("synthetic unknown owner");
    expect(await readdir(root)).toHaveLength(1);
  });

  it("refuses to remove a replacement directory even when its permissions and ownership marker match", async () => {
    const { segmenter, directories } = await setup({ onRun: async (call) => {
      const marker = await readFile(join(call.cwd, "owner"));
      await rename(call.cwd, `${call.cwd}-original`);
      await mkdir(call.cwd, { mode: 0o700 });
      await writeFile(join(call.cwd, "owner"), marker, { mode: 0o600 });
      await writeFile(join(call.cwd, "keep"), "synthetic replacement must remain", { mode: 0o600 });
      return response({ ok: false, code: "MODALITY_UNAVAILABLE" }, 1);
    } });
    await expect(collect(segmenter)).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
    expect(await readFile(join(directories[0]!, "keep"), "utf8")).toBe("synthetic replacement must remain");
    expect(await readFile(join(`${directories[0]}-original`, "source.wav"), "utf8")).toBe("synthetic-media-content");
  });

  it("waits for a cancelled native process to exit before cleaning its directory", async () => {
    const controller = new AbortController();
    const runner = new SafeProcessRunner();
    const { segmenter, root, directories } = await setup({ onRun: async (call) => {
      if (call.args[0] !== "segment") return undefined;
      return runner.run({ ...call, executable: process.execPath, args: ["-e", [
        "process.on('SIGTERM', () => {});",
        "require('fs').writeFileSync('started', String(process.pid));",
        "setInterval(() => {}, 1000);"
      ].join("\n")] });
    } });
    const pending = collect(segmenter, source(), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "MEDIA_PROCESSING_FAILED" });
    let pid = 0;
    await vi.waitFor(async () => { pid = Number(await readFile(join(directories[0]!, "started"), "utf8")); expect(pid).toBeGreaterThan(0); });
    controller.abort();
    await rejected;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await readdir(root)).toEqual([]);
  }, 10_000);
});
