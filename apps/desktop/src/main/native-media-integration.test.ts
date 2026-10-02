import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NativeMediaSegment, NativeMediaSegmentInput } from "@grudge-vault/application";
import { SafeProcessRunner } from "@grudge-vault/media-pipeline";
import { MacNativeMediaSegmenter } from "./native-media-segments";
import { syntheticSilentMp3 } from "../../../../tests/fixtures/native-media/silent-mp3";

const enabled = process.platform === "darwin" && process.env.GRUDGE_VAULT_NATIVE_MEDIA_TEST === "1";
const executable = resolve("apps/desktop/build/native/grudge-vault-media");
const runner = new SafeProcessRunner();
let root = "";
let fixtureGenerator = "";

function wav(seconds: number, channels = 2) {
  const rate = 44_100;
  const dataBytes = seconds * rate * channels * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(dataBytes + 36, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < seconds * rate; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      buffer.writeInt16LE(Math.round(Math.sin(frame * (channel ? 0.034 : 0.017)) * 12_000), 44 + (frame * channels + channel) * 2);
    }
  }
  return buffer;
}
async function input(path: string, kind: "audio" | "video", mimeType: string): Promise<NativeMediaSegmentInput> {
  const bytes = await readFile(path);
  return { kind, mimeType, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    async open() { return createReadStream(path, { highWaterMark: 64 * 1024 }); } };
}
function segmenter(options: { targetDurationMs?: number; maxSegmentBytes?: number } = {}) {
  const directories: string[] = [];
  const adapter = new MacNativeMediaSegmenter({ executable, ...options, createTemporaryDirectory: async (prefix) => {
    const directory = await mkdtemp(join(root, prefix)); directories.push(directory); return directory;
  } });
  return { adapter, directories };
}
async function collect(adapter: MacNativeMediaSegmenter, source: NativeMediaSegmentInput) {
  const segments: NativeMediaSegment[] = [];
  for await (const segment of adapter.segments(source)) segments.push(segment);
  return segments;
}
async function cleaned(directories: string[]) {
  for (const directory of directories) await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
}
async function run(tool: string, args: string[]) {
  const result = await runner.run({ executable: tool, args, cwd: root, timeoutMs: 60_000, maxOutputBytes: 64_000 });
  expect(result.exitCode, result.stderr.toString("utf8")).toBe(0);
  return result;
}
async function m4a(name: string, seconds = 4) {
  const source = join(root, `${name}.wav`);
  const output = join(root, `${name}.m4a`);
  await writeFile(source, wav(seconds));
  await run("/usr/bin/afconvert", [source, output, "-f", "m4af", "-d", "aac ", "-b", "128000"]);
  return output;
}

describe.skipIf(!enabled)("real macOS native media fixtures (explicit local gate)", () => {
  beforeAll(async () => {
    await access(executable);
    root = await mkdtemp(join(tmpdir(), "grudge-vault-native-fixtures-"));
    fixtureGenerator = join(root, "fixture-generator");
    await run("/usr/bin/xcrun", ["swiftc", "-parse-as-library", "-module-cache-path", join(root, "module-cache"),
      resolve("tests/fixtures/native-media/generate.swift"), "-o", fixtureGenerator]);
  }, 90_000);
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("splits a greater-than-7MB stereo WAV with exact PCM continuity and unchanged source", async () => {
    const original = wav(48);
    expect(original.length).toBeGreaterThan(7_000_000);
    const path = join(root, "long-stereo.wav");
    await writeFile(path, original);
    const { adapter, directories } = segmenter();
    const result = await collect(adapter, await input(path, "audio", "audio/wav"));
    expect(result).toHaveLength(2);
    expect(result[0]!.startMs).toBe(0);
    expect(result[0]!.endMs).toBe(result[1]!.startMs);
    expect(result[1]!.endMs).toBe(48_000);
    for (const { bytes } of result) {
      const buffer = Buffer.from(bytes);
      expect(buffer.readUInt16LE(22)).toBe(2);
      expect(buffer.readUInt32LE(24)).toBe(44_100);
      expect(buffer.readUInt16LE(34)).toBe(16);
      expect(bytes.length).toBeLessThanOrEqual(7_000_000);
      expect(buffer.toString("base64").length).toBeLessThan(10_000_000);
    }
    const joined = Buffer.concat(result.map(({ bytes }) => Buffer.from(bytes).subarray(44)));
    expect(joined.length).toBe(original.length - 44);
    expect(createHash("sha256").update(joined).digest("hex")).toBe(createHash("sha256").update(original.subarray(44)).digest("hex"));
    expect((await readFile(path)).equals(original)).toBe(true);
    await cleaned(directories);
  });

  it("decodes synthetic M4A into bounded stereo WAV instead of silently dropping the audio", async () => {
    const path = await m4a("compressed-stereo");
    const before = await readFile(path);
    const { adapter, directories } = segmenter({ targetDurationMs: 1300 });
    const result = await collect(adapter, await input(path, "audio", "audio/mp4"));
    expect(result).toHaveLength(4);
    expect(result.at(-1)!.endMs).toBe(4000);
    for (const { bytes } of result) {
      const buffer = Buffer.from(bytes);
      expect(buffer.readUInt16LE(22)).toBe(2);
      expect(buffer.readUInt32LE(24)).toBe(44_100);
      expect(buffer.subarray(44).some((byte) => byte !== 0)).toBe(true);
    }
    expect((await readFile(path)).equals(before)).toBe(true);
    await cleaned(directories);
  });

  it("actually decodes complete synthetic MP3 frames into continuous mono PCM without an external encoder", async () => {
    const original = syntheticSilentMp3();
    const path = join(root, "synthetic-silence.mp3");
    await writeFile(path, original);
    const { adapter, directories } = segmenter({ targetDurationMs: 1300 });
    const result = await collect(adapter, await input(path, "audio", "audio/mpeg"));
    expect(result).toHaveLength(4);
    expect(result[0]!.startMs).toBe(0);
    expect(result.at(-1)!.endMs).toBeGreaterThan(3900);
    expect(result.at(-1)!.endMs).toBeLessThanOrEqual(4032);
    for (const [index, segment] of result.entries()) {
      if (index) expect(segment.startMs).toBe(result[index - 1]!.endMs);
      const buffer = Buffer.from(segment.bytes);
      expect(buffer.toString("ascii", 0, 4)).toBe("RIFF");
      expect(buffer.readUInt16LE(22)).toBe(1);
      expect(buffer.readUInt32LE(24)).toBe(32_000);
      expect(buffer.readUInt16LE(34)).toBe(16);
      expect(buffer.length).toBe(44 + (segment.endMs - segment.startMs) * 32 * 2);
      expect(buffer.subarray(44).every((byte) => byte === 0)).toBe(true);
    }
    expect((await readFile(path)).equals(original)).toBe(true);
    await cleaned(directories);
  });

  it("retains video and audio tracks across non-keyframe cuts with continuous source offsets", async () => {
    const path = join(root, "synthetic-with-audio.mp4");
    await run(fixtureGenerator, [await m4a("video-audio"), path, "video"]);
    const before = await readFile(path);
    const { adapter, directories } = segmenter({ targetDurationMs: 1100 });
    const result = await collect(adapter, await input(path, "video", "video/mp4"));
    expect(result.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([[0, 1100], [1100, 2200], [2200, 3300], [3300, 4000]]);
    for (const segment of result) {
      const part = join(root, `probe-video-${segment.index}.mp4`);
      await writeFile(part, segment.bytes);
      const probe = JSON.parse((await run(executable, ["probe", part])).stdout.toString("utf8"));
      expect(probe).toMatchObject({ ok: true, hasAudio: true, hasVideo: true, durationMs: segment.endMs - segment.startMs });
      expect(segment.bytes.length).toBeLessThanOrEqual(7_000_000);
    }
    expect((await readFile(path)).equals(before)).toBe(true);
    await cleaned(directories);
  });

  it("keeps a presentation-time audio gap instead of collapsing it", async () => {
    const path = join(root, "gapped-audio.m4a");
    await run(fixtureGenerator, [await m4a("gap-source"), path, "gapped-audio"]);
    const { adapter, directories } = segmenter();
    const result = await collect(adapter, await input(path, "audio", "audio/mp4"));
    expect(result).toHaveLength(1);
    expect(result[0]!.endMs).toBe(4000);
    const pcm = Buffer.from(result[0]!.bytes).subarray(44);
    const bytesPerSecond = 44_100 * 2 * 2;
    expect(pcm.length).toBe(bytesPerSecond * 4);
    expect(pcm.subarray(0, bytesPerSecond / 2).some((byte) => byte !== 0)).toBe(true);
    expect(pcm.subarray(bytesPerSecond * 1.2, bytesPerSecond * 1.8).every((byte) => byte === 0)).toBe(true);
    expect(pcm.subarray(bytesPerSecond * 2.2, bytesPerSecond * 2.8).some((byte) => byte !== 0)).toBe(true);
    await cleaned(directories);
  });

  it("rejects unsupported multitrack video and multichannel audio instead of mixing or omitting them", async () => {
    const multitrack = join(root, "synthetic-multitrack.mp4");
    await run(fixtureGenerator, [await m4a("multiple-audio"), multitrack, "multi-track"]);
    const multichannel = join(root, "synthetic-three-channels.wav");
    await writeFile(multichannel, wav(1, 3));
    for (const source of [await input(multitrack, "video", "video/mp4"), await input(multichannel, "audio", "audio/wav")]) {
      const { adapter, directories } = segmenter();
      await expect(collect(adapter, source)).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
      await cleaned(directories);
    }
  });

  it("rejects a working reference movie instead of following references outside the selected container", async () => {
    const referenced = join(root, "reference-source.mp4");
    const path = join(root, "reference-only.mov");
    await run(fixtureGenerator, [await m4a("reference-audio"), referenced, "video"]);
    const before = await readFile(referenced);
    await run(fixtureGenerator, [referenced, path, "reference-video"]);
    expect((await lstat(path)).size).toBeLessThan(before.length);
    const { adapter, directories } = segmenter();
    const outcome = await collect(adapter, await input(path, "video", "video/quicktime"))
      .then(() => ({ accepted: true }), (cause: unknown) => ({ accepted: false, code: (cause as { code?: string }).code }));
    expect(outcome).toMatchObject({ accepted: false, code: expect.stringMatching(/^(MEDIA_PROCESSING_FAILED|MODALITY_UNAVAILABLE)$/) });
    expect((await readFile(referenced)).equals(before)).toBe(true);
    await cleaned(directories);
  });
});
