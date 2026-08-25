import { basename } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "@grudge-vault/shared";
import {
  LocalMediaPipeline, parseTesseractTsv, parseTesseractTsvPages, parseWhisperJson, SafeProcessRunner, type ProcessRunnerPort
} from "./index";

describe("local media parser contracts", () => {
  it("preserves Tesseract page, confidence, and bounding boxes", () => {
    const page = parseTesseractTsv([
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "1\t1\t0\t0\t0\t0\t0\t0\t800\t1200\t-1\t",
      "5\t1\t1\t1\t1\t1\t12\t24\t50\t18\t96.25\tHello",
      "5\t1\t1\t1\t1\t2\t70\t24\t40\t18\t82\t世界"
    ].join("\n"), 3);
    expect(page).toEqual({
      page: 3, text: "Hello 世界", words: [
        { text: "Hello", confidence: 96.25, left: 12, top: 24, width: 50, height: 18 },
        { text: "世界", confidence: 82, left: 70, top: 24, width: 40, height: 18 }
      ]
    });
  });

  it("preserves page order from a multi-page TIFF TSV", () => {
    const header = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
    expect(parseTesseractTsvPages([
      header,
      "1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t",
      "5\t1\t1\t1\t1\t1\t1\t2\t3\t4\t90\tfirst",
      "1\t2\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t",
      "5\t2\t1\t1\t1\t1\t5\t6\t7\t8\t91\tsecond"
    ].join("\n"))).toMatchObject([
      { page: 1, text: "first" }, { page: 2, text: "second" }
    ]);
  });

  it("normalizes whisper.cpp timestamps into ordered milliseconds", () => {
    const transcript = parseWhisperJson(JSON.stringify({
      result: { language: "zh" },
      transcription: [
        { timestamps: { from: "00:00:00,250", to: "00:00:02,000" }, text: " 第一段 " },
        { offsets: { from: 2100, to: 4300 }, text: "第二段" }
      ]
    }));
    expect(transcript).toEqual({
      language: "zh", text: "第一段 第二段",
      segments: [{ startMs: 250, endMs: 2000, text: "第一段" }, { startMs: 2100, endMs: 4300, text: "第二段" }]
    });
  });

  it("rejects malformed TSV and non-monotonic transcript output", () => {
    expect(() => parseTesseractTsv("not tsv")).toThrowError(AppError);
    expect(() => parseWhisperJson(JSON.stringify({ transcription: [
      { offsets: { from: 2000, to: 3000 }, text: "later" },
      { offsets: { from: 1000, to: 1500 }, text: "earlier" }
    ] }))).toThrowError(/non-monotonic/);
  });

  it("enforces absolute executables, output limits, and cancellation without a shell", async () => {
    const runner = new SafeProcessRunner();
    await expect(runner.run({ executable: "node", args: [], cwd: tmpdir(), timeoutMs: 1000, maxOutputBytes: 1000 }))
      .rejects.toMatchObject({ code: "LOCAL_PROCESSOR_UNAVAILABLE" });
    await expect(runner.run({ executable: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(2048))"],
      cwd: tmpdir(), timeoutMs: 1000, maxOutputBytes: 128 })).rejects.toThrow(/too much output/);
    const controller = new AbortController();
    const pending = runner.run({ executable: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: tmpdir(), signal: controller.signal, timeoutMs: 20_000, maxOutputBytes: 128 });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    await expect(runner.run({ executable: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: tmpdir(), timeoutMs: 50, maxOutputBytes: 128 })).rejects.toThrow(/timed out/);
  });

  it("terminates a process that exceeds the temporary-space limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-runner-"));
    try {
      const runner = new SafeProcessRunner();
      await expect(runner.run({ executable: process.execPath,
        args: ["-e", "require('fs').writeFileSync('large.tmp', Buffer.alloc(4096)); setTimeout(() => {}, 10000)"],
        cwd: root, timeoutMs: 20_000, maxOutputBytes: 128, maxTemporaryBytes: 1024
      })).rejects.toThrow(/temporary-space/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs complete PDF OCR and audio ASR contracts through an injected process runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-media-adapter-"));
    try {
      const names = ["tesseract", "pdftoppm", "pdfinfo", "ffmpeg", "ffprobe", "whisper-cli", "model.bin"];
      await Promise.all(names.map((name) => writeFile(join(root, name), name)));
      const calls: Array<{ executable: string; args: string[] }> = [];
      const runner: ProcessRunnerPort = { async run(input) {
        calls.push({ executable: basename(input.executable), args: input.args });
        const executable = basename(input.executable);
        if (executable === "tesseract" && input.args[0] === "--version") return { stdout: Buffer.from("tesseract 5.4.0\n"), stderr: Buffer.alloc(0), exitCode: 0 };
        if (executable === "tesseract" && input.args[0] === "--list-langs") return { stdout: Buffer.from("List of available languages (2):\neng\nchi_sim\n"), stderr: Buffer.alloc(0), exitCode: 0 };
        if (executable === "tesseract") {
          const page = /page-(\d+)/.exec(input.args[0] ?? "")?.[1] ?? "1";
          return { stdout: Buffer.from([
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
            `5\t1\t1\t1\t1\t1\t1\t2\t3\t4\t91\tpage-${Number(page)}`
          ].join("\n")), stderr: Buffer.alloc(0), exitCode: 0 };
        }
        if (executable === "pdfinfo") return { stdout: Buffer.from("Pages:          2\n"), stderr: Buffer.alloc(0), exitCode: 0 };
        if (executable === "pdftoppm") return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
        if (executable === "ffmpeg" && input.args[0] === "-version") return { stdout: Buffer.from("ffmpeg version 8.0\n"), stderr: Buffer.alloc(0), exitCode: 0 };
        if (executable === "ffmpeg") return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
        if (executable === "ffprobe" && input.args[0] === "-version") return { stdout: Buffer.from("ffprobe version 8.0\n"), stderr: Buffer.alloc(0), exitCode: 0 };
        if (executable === "ffprobe") return { stdout: Buffer.from("3.5\n"), stderr: Buffer.alloc(0), exitCode: 0 };
        if (executable === "whisper-cli" && input.args[0] === "--help") return { stdout: Buffer.from("--model --output-json-full\n"), stderr: Buffer.alloc(0), exitCode: 0 };
        if (executable === "whisper-cli") {
          const output = input.args[input.args.indexOf("-of") + 1]!;
          await writeFile(`${output}.json`, JSON.stringify({ result: { language: "zh" }, transcription: [
            { offsets: { from: 0, to: 1200 }, text: "local transcript" }
          ] }));
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
        }
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
      } };
      const pipeline = new LocalMediaPipeline({ formatVersion: 1, paths: {
        tesseract: join(root, "tesseract"), poppler: join(root, "pdftoppm"), pdfinfo: join(root, "pdfinfo"),
        ffmpeg: join(root, "ffmpeg"), ffprobe: join(root, "ffprobe"), whisper: join(root, "whisper-cli"), whisper_model: join(root, "model.bin")
      }, settings: { autoProcessNew: true, ocrLanguages: ["eng", "chi_sim"], resourceProfile: "balanced", whisperGpu: "cpu" } },
      async () => undefined, runner);
      expect(await pipeline.probe()).toMatchObject({ ocr: { available: true }, asr: { available: true } });
      const signal = new AbortController().signal;
      const pdf = await pipeline.process({ asset: { id: "pdf", sha256: "a".repeat(64), byteSize: 10, mimeType: "application/pdf",
        originalFileName: "scan.pdf", vaultFormat: 2, integrityStatus: "verified", availabilityStatus: "available", createdAt: new Date().toISOString() },
      inputPath: join(root, "scan.pdf"), temporaryDirectory: root, signal, reportProgress() {} });
      expect(pdf.payload.kind).toBe("ocr");
      if (pdf.payload.kind === "ocr") expect(pdf.payload.pages.map(({ page, text }) => ({ page, text }))).toEqual([
        { page: 1, text: "page-1" }, { page: 2, text: "page-2" }
      ]);
      const audio = await pipeline.process({ asset: { id: "audio", sha256: "b".repeat(64), byteSize: 10, mimeType: "audio/mpeg",
        originalFileName: "note.mp3", vaultFormat: 2, integrityStatus: "verified", availabilityStatus: "available", createdAt: new Date().toISOString() },
      inputPath: join(root, "note.mp3"), temporaryDirectory: root, signal, reportProgress() {} });
      expect(audio.payload).toMatchObject({ kind: "transcript", language: "zh", text: "local transcript" });
      expect(calls.find(({ executable, args }) => executable === "ffmpeg" && args[0] === "-nostdin")?.args)
        .toEqual(expect.arrayContaining(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"]));
      const whisperArgs = calls.find(({ executable, args }) => executable === "whisper-cli" && args[0] === "-m")?.args ?? [];
      expect(whisperArgs).toEqual(expect.arrayContaining(["-p", "1", "-ojf", "-ng"]));
      const firstFingerprint = await pipeline.fingerprint({ id: "audio", sha256: "b".repeat(64), byteSize: 10, mimeType: "audio/mpeg",
        originalFileName: "note.mp3", vaultFormat: 2, integrityStatus: "verified", availabilityStatus: "available", createdAt: new Date().toISOString() });
      await writeFile(join(root, "model.bin"), "changed model");
      const changedFingerprint = await pipeline.fingerprint({ id: "audio", sha256: "b".repeat(64), byteSize: 10, mimeType: "audio/mpeg",
        originalFileName: "note.mp3", vaultFormat: 2, integrityStatus: "verified", availabilityStatus: "available", createdAt: new Date().toISOString() });
      expect(changedFingerprint.inputHash).not.toBe(firstFingerprint.inputHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
