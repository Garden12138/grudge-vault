import { createHash } from "node:crypto";

/** Blind fixture inputs: generated labels and category-coded IDs never enter this output. */
export function createScreeningKitCases(source) {
  let seed = 20261001;
  const cases = source.map((value) => ({ ...value }));
  for (let index = cases.length - 1; index > 0; index--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const other = seed % (index + 1);
    [cases[index], cases[other]] = [cases[other], cases[index]];
  }
  let mediaIndex = 0;
  return cases.map((value, index) => {
    const narrative = value.text.replace(/（合成样本 \d+[^）]*）$/u, "").trim();
    const mode = value.media ? mediaIndex++ % 5 : -1;
    return { id: `case-${String(index + 1).padStart(3, "0")}`,
      text: mode === 0 ? "今天正常回家。" : mode === 1 ? "" : narrative,
      ...(value.media ? { media: value.media, mediaText: narrative } : {}) };
  });
}

/** Reject a successful-but-empty system voice export; never replace speech with a silent fixture. */
export function inspectSyntheticSpeech(bytes, expectedRate = 16_000) {
  const fail = () => { throw new Error("SCREENING_KIT_SPEECH_INVALID"); };
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length) fail();
  let format, samples;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) fail();
    const size = bytes.readUInt32LE(offset + 4), end = offset + 8 + size;
    if (end > bytes.length) fail();
    const kind = bytes.toString("ascii", offset, offset + 4);
    if (kind === "fmt ") { if (format) fail(); format = bytes.subarray(offset + 8, end); }
    if (kind === "data") { if (samples) fail(); samples = bytes.subarray(offset + 8, end); }
    offset = end + size % 2;
    if (offset > bytes.length) fail();
  }
  if (!format || format.length < 16 || !samples || format.readUInt16LE(0) !== 1 || format.readUInt16LE(14) !== 16) fail();
  const channels = format.readUInt16LE(2), rate = format.readUInt32LE(4), block = channels * 2;
  if (![1, 2].includes(channels) || rate < 8_000 || rate > 192_000 || expectedRate !== null && (rate !== expectedRate || channels !== 1) ||
    format.readUInt32LE(8) !== rate * block || format.readUInt16LE(12) !== block || samples.length % block) fail();
  const durationMs = samples.length / (rate * block) * 1000;
  if (durationMs < 500 || durationMs > (expectedRate === null ? 30_250 : 30_000)) fail();
  let nonzeroSamples = 0, firstActive = -1, lastActive = -1;
  for (let index = 0; index < samples.length; index += 2) {
    const amplitude = Math.abs(samples.readInt16LE(index));
    if (amplitude !== 0) nonzeroSamples += 1;
    if (amplitude > 32) { if (firstActive < 0) firstActive = index; lastActive = index; }
  }
  if (nonzeroSamples < 100 || firstActive < 0) fail();
  return { durationMs, nonzeroSamples, activeSpanMs: (lastActive - firstActive + 2) / (rate * block) * 1000 };
}

export function artifactMetadata(bytes, file, kind, extra = {}) {
  const extension = { image: "png", audio: "wav", video: "mp4" }[kind];
  if (!extension || !new RegExp(`^assets/case-\\d{3}\\.${extension}$`).test(file) || bytes.length === 0 || bytes.length > 7_000_000 ||
    Object.entries(extra).some(([key, value]) => !["durationMs", "width", "height"].includes(key) ||
      !Number.isFinite(value) || value <= 0 || key === "durationMs" && value > 30_250)) {
    throw new Error("SCREENING_KIT_ARTIFACT_INVALID");
  }
  return { file, kind, mimeType: kind === "image" ? "image/png" : kind === "audio" ? "audio/wav" : "video/mp4",
    byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), ...extra };
}

export function renderScreeningReview(template, inputs) {
  // Data is not executable HTML, even if a future fictional injection case contains closing script tags.
  const json = JSON.stringify(inputs).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  if (!template.includes("/* SCREENING_KIT_DATA */ null")) throw new Error("SCREENING_KIT_TEMPLATE_INVALID");
  return template.replace("/* SCREENING_KIT_DATA */ null", json);
}
