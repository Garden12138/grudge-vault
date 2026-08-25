import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";
import type {
  LocalProcessorStatus, MediaProcessingSettings, OcrArtifactV1, OcrPageV1, OcrWordV1,
  ProcessorCapability, TranscriptArtifactV1, TranscriptSegmentV1
} from "@grudge-vault/domain";
import {
  DEFAULT_MEDIA_PROCESSING_SETTINGS, type MediaPipelinePort, type MediaPipelineProcessResult
} from "@grudge-vault/application";
import { AppError, type LocalProcessorPathKind } from "@grudge-vault/shared";

export interface ProcessRunInput {
  executable: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  maxTemporaryBytes?: number;
}

export interface ProcessRunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface ProcessRunnerPort {
  run(input: ProcessRunInput): Promise<ProcessRunResult>;
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
}

async function directoryByteSize(path: string, stopAfter: number): Promise<number> {
  let total = 0;
  const pending = [path];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) {
        total += (await stat(child)).size;
        if (total > stopAfter) return total;
      }
    }
  }
  return total;
}

export class SafeProcessRunner implements ProcessRunnerPort {
  run(input: ProcessRunInput): Promise<ProcessRunResult> {
    if (!isAbsolute(input.executable)) {
      return Promise.reject(new AppError("LOCAL_PROCESSOR_UNAVAILABLE", "Local processor paths must be absolute."));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let temporarySpaceTimer: NodeJS.Timeout | undefined;
      let checkingTemporarySpace = false;
      let terminationError: Error | undefined;
      let outputBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const child = spawn(input.executable, input.args, {
        cwd: input.cwd, shell: false, windowsHide: true, env: minimalEnvironment(), stdio: ["ignore", "pipe", "pipe"]
      });
      const finish = (error?: Error, exitCode = -1) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (temporarySpaceTimer) clearInterval(temporarySpaceTimer);
        input.signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode });
      };
      const terminate = (error: Error) => {
        if (settled || terminationError) return;
        terminationError = error;
        child.kill();
        forceKillTimer = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 2_000);
        forceKillTimer.unref();
      };
      const append = (target: Buffer[], chunk: Buffer) => {
        if (terminationError) return;
        outputBytes += chunk.length;
        if (outputBytes > input.maxOutputBytes) {
          terminate(new AppError("MEDIA_PROCESSING_FAILED", "The local processor produced too much output."));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
      child.on("error", (error) => finish(new AppError("LOCAL_PROCESSOR_UNAVAILABLE", "The local processor could not be started.", false, { cause: error })));
      child.on("close", (code) => finish(terminationError, code ?? -1));
      const abort = () => {
        terminate(new AppError("MEDIA_PROCESSING_FAILED", "Media processing was cancelled.", true));
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
      timer = setTimeout(() => {
        terminate(new AppError("MEDIA_PROCESSING_FAILED", "The local processor timed out.", true));
      }, input.timeoutMs);
      timer.unref();
      if (input.maxTemporaryBytes !== undefined) {
        temporarySpaceTimer = setInterval(() => {
          if (checkingTemporarySpace || settled) return;
          checkingTemporarySpace = true;
          void directoryByteSize(input.cwd, input.maxTemporaryBytes!).then((size) => {
            if (size > input.maxTemporaryBytes! && !settled) {
              terminate(new AppError("MEDIA_PROCESSING_FAILED", "The local processor exceeded the temporary-space limit."));
            }
          }, () => undefined).finally(() => { checkingTemporarySpace = false; });
        }, 500);
        temporarySpaceTimer.unref();
      }
    });
  }
}

export interface LocalIntelligenceConfiguration {
  formatVersion: 1;
  paths: Partial<Record<LocalProcessorPathKind | "pdfinfo" | "ffprobe", string>>;
  settings: MediaProcessingSettings;
}

export const DEFAULT_LOCAL_INTELLIGENCE_CONFIGURATION: LocalIntelligenceConfiguration = {
  formatVersion: 1, paths: {}, settings: DEFAULT_MEDIA_PROCESSING_SETTINGS
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function text(buffer: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function successful(result: ProcessRunResult, label: string): ProcessRunResult {
  if (result.exitCode !== 0) throw new AppError("MEDIA_PROCESSING_FAILED", `${label} failed with exit code ${result.exitCode}.`, true);
  return result;
}

function executableSibling(path: string, name: string): string {
  const extension = extname(path).toLowerCase() === ".exe" ? ".exe" : "";
  return join(dirname(path), `${name}${extension}`);
}

async function regularFile(path: string | undefined): Promise<boolean> {
  if (!path || !isAbsolute(path)) return false;
  return stat(path).then((value) => value.isFile(), () => false);
}

export function parseTesseractTsvPages(value: string, firstPage = 1): OcrPageV1[] {
  const lines = value.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (!lines[0]?.startsWith("level\tpage_num\tblock_num")) {
    throw new AppError("MEDIA_PROCESSING_FAILED", "Tesseract returned an invalid TSV document.");
  }
  const pages = new Map<number, OcrWordV1[]>();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    if (fields.length < 12) continue;
    const rawPage = Number(fields[1]);
    if (!Number.isInteger(rawPage) || rawPage < 1) continue;
    const page = firstPage + rawPage - 1;
    const words = pages.get(page) ?? [];
    pages.set(page, words);
    if (fields[0] !== "5") continue;
    const word = fields.slice(11).join("\t").trim();
    if (!word) continue;
    const confidence = Number(fields[10]);
    const coordinates = fields.slice(6, 10).map(Number);
    if (coordinates.some((item) => !Number.isFinite(item) || item < 0)) continue;
    words.push({
      text: word, ...(Number.isFinite(confidence) && confidence >= 0 ? { confidence } : {}),
      left: coordinates[0]!, top: coordinates[1]!, width: coordinates[2]!, height: coordinates[3]!
    });
  }
  if (!pages.size) pages.set(firstPage, []);
  return [...pages.entries()].sort(([left], [right]) => left - right)
    .map(([page, words]) => ({ page, text: words.map(({ text: word }) => word).join(" "), words }));
}

export function parseTesseractTsv(value: string, page = 1): OcrPageV1 {
  return parseTesseractTsvPages(value, page)[0]!;
}

function milliseconds(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value !== "string") return 0;
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value);
  if (!match) return 0;
  return (((Number(match[1]) * 60 + Number(match[2])) * 60) + Number(match[3])) * 1000 + Number(match[4]);
}

export function parseWhisperJson(value: string): { language: string; text: string; segments: TranscriptSegmentV1[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch (cause) { throw new AppError("MEDIA_PROCESSING_FAILED", "whisper.cpp returned invalid JSON.", false, { cause }); }
  const object = parsed as { result?: { language?: unknown }; transcription?: unknown[] };
  if (!Array.isArray(object.transcription)) throw new AppError("MEDIA_PROCESSING_FAILED", "whisper.cpp returned no transcription segments.");
  const segments = object.transcription.map((raw): TranscriptSegmentV1 => {
    const item = raw as { text?: unknown; offsets?: { from?: unknown; to?: unknown }; timestamps?: { from?: unknown; to?: unknown } };
    const startMs = milliseconds(item.offsets?.from ?? item.timestamps?.from);
    const endMs = milliseconds(item.offsets?.to ?? item.timestamps?.to);
    if (typeof item.text !== "string" || endMs < startMs) {
      throw new AppError("MEDIA_PROCESSING_FAILED", "whisper.cpp returned an invalid timestamped segment.");
    }
    return { startMs, endMs, text: item.text.trim() };
  }).filter(({ text }) => Boolean(text));
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index]!.startMs < segments[index - 1]!.startMs) {
      throw new AppError("MEDIA_PROCESSING_FAILED", "whisper.cpp returned non-monotonic timestamps.");
    }
  }
  return {
    language: typeof object.result?.language === "string" ? object.result.language : "unknown",
    text: segments.map(({ text: segment }) => segment).join(" "), segments
  };
}

function threads(settings: MediaProcessingSettings): number {
  const cores = availableParallelism();
  if (settings.resourceProfile === "conservative") return Math.max(1, Math.min(2, Math.floor(cores / 2)));
  if (settings.resourceProfile === "performance") return Math.max(1, Math.min(16, cores - 1));
  return Math.max(1, Math.min(8, Math.floor(cores / 2)));
}

function temporarySpaceLimit(settings: MediaProcessingSettings): number {
  if (settings.resourceProfile === "conservative") return 2 * 1024 ** 3;
  if (settings.resourceProfile === "performance") return 16 * 1024 ** 3;
  return 8 * 1024 ** 3;
}

const OCR_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/tiff", "image/bmp", "application/pdf"]);
const ASR_MIME_TYPES = new Set([
  "audio/mpeg", "audio/mp4", "video/mp4", "audio/wav", "audio/x-wav", "audio/ogg",
  "audio/webm", "video/webm", "audio/flac", "audio/x-flac"
]);
const OCR_PROCESSOR_IDENTITY = "local.tesseract-poppler";
const ASR_PROCESSOR_IDENTITY = "local.whisper-cpp";
const MEDIA_PROCESSOR_VERSION = 1;

export class LocalMediaPipeline implements MediaPipelinePort {
  private configuration: LocalIntelligenceConfiguration;
  private cachedStatus: LocalProcessorStatus | undefined;

  constructor(
    configuration: LocalIntelligenceConfiguration = DEFAULT_LOCAL_INTELLIGENCE_CONFIGURATION,
    private readonly saveConfiguration: (value: LocalIntelligenceConfiguration) => Promise<void> = async () => undefined,
    private readonly runner: ProcessRunnerPort = new SafeProcessRunner()
  ) {
    this.configuration = {
      formatVersion: 1, paths: { ...configuration.paths },
      settings: { ...DEFAULT_MEDIA_PROCESSING_SETTINGS, ...configuration.settings }
    };
  }

  getConfiguration(): LocalIntelligenceConfiguration { return this.configuration; }
  getSettings(): MediaProcessingSettings { return this.configuration.settings; }

  async setPath(kind: LocalProcessorPathKind, path: string): Promise<LocalProcessorStatus> {
    if (!isAbsolute(path) || !(await regularFile(path))) {
      throw new AppError("LOCAL_PROCESSOR_UNAVAILABLE", "Choose a regular local executable or model file.");
    }
    const paths = { ...this.configuration.paths, [kind]: path };
    if (kind === "poppler") paths.pdfinfo = executableSibling(path, "pdfinfo");
    if (kind === "ffmpeg") paths.ffprobe = executableSibling(path, "ffprobe");
    this.configuration = { ...this.configuration, paths };
    this.cachedStatus = undefined;
    await this.saveConfiguration(this.configuration);
    return this.probe();
  }

  async updateSettings(settings: MediaProcessingSettings): Promise<LocalProcessorStatus> {
    this.configuration = { ...this.configuration, settings };
    this.cachedStatus = undefined;
    await this.saveConfiguration(this.configuration);
    return this.probe();
  }

  async getStatus(): Promise<LocalProcessorStatus> { return this.cachedStatus ?? this.probe(); }

  async probe(): Promise<LocalProcessorStatus> {
    const paths = this.configuration.paths;
    const ocr = await this.probeOcr(paths);
    const asr = await this.probeAsr(paths);
    const status: LocalProcessorStatus = {
      settings: this.configuration.settings, ocr, asr, eligibleHistoricalAssets: 0, pendingJobs: 0
    };
    this.cachedStatus = status;
    return status;
  }

  kindFor(asset: { mimeType: string }): "ocr" | "transcript" | undefined {
    if (OCR_MIME_TYPES.has(asset.mimeType)) return "ocr";
    if (ASR_MIME_TYPES.has(asset.mimeType)) return "transcript";
    return undefined;
  }

  async fingerprint(asset: Parameters<MediaPipelinePort["fingerprint"]>[0]) {
    const status = await this.getStatus();
    const kind = this.kindFor(asset);
    if (!kind || !(kind === "ocr" ? status.ocr.available : status.asr.available)) {
      throw new AppError("LOCAL_PROCESSOR_UNAVAILABLE", "No healthy local processor is configured for this asset.");
    }
    if (kind === "ocr") {
      const engineVersions = { ocrStack: status.ocr.version ?? "unknown" };
      const configHash = sha256(JSON.stringify({ processorIdentity: OCR_PROCESSOR_IDENTITY,
        processorVersion: MEDIA_PROCESSOR_VERSION, settings: this.configuration.settings, engineVersions }));
      return { kind, processorIdentity: OCR_PROCESSOR_IDENTITY, processorVersion: MEDIA_PROCESSOR_VERSION, configHash,
        inputHash: sha256(JSON.stringify({ source: asset.sha256, kind, configHash })) };
    }
    const modelSha256 = await hashFile(this.configuration.paths.whisper_model!);
    const engineVersions = { whisper: status.asr.version ?? "unknown", ffmpeg: status.asr.version ?? "unknown" };
    const configHash = sha256(JSON.stringify({ processorIdentity: ASR_PROCESSOR_IDENTITY,
      processorVersion: MEDIA_PROCESSOR_VERSION, settings: this.configuration.settings, engineVersions, modelSha256 }));
    return { kind, processorIdentity: ASR_PROCESSOR_IDENTITY, processorVersion: MEDIA_PROCESSOR_VERSION, configHash,
      inputHash: sha256(JSON.stringify({ source: asset.sha256, kind, configHash })) };
  }

  async process(input: Parameters<MediaPipelinePort["process"]>[0]): Promise<MediaPipelineProcessResult> {
    const status = await this.getStatus();
    const kind = this.kindFor(input.asset);
    if (!kind || !(kind === "ocr" ? status.ocr.available : status.asr.available)) {
      throw new AppError("LOCAL_PROCESSOR_UNAVAILABLE", "No healthy local processor is configured for this asset.");
    }
    return kind === "ocr" ? this.processOcr(input, status) : this.processAsr(input, status);
  }

  private async probeOcr(paths: LocalIntelligenceConfiguration["paths"]): Promise<ProcessorCapability> {
    const displayNames = [paths.tesseract, paths.poppler, paths.pdfinfo].filter(Boolean).map((item) => basename(item!));
    if (!(await regularFile(paths.tesseract)) || !(await regularFile(paths.poppler)) || !(await regularFile(paths.pdfinfo))) {
      return { configured: displayNames.length > 0, available: false, displayNames, warnings: ["Tesseract, pdftoppm, and pdfinfo are required."] };
    }
    try {
      const [version, languages, poppler, pdfinfo] = await Promise.all([
        this.runProbe(paths.tesseract!, ["--version"]), this.runProbe(paths.tesseract!, ["--list-langs"]),
        this.runProbe(paths.poppler!, ["-v"]), this.runProbe(paths.pdfinfo!, ["-v"])
      ]);
      const values = text(languages.stdout.length ? languages.stdout : languages.stderr).split(/\r?\n/).slice(1).map((item) => item.trim()).filter(Boolean);
      const selectedMissing = this.configuration.settings.ocrLanguages.filter((item) => !values.includes(item));
      const tesseractVersion = text(version.stdout.length ? version.stdout : version.stderr).split(/\r?\n/)[0]?.trim() ?? "tesseract unknown";
      const popplerVersion = text(poppler.stdout.length ? poppler.stdout : poppler.stderr).split(/\r?\n/)[0]?.trim() ?? "poppler unknown";
      const versionText = `${tesseractVersion}; ${popplerVersion}`;
      return {
        configured: true, available: selectedMissing.length === 0 && version.exitCode === 0
          && languages.exitCode === 0 && poppler.exitCode === 0 && pdfinfo.exitCode === 0,
        identity: OCR_PROCESSOR_IDENTITY, ...(versionText ? { version: versionText } : {}),
        languages: values, displayNames, warnings: [
          ...(selectedMissing.length ? [`Missing OCR languages: ${selectedMissing.join(", ")}`] : []),
          ...(poppler.exitCode === 0 && pdfinfo.exitCode === 0 ? [] : ["Poppler capability probe failed."])
        ]
      };
    } catch {
      return { configured: true, available: false, displayNames, warnings: ["OCR capability probe failed."] };
    }
  }

  private async probeAsr(paths: LocalIntelligenceConfiguration["paths"]): Promise<ProcessorCapability> {
    const displayNames = [paths.ffmpeg, paths.ffprobe, paths.whisper, paths.whisper_model].filter(Boolean).map((item) => basename(item!));
    if (!(await regularFile(paths.ffmpeg)) || !(await regularFile(paths.ffprobe)) || !(await regularFile(paths.whisper)) || !(await regularFile(paths.whisper_model))) {
      return { configured: displayNames.length > 0, available: false, displayNames, warnings: ["FFmpeg, ffprobe, whisper-cli, and a Whisper model are required."] };
    }
    try {
      const [ffmpeg, ffprobe, whisper] = await Promise.all([
        this.runProbe(paths.ffmpeg!, ["-version"]), this.runProbe(paths.ffprobe!, ["-version"]),
        this.runProbe(paths.whisper!, ["--help"])
      ]);
      const help = text(Buffer.concat([whisper.stdout, whisper.stderr]));
      const available = ffmpeg.exitCode === 0 && ffprobe.exitCode === 0 && whisper.exitCode === 0
        && help.includes("output-json-full") && help.includes("--model");
      const ffmpegVersion = text(ffmpeg.stdout).split(/\r?\n/)[0]?.trim() ?? "ffmpeg unknown";
      const whisperVersion = help.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? `whisper-cli ${sha256(help).slice(0, 12)}`;
      const versionText = `${ffmpegVersion}; ${whisperVersion}`;
      return {
        configured: true, available, identity: ASR_PROCESSOR_IDENTITY, ...(versionText ? { version: versionText } : {}),
        displayNames, warnings: available ? [] : ["whisper-cli does not expose the required JSON output flags."]
      };
    } catch {
      return { configured: true, available: false, displayNames, warnings: ["ASR capability probe failed."] };
    }
  }

  private runProbe(executable: string, args: string[]): Promise<ProcessRunResult> {
    return this.runner.run({ executable, args, cwd: dirname(executable), timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 });
  }

  private async processOcr(
    input: Parameters<MediaPipelinePort["process"]>[0], status: LocalProcessorStatus
  ): Promise<MediaPipelineProcessResult> {
    const paths = this.configuration.paths;
    const settings = this.configuration.settings;
    const engineVersions = { ocrStack: status.ocr.version ?? "unknown" };
    const configHash = sha256(JSON.stringify({ processorIdentity: OCR_PROCESSOR_IDENTITY,
      processorVersion: MEDIA_PROCESSOR_VERSION, settings, engineVersions }));
    const inputHash = sha256(JSON.stringify({ source: input.asset.sha256, kind: "ocr", configHash }));
    const pages: OcrPageV1[] = [];
    if (input.asset.mimeType === "application/pdf") {
      const info = successful(await this.runner.run({
        executable: paths.pdfinfo!, args: [input.inputPath], cwd: input.temporaryDirectory,
        signal: input.signal, timeoutMs: 60_000, maxOutputBytes: 1024 * 1024,
        maxTemporaryBytes: temporarySpaceLimit(settings)
      }), "pdfinfo");
      const count = Number(/^Pages:\s+(\d+)/m.exec(text(info.stdout))?.[1]);
      if (!Number.isInteger(count) || count < 1 || count > 500) throw new AppError("MEDIA_PROCESSING_FAILED", "The PDF page count is invalid or exceeds 500 pages.");
      for (let page = 1; page <= count; page += 1) {
        const prefix = join(input.temporaryDirectory, `page-${String(page).padStart(4, "0")}`);
        successful(await this.runner.run({
          executable: paths.poppler!, args: ["-f", String(page), "-l", String(page), "-singlefile", "-png", "-r", "200", input.inputPath, prefix],
          cwd: input.temporaryDirectory, signal: input.signal, timeoutMs: 10 * 60_000, maxOutputBytes: 2 * 1024 * 1024,
          maxTemporaryBytes: temporarySpaceLimit(settings)
        }), "pdftoppm");
        pages.push(...await this.ocrImage(`${prefix}.png`, page, input));
        input.reportProgress(page / count * 0.9);
      }
    } else {
      pages.push(...await this.ocrImage(input.inputPath, 1, input));
      input.reportProgress(0.9);
    }
    const createdAt = new Date().toISOString();
    const payload: OcrArtifactV1 = {
      formatVersion: 1, kind: "ocr", sourceAssetId: input.asset.id, sourceSha256: input.asset.sha256,
      language: settings.ocrLanguages.join("+"), processorIdentity: OCR_PROCESSOR_IDENTITY, processorVersion: MEDIA_PROCESSOR_VERSION,
      engineVersions, configHash, text: pages.map(({ text: pageText }) => pageText).join("\n\f\n"), pages, createdAt
    };
    return { kind: "ocr", payload, processorIdentity: payload.processorIdentity, processorVersion: MEDIA_PROCESSOR_VERSION, configHash, inputHash };
  }

  private async ocrImage(
    imagePath: string, page: number, input: Parameters<MediaPipelinePort["process"]>[0]
  ): Promise<OcrPageV1[]> {
    const result = successful(await this.runner.run({
      executable: this.configuration.paths.tesseract!,
      args: [imagePath, "stdout", "-l", this.configuration.settings.ocrLanguages.join("+"), "tsv"],
      cwd: input.temporaryDirectory, signal: input.signal, timeoutMs: 30 * 60_000, maxOutputBytes: 16 * 1024 * 1024,
      maxTemporaryBytes: temporarySpaceLimit(this.configuration.settings)
    }), "Tesseract");
    return parseTesseractTsvPages(text(result.stdout), page);
  }

  private async processAsr(
    input: Parameters<MediaPipelinePort["process"]>[0], status: LocalProcessorStatus
  ): Promise<MediaPipelineProcessResult> {
    const paths = this.configuration.paths;
    const wav = join(input.temporaryDirectory, "audio.wav");
    const mediaInfo = successful(await this.runner.run({
      executable: paths.ffprobe!, args: ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input.inputPath],
      cwd: input.temporaryDirectory, signal: input.signal, timeoutMs: 60_000, maxOutputBytes: 1024 * 1024,
      maxTemporaryBytes: temporarySpaceLimit(this.configuration.settings)
    }), "ffprobe");
    const durationSeconds = Number(text(mediaInfo.stdout).trim());
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0
      || input.asset.byteSize + durationSeconds * 32_000 > temporarySpaceLimit(this.configuration.settings)) {
      throw new AppError("MEDIA_PROCESSING_FAILED", "The audio duration is invalid or exceeds the temporary-space limit.");
    }
    successful(await this.runner.run({
      executable: paths.ffmpeg!, args: ["-nostdin", "-v", "error", "-y", "-i", input.inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
      cwd: input.temporaryDirectory, signal: input.signal, timeoutMs: 4 * 60 * 60_000, maxOutputBytes: 2 * 1024 * 1024,
      maxTemporaryBytes: temporarySpaceLimit(this.configuration.settings)
    }), "FFmpeg");
    input.reportProgress(0.1);
    const modelSha256 = await hashFile(paths.whisper_model!);
    const engineVersions = { whisper: status.asr.version ?? "unknown", ffmpeg: status.asr.version ?? "unknown" };
    const configHash = sha256(JSON.stringify({ processorIdentity: ASR_PROCESSOR_IDENTITY,
      processorVersion: MEDIA_PROCESSOR_VERSION, settings: this.configuration.settings, engineVersions, modelSha256 }));
    const inputHash = sha256(JSON.stringify({ source: input.asset.sha256, kind: "transcript", configHash }));
    const output = join(input.temporaryDirectory, "transcript");
    const args = ["-m", paths.whisper_model!, "-f", wav, "-l", "auto", "-t", String(threads(this.configuration.settings)),
      "-p", "1", "-ojf", "-of", output, "-np"];
    if (this.configuration.settings.whisperGpu === "cpu") args.push("-ng");
    successful(await this.runner.run({
      executable: paths.whisper!, args, cwd: input.temporaryDirectory, signal: input.signal,
      timeoutMs: 12 * 60 * 60_000, maxOutputBytes: 4 * 1024 * 1024,
      maxTemporaryBytes: temporarySpaceLimit(this.configuration.settings)
    }), "whisper.cpp");
    const outputPath = `${output}.json`;
    const info = await stat(outputPath);
    if (info.size > 32 * 1024 * 1024) throw new AppError("MEDIA_PROCESSING_FAILED", "The transcript JSON exceeds 32 MiB.");
    const parsed = parseWhisperJson(text(await readFile(outputPath)));
    const createdAt = new Date().toISOString();
    const payload: TranscriptArtifactV1 = {
      formatVersion: 1, kind: "transcript", sourceAssetId: input.asset.id, sourceSha256: input.asset.sha256,
      language: parsed.language, processorIdentity: ASR_PROCESSOR_IDENTITY, processorVersion: MEDIA_PROCESSOR_VERSION,
      engineVersions, modelSha256, configHash, text: parsed.text, segments: parsed.segments, createdAt
    };
    input.reportProgress(0.9);
    return { kind: "transcript", payload, processorIdentity: payload.processorIdentity, processorVersion: MEDIA_PROCESSOR_VERSION, configHash, inputHash };
  }
}
