import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { NativeImageConversionPort, NativeImageRepresentation } from "@grudge-vault/application";
import { SafeProcessRunner, type ProcessRunnerPort } from "@grudge-vault/media-pipeline";
import { AppError } from "@grudge-vault/shared";

const MARKER = "grudge-vault-native-image-v1\n";
const resultSchema = z.object({ ok: z.literal(true), format: z.enum(["png", "jpeg"]),
  width: z.number().int().positive().max(50_000), height: z.number().int().positive().max(50_000)
}).strict();
const failureSchema = z.object({ ok: z.literal(false), code: z.enum([
  "SEGMENT_TOO_LARGE", "MODALITY_UNAVAILABLE", "INVALID_INPUT", "MEDIA_PROCESSING_FAILED"
]) }).strict();

export class MacNativeImageConverter implements NativeImageConversionPort {
  private readonly runner: ProcessRunnerPort;
  private readonly maxOutputBytes: number;
  constructor(private readonly options: {
    executable: string; createTemporaryDirectory(prefix: string): Promise<string>;
    runner?: ProcessRunnerPort; platform?: string; maxOutputBytes?: number;
  }) {
    this.runner = options.runner ?? new SafeProcessRunner();
    this.maxOutputBytes = options.maxOutputBytes ?? 7_000_000;
    if (!isAbsolute(options.executable) || !Number.isSafeInteger(this.maxOutputBytes) ||
      this.maxOutputBytes < 1024 || this.maxOutputBytes > 7_000_000) throw new AppError("INVALID_INPUT", "本机图片转换配置无效。");
  }

  async convert(input: { mimeType: string; bytes: Uint8Array }, signal?: AbortSignal): Promise<NativeImageRepresentation> {
    signal?.throwIfAborted();
    if ((this.options.platform ?? process.platform) !== "darwin" || !["image/heic", "image/heif"].includes(input.mimeType)) {
      throw new AppError("MODALITY_UNAVAILABLE", "当前环境或图片格式未支持本机转换。", true);
    }
    if (!(input.bytes instanceof Uint8Array) || !input.bytes.length || input.bytes.length > 20 * 1024 * 1024) {
      throw new AppError("MODALITY_UNAVAILABLE", "HEIC 超过当前本机转换输入上限。", true);
    }
    const bytes = Buffer.from(input.bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const directory = await this.options.createTemporaryDirectory("native-image-");
    const identity = await this.assertDirectory(directory);
    if ((await readdir(directory)).length) throw new AppError("CLEANUP_FAILED", "图片临时目录不是新的空目录。");
    await writeFile(join(directory, "owner"), MARKER, { flag: "wx", mode: 0o600 });
    try {
      signal?.throwIfAborted();
      const source = join(directory, "source.heic"), output = join(directory, "converted.image");
      await writeFile(source, bytes, { flag: "wx", mode: 0o600, ...(signal ? { signal } : {}) });
      if (createHash("sha256").update(await readFile(source)).digest("hex") !== digest) {
        throw new AppError("SOURCE_UNAVAILABLE", "图片转换副本校验失败。", true);
      }
      const run = await this.runner.run({ executable: this.options.executable,
        args: ["image", source, output, String(this.maxOutputBytes)], cwd: directory, timeoutMs: 120_000,
        maxOutputBytes: 64_000, maxTemporaryBytes: 20 * 1024 * 1024 + this.maxOutputBytes + 64_000,
        ...(signal ? { signal } : {}) });
      signal?.throwIfAborted();
      let raw: unknown;
      try { raw = JSON.parse(run.stdout.toString("utf8")); } catch { /* Never propagate framework diagnostics. */ }
      const failure = failureSchema.safeParse(raw);
      if (failure.success && ["SEGMENT_TOO_LARGE", "MODALITY_UNAVAILABLE"].includes(failure.data.code)) {
        throw new AppError("MODALITY_UNAVAILABLE", "图片超出当前单张 SDR 转换能力或输出限制；未缩小、截取或改写原件。", true);
      }
      const result = resultSchema.safeParse(raw);
      if (run.exitCode !== 0 || !result.success || result.data.width * result.data.height > 50_000_000) {
        throw new AppError("MEDIA_PROCESSING_FAILED", "本机图片转换未完成，请检查原件后重试。", true);
      }
      const info = await lstat(output);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size <= 0 || info.size > this.maxOutputBytes) {
        throw new AppError("MEDIA_PROCESSING_FAILED", "图片转换副本大小或权限核对失败。", true);
      }
      const converted = await readFile(output);
      const after = await lstat(output);
      const validHeader = result.data.format === "png"
        ? converted.length >= 24 && converted.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
          converted.toString("ascii", 12, 16) === "IHDR" && converted.readUInt32BE(16) === result.data.width && converted.readUInt32BE(20) === result.data.height
        : converted.length >= 4 && converted[0] === 0xff && converted[1] === 0xd8 && converted[2] === 0xff;
      if (converted.length !== info.size || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || !validHeader) {
        throw new AppError("MEDIA_PROCESSING_FAILED", "图片转换副本在读取期间变化或格式核对失败。", true);
      }
      signal?.throwIfAborted();
      return { mimeType: result.data.format === "png" ? "image/png" : "image/jpeg", bytes: new Uint8Array(converted),
        width: result.data.width, height: result.data.height };
    } catch (cause) {
      signal?.throwIfAborted();
      if (cause instanceof AppError) throw cause;
      throw new AppError("MEDIA_PROCESSING_FAILED", "本机图片转换未完成，请检查原件后重试。", true, { cause });
    } finally {
      await this.cleanDirectory(directory, identity);
    }
  }

  private async cleanDirectory(directory: string, identity: { dev: number; ino: number }) {
    try {
      await this.assertDirectory(directory, identity);
      if (await readFile(join(directory, "owner"), "utf8") !== MARKER) throw new Error("Invalid owner marker");
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.some((entry) => !["owner", "source.heic", "converted.image"].includes(entry.name) || !entry.isFile() || entry.isSymbolicLink())) {
        throw new Error("Unexpected conversion directory entries");
      }
      await rm(directory, { recursive: true, force: true });
    } catch (cause) {
      throw new AppError("CLEANUP_FAILED", "图片处理副本清理失败，请先检查本机临时存储。", true, { cause });
    }
  }

  private async assertDirectory(directory: string, identity?: { dev: number; ino: number }) {
    const info = await lstat(directory);
    if (!isAbsolute(directory) || !/^native-image-[A-Za-z0-9]{6}$/.test(basename(directory)) || !info.isDirectory() ||
      info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || process.getuid && info.uid !== process.getuid() ||
      identity && (info.dev !== identity.dev || info.ino !== identity.ino)) {
      throw new AppError("CLEANUP_FAILED", "图片处理需要独立私有临时目录。");
    }
    return { dev: info.dev, ino: info.ino };
  }
}
