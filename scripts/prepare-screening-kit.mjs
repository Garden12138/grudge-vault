import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import process from "node:process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syntheticScreeningCases } from "../tests/fixtures/screening-cases.ts";
import { artifactMetadata, createScreeningKitCases, inspectSyntheticSpeech, renderScreeningReview } from "./screening-kit.mjs";

const execute = promisify(execFile);
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const options = new Map();
for (const arg of args) {
  const match = /^(--output-parent|--build-root)=(.+)$/.exec(arg);
  if (!match || options.has(match[1])) throw new Error("SCREENING_KIT_ARGUMENT_INVALID");
  options.set(match[1], match[2]);
}
if (process.platform !== "darwin") throw new Error("SCREENING_KIT_MAC_REQUIRED");
const parent = options.get("--output-parent") ?? "/private/tmp";
if (!isAbsolute(parent) || resolve(parent) !== parent || !(await lstat(parent)).isDirectory()) throw new Error("SCREENING_KIT_ARGUMENT_INVALID");
const canonicalParent = await realpath(parent);
const root = await mkdtemp(join(canonicalParent, "grudge-vault-screening-kit-"));
const buildRoot = options.get("--build-root") ?? await mkdtemp("/private/tmp/grudge-vault-screening-kit-build-");
if (!isAbsolute(buildRoot) || resolve(buildRoot) !== buildRoot || !buildRoot.startsWith("/private/tmp/grudge-vault-screening-kit-build-") ||
  !(await lstat(buildRoot)).isDirectory() || (await lstat(buildRoot)).isSymbolicLink() || (await readdir(buildRoot)).length) {
  throw new Error("SCREENING_KIT_BUILD_ROOT_INVALID");
}
const buildIdentity = await lstat(buildRoot);
await chmod(root, 0o700); await chmod(buildRoot, 0o700);
await mkdir(join(root, "assets"), { mode: 0o700 });
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const outputJson = (file, value) => writeFile(join(root, file), JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
const run = async (binary, argv, timeout = 60_000) => {
  try { return (await execute(binary, argv, { timeout, maxBuffer: 1024 * 1024,
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(buildRoot, "cache"), SWIFT_MODULE_CACHE_PATH: join(buildRoot, "cache") } })).stdout; }
  catch { throw new Error("SCREENING_KIT_PROCESS_FAILED"); }
};
try {
  emit({ phase: "started", root, networkModelRequests: 0 });
  await run("/usr/bin/xcrun", ["swiftc", "-parse-as-library", "-O", "-module-cache-path", join(buildRoot, "cache"),
    join(repository, "scripts/generate-screening-kit.swift"), "-o", join(buildRoot, "generator")]);
  const mediaTool = join(repository, "apps/desktop/build/native/grudge-vault-media");
  if (!(await lstat(mediaTool)).isFile()) throw new Error("SCREENING_KIT_MEDIA_TOOL_MISSING");
  const probe = async (file) => {
    let value;
    try { value = JSON.parse(await run(mediaTool, ["probe", file], 15_000)); }
    catch { throw new Error("SCREENING_KIT_PROBE_FAILED"); }
    if (value.ok !== true || !Number.isFinite(value.durationMs) || value.durationMs < 500 || value.durationMs > 30_250) {
      throw new Error("SCREENING_KIT_PROBE_FAILED");
    }
    return value;
  };
  const plans = createScreeningKitCases(syntheticScreeningCases);
  const cases = [], generation = [];
  let completeMedia = 0;
  for (const plan of plans) {
    const item = { id: plan.id, text: plan.text, media: [] };
    if (plan.media) {
      const textPath = join(buildRoot, `${plan.id}.txt`);
      await writeFile(textPath, plan.mediaText, { flag: "wx", mode: 0o600 });
      const pngPath = join(buildRoot, `${plan.id}.png`), wavPath = join(buildRoot, `${plan.id}.wav`);
      let speech, inspected, decodedVideoSpeech;
      if (plan.media !== "audio") {
        await run(join(buildRoot, "generator"), ["image", textPath, pngPath]);
        const bytes = await readFile(pngPath);
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          bytes.readUInt32BE(16) !== 800 || bytes.readUInt32BE(20) !== 600) throw new Error("SCREENING_KIT_IMAGE_INVALID");
      }
      if (plan.media !== "image") {
        // Installed local system voice only, file output. No network-send or live audio/microphone flags.
        await run("/usr/bin/say", ["-v", "Tingting", "-o", wavPath, "--file-format=WAVE", "--data-format=LEI16@16000", "--channels=1", "-f", textPath]);
        speech = inspectSyntheticSpeech(await readFile(wavPath));
        inspected = await probe(wavPath);
        if (inspected.hasAudio !== true || inspected.hasVideo !== false || Math.abs(inspected.durationMs - speech.durationMs) > 2) {
          throw new Error("SCREENING_KIT_SPEECH_INVALID");
        }
      }
      const extension = plan.media === "image" ? "png" : plan.media === "audio" ? "wav" : "mp4";
      const relative = `assets/${plan.id}.${extension}`, output = join(root, relative);
      if (plan.media === "image") await writeFile(output, await readFile(pngPath), { flag: "wx", mode: 0o600 });
      else if (plan.media === "audio") await writeFile(output, await readFile(wavPath), { flag: "wx", mode: 0o600 });
      else {
        await run(join(buildRoot, "generator"), ["video", pngPath, wavPath, output]);
        inspected = await probe(output);
        // A 5-fps last frame may extend the container by at most one frame; never shorten the speech source.
        if (inspected.hasAudio !== true || inspected.hasVideo !== true ||
          inspected.durationMs < speech.durationMs - 2 || inspected.durationMs > speech.durationMs + 201) {
          throw new Error("SCREENING_KIT_VIDEO_INVALID");
        }
        const decoded = join(buildRoot, `${plan.id}-decoded.wav`);
        try { await run(join(buildRoot, "generator"), ["audio-check", output, decoded]); }
        catch { throw new Error("SCREENING_KIT_VIDEO_INVALID"); }
        decodedVideoSpeech = inspectSyntheticSpeech(await readFile(decoded), null);
        if (decodedVideoSpeech.activeSpanMs < speech.activeSpanMs - 100) throw new Error("SCREENING_KIT_VIDEO_INVALID");
        await chmod(output, 0o600);
      }
      item.media.push(artifactMetadata(await readFile(output), relative, plan.media,
        plan.media === "image" ? { width: 800, height: 600 } : { durationMs: inspected.durationMs }));
      generation.push({ id: plan.id, kind: plan.media, nonzeroSpeechSamples: speech?.nonzeroSamples ?? null,
        decodedVideoSpeechSamples: decodedVideoSpeech?.nonzeroSamples ?? null });
      completeMedia += 1;
      emit({ phase: "media-verified", completed: completeMedia, total: 60, kind: plan.media });
    }
    cases.push(item);
  }
  if (cases.length !== 200 || completeMedia !== 60) throw new Error("SCREENING_KIT_COVERAGE_INVALID");
  const inputs = { version: 1, synthetic: true, labelsIndependentlyReviewed: false, releaseGatePassed: false,
    limitations: ["程序绘制文字卡片、系统语音、带同一语音的静态卡片视频；不是实拍现场、真实录音、复杂噪声或长媒体。",
      "这些素材可供独立复核和另行授权的模型测试，不证明G2质量、标签独立性或真实事件事实。"], cases };
  await outputJson("inputs.json", inputs);
  await outputJson("labels-blank.json", cases.map(({ id }) => ({ id, expected: null, category: null })));
  await outputJson("generation.json", { createdAt: new Date().toISOString(), networkModelRequests: 0,
    cases: 200, media: 60, pureMedia: cases.filter((value) => value.media.length && !value.text).length,
    mixedNeutralText: cases.filter((value) => value.media.length && value.text === "今天正常回家。").length,
    byKind: Object.fromEntries(["image", "audio", "video"].map((kind) => [kind, cases.filter((value) => value.media.some((asset) => asset.kind === kind)).length])),
    verifiedMedia: generation, independentlyReviewed: false, releaseGatePassed: false });
  await writeFile(join(root, "review.html"), renderScreeningReview(await readFile(join(repository, "scripts/screening-kit-review.html"), "utf8"), inputs),
    { flag: "wx", mode: 0o600 });
  const current = await lstat(buildRoot);
  if (current.isDirectory() && !current.isSymbolicLink() && current.dev === buildIdentity.dev && current.ino === buildIdentity.ino) {
    await rm(buildRoot, { recursive: true }); // Only this run's confirmed, initially empty compiler/fixture staging directory.
  } else throw new Error("SCREENING_KIT_STAGING_CHANGED");
  emit({ phase: "complete", root, cases: cases.length, media: completeMedia, networkModelRequests: 0, releaseGatePassed: false });
} catch (cause) {
  emit({ phase: "incomplete", root, buildRoot, code: cause instanceof Error && /^SCREENING_KIT_[A-Z_]+$/.test(cause.message)
    ? cause.message : "SCREENING_KIT_FAILED", networkModelRequests: 0, releaseGatePassed: false });
  process.exitCode = 1; // Preserve partial fixtures for diagnosis; never relabel incomplete output as a quality set.
}
