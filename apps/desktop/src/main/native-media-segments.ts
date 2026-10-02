import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { NativeMediaSegmentInput, NativeMediaSegmentPort } from "@grudge-vault/application";
import { SafeProcessRunner, type ProcessRunnerPort } from "@grudge-vault/media-pipeline";
import { AppError } from "@grudge-vault/shared";

const MAX_SOURCE_BYTES = 500 * 1024 * 1024;
const OWNER_MARKER = "grudge-vault-native-media-segments-v1\n";
const MIME_EXTENSION = new Map([
  ["audio/mpeg", "mp3"], ["audio/mp4", "m4a"], ["audio/x-m4a", "m4a"],
  ["audio/wav", "wav"], ["audio/x-wav", "wav"], ["video/mp4", "mp4"], ["video/quicktime", "mov"]
]);
const probeSchema = z.object({
  ok: z.literal(true), durationMs: z.number().int().positive().safe(), hasAudio: z.boolean(), hasVideo: z.boolean(),
  pcmBytesPerSecond: z.number().positive().finite().optional()
}).strict();
const segmentSchema = z.object({ ok: z.literal(true), durationMs: z.number().int().positive().safe() }).strict();
const failureSchema = z.object({
  ok: z.literal(false), code: z.enum(["SEGMENT_TOO_LARGE", "MODALITY_UNAVAILABLE", "INVALID_INPUT", "MEDIA_PROCESSING_FAILED"])
}).strict();

export interface NativeMediaSegmenterOptions {
  executable: string;
  createTemporaryDirectory(prefix: string): Promise<string>;
  runner?: ProcessRunnerPort;
  platform?: string;
  maxSegmentBytes?: number;
  targetDurationMs?: number;
  maxSegments?: number;
}

/** Local bounded copies only: native decoder/exporter, no transcription or remote uploads. */
export class MacNativeMediaSegmenter implements NativeMediaSegmentPort {
  private readonly runner: ProcessRunnerPort;
  private readonly maxSegmentBytes: number;
  private readonly targetDurationMs: number;
  private readonly maxSegments: number;
  constructor(private readonly options: NativeMediaSegmenterOptions) {
    this.runner = options.runner ?? new SafeProcessRunner();
    this.maxSegmentBytes = options.maxSegmentBytes ?? 7_000_000;
    this.targetDurationMs = options.targetDurationMs ?? 120_000;
    this.maxSegments = options.maxSegments ?? 128;
    if (!isAbsolute(options.executable) || !Number.isSafeInteger(this.maxSegmentBytes) ||
      this.maxSegmentBytes < 64_000 || this.maxSegmentBytes > 7_000_000 ||
      !Number.isSafeInteger(this.targetDurationMs) || this.targetDurationMs < 1 || this.targetDurationMs > 120_000 ||
      !Number.isSafeInteger(this.maxSegments) || this.maxSegments < 1 || this.maxSegments > 128) {
      throw new AppError("INVALID_INPUT", "本机媒体分段配置无效。", false);
    }
  }

  async *segments(input: NativeMediaSegmentInput, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const suffix = MIME_EXTENSION.get(input.mimeType);
    if ((this.options.platform ?? process.platform) !== "darwin" || !suffix ||
      !input.mimeType.startsWith(`${input.kind}/`)) {
      throw new AppError("MODALITY_UNAVAILABLE", "当前环境或媒体格式未支持本机分段。", true);
    }
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0 || input.byteSize > MAX_SOURCE_BYTES ||
      !/^[a-f0-9]{64}$/.test(input.sha256)) {
      throw new AppError("INVALID_INPUT", "媒体大小或来源校验信息无效。", false);
    }
    const directory = await this.options.createTemporaryDirectory("native-media-");
    const identity = await this.assertPrivateDirectory(directory);
    if ((await readdir(directory)).length !== 0) throw new AppError("CLEANUP_FAILED", "媒体临时目录不是新的空目录。", false);
    await writeFile(join(directory, "owner"), OWNER_MARKER, { flag: "wx", mode: 0o600 });
    try {
      signal?.throwIfAborted();
      const source = join(directory, `source.${suffix}`);
      await this.copySource(input, source, signal);
      const probeReply = await this.run(["probe", source], directory, signal);
      const parsedProbe = probeSchema.safeParse(probeReply);
      if (!parsedProbe.success) this.rejectReply(probeReply);
      if (!parsedProbe.success) throw new AppError("MEDIA_PROCESSING_FAILED", "媒体时长读取失败。", true);
      const probe = parsedProbe.data;
      if (input.kind === "audio" && (!probe.hasAudio || probe.hasVideo || !probe.pcmBytesPerSecond) ||
        input.kind === "video" && !probe.hasVideo) {
        throw new AppError("MODALITY_UNAVAILABLE", "媒体轨道不符合当前分段能力。", true);
      }
      const span = input.kind === "audio"
        ? Math.min(this.targetDurationMs, Math.floor((this.maxSegmentBytes - 64_000) / probe.pcmBytesPerSecond! * 1_000))
        : this.targetDurationMs;
      if (span < 1 || Math.ceil(probe.durationMs / span) > this.maxSegments) {
        throw new AppError("MODALITY_UNAVAILABLE", "媒体超过本次分段处理上限，请缩短原件后重试。", true);
      }
      const output = join(directory, input.kind === "audio" ? "segment.wav" : "segment.mp4");
      let cursor = 0;
      let index = 0;
      while (cursor < probe.durationMs) {
        signal?.throwIfAborted();
        if (index >= this.maxSegments) throw new AppError("MODALITY_UNAVAILABLE", "媒体分段数量超过本次上限；未截断原件，请缩短后重试。", true);
        let end = Math.min(probe.durationMs, cursor + span);
        while (true) {
          const reply = await this.run(["segment", source, output, input.kind, String(cursor), String(end), String(this.maxSegmentBytes)], directory, signal);
          const failure = failureSchema.safeParse(reply);
          if (failure.success && failure.data.code === "SEGMENT_TOO_LARGE") {
            await this.removeOutput(output);
            const shorter = Math.floor((end - cursor) / 2);
            if (shorter < 1) throw new AppError("MODALITY_UNAVAILABLE", "媒体单帧或最小片段仍超过直传上限，无法完整处理。", true);
            end = cursor + shorter;
            continue;
          }
          const success = segmentSchema.safeParse(reply);
          if (!success.success) this.rejectReply(reply);
          if (!success.success) throw new AppError("MEDIA_PROCESSING_FAILED", "媒体分段导出失败。", true);
          const info = await lstat(output);
          if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > this.maxSegmentBytes ||
            Math.abs(success.data.durationMs - (end - cursor)) > 5) {
            throw new AppError("MEDIA_PROCESSING_FAILED", "媒体片段大小或时间覆盖核对失败；不会当作完整结果。", true);
          }
          signal?.throwIfAborted();
          const bytes = await readFile(output);
          if (bytes.length !== info.size) throw new AppError("SOURCE_UNAVAILABLE", "媒体片段在读取期间发生变化。", true);
          try {
            yield {
              index, startMs: cursor, endMs: end, sourceDurationMs: probe.durationMs,
              mimeType: input.kind === "audio" ? "audio/wav" as const : "video/mp4" as const,
              bytes: new Uint8Array(bytes)
            };
          } finally { await this.removeOutput(output); }
          index += 1;
          cursor = end;
          break;
        }
      }
    } finally {
      await this.cleanTemporaryDirectory(directory, identity);
    }
  }

  private async cleanTemporaryDirectory(directory: string, identity: { dev: number; ino: number }) {
    try {
      await this.assertPrivateDirectory(directory, identity);
      if (await readFile(join(directory, "owner"), "utf8") !== OWNER_MARKER) throw new Error("invalid marker");
      await rm(directory, { recursive: true, force: true });
    } catch (cause) {
      throw new AppError("CLEANUP_FAILED", "媒体处理副本清理失败，请先检查本机临时存储。", true, { cause });
    }
  }

  private async assertPrivateDirectory(directory: string, identity?: { dev: number; ino: number }) {
    const info = await lstat(directory);
    if (!isAbsolute(directory) || !/^native-media-[A-Za-z0-9]{6}$/.test(basename(directory)) ||
      !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
      identity && (info.dev !== identity.dev || info.ino !== identity.ino) ||
      process.getuid && info.uid !== process.getuid()) {
      throw new AppError("CLEANUP_FAILED", "媒体处理需要独立的私有临时目录。", false);
    }
    return { dev: info.dev, ino: info.ino };
  }

  private async copySource(input: NativeMediaSegmentInput, destination: string, signal?: AbortSignal) {
    let byteSize = 0;
    const digest = createHash("sha256");
    const check = new Transform({ transform(chunk: Buffer, _encoding, done) {
      byteSize += chunk.length;
      if (byteSize > input.byteSize || byteSize > MAX_SOURCE_BYTES) {
        done(new AppError("SOURCE_UNAVAILABLE", "媒体在处理前发生变化，请重新提供原件。", true));
        return;
      }
      digest.update(chunk); done(null, chunk);
    } });
    try {
      await pipeline(Readable.from(await input.open(signal)), check, createWriteStream(destination, { flags: "wx", mode: 0o600 }),
        ...(signal ? [{ signal }] : []));
      if (byteSize !== input.byteSize || digest.digest("hex") !== input.sha256) {
        throw new AppError("SOURCE_UNAVAILABLE", "媒体大小或摘要与所选来源不符，请重新提供原件。", true);
      }
    } catch (cause) {
      signal?.throwIfAborted();
      if (cause instanceof AppError) throw cause;
      throw new AppError("SOURCE_UNAVAILABLE", "无法准备所选媒体的处理副本。", true, { cause });
    }
  }

  private async run(args: string[], directory: string, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const result = await this.runner.run({
      executable: this.options.executable, args, cwd: directory, timeoutMs: 120_000,
      maxOutputBytes: 64_000, maxTemporaryBytes: MAX_SOURCE_BYTES + 64 * 1024 * 1024,
      ...(signal ? { signal } : {})
    });
    signal?.throwIfAborted();
    try {
      const reply: unknown = JSON.parse(result.stdout.toString("utf8"));
      if (result.exitCode === 0 || failureSchema.safeParse(reply).success) return reply;
    } catch { /* Fixed diagnostics only; helper output and stderr are never propagated. */ }
    throw new AppError("MEDIA_PROCESSING_FAILED", "本机媒体工具返回了无效结果。", true);
  }

  private rejectReply(reply: unknown): never {
    const failure = failureSchema.safeParse(reply);
    if (failure.success && failure.data.code === "MODALITY_UNAVAILABLE") {
      throw new AppError("MODALITY_UNAVAILABLE", "当前媒体编码、轨道或通道布局不支持完整分段。", true);
    }
    throw new AppError("MEDIA_PROCESSING_FAILED", "本机媒体分段未完成，请检查原件后重试。", true);
  }

  private async removeOutput(output: string) {
    try { await unlink(output); }
    catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause; }
  }
}
