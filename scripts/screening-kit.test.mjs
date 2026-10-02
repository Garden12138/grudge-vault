import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { syntheticScreeningCases } from "../tests/fixtures/screening-cases.ts";
import { artifactMetadata, createScreeningKitCases, inspectSyntheticSpeech, renderScreeningReview } from "./screening-kit.mjs";

function wav(silent = false) {
  const bytes = Buffer.alloc(32_044);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(32_000, 40);
  if (!silent) for (let index = 44; index < bytes.length; index += 2) bytes.writeInt16LE(200, index);
  return bytes;
}
test("creates a stable blind 200-case manifest with 60 real-media plans, pure media and neutral mixed text", () => {
  const cases = createScreeningKitCases(syntheticScreeningCases);
  assert.deepEqual(cases, createScreeningKitCases(syntheticScreeningCases));
  assert.equal(cases.length, 200); assert.equal(new Set(cases.map(({ id }) => id)).size, 200);
  assert.equal(cases.filter(({ media }) => media).length, 60);
  assert.equal(cases.filter(({ media, text }) => media && !text).length, 12);
  assert.equal(cases.filter(({ media, text }) => media && text === "今天正常回家。").length, 12);
  assert.equal(cases.filter(({ media }) => media === "image").length, 21);
  assert.equal(cases.filter(({ media }) => media === "audio").length, 20);
  assert.equal(cases.filter(({ media }) => media === "video").length, 19);
  for (const item of cases) {
    assert.match(item.id, /^case-\d{3}$/); assert.equal("expected" in item, false); assert.equal("category" in item, false);
    assert.equal(item.text.includes("合成样本"), false); assert.equal(item.mediaText?.includes("合成样本") ?? false, false);
  }
  assert.equal(JSON.stringify(cases).includes("related-"), false);
  assert.equal(JSON.stringify(cases).includes("ordinary-"), false);
});
test("rejects zero, silent, truncated, wrong-format and misaligned system speech exports", () => {
  assert.deepEqual(inspectSyntheticSpeech(wav()), { durationMs: 1000, nonzeroSamples: 16000, activeSpanMs: 1000 });
  for (const bytes of [Buffer.alloc(0), wav(true), wav().subarray(0, 100)]) assert.throws(() => inspectSyntheticSpeech(bytes));
  const wrongFormat = wav(); wrongFormat.writeUInt16LE(3, 20); assert.throws(() => inspectSyntheticSpeech(wrongFormat));
  const wrongSize = wav(); wrongSize.writeUInt32LE(31999, 40); assert.throws(() => inspectSyntheticSpeech(wrongSize));
});
test("artifact metadata is bounded, hashed and confined to synthetic relative paths", () => {
  const value = artifactMetadata(wav(), "assets/case-001.wav", "audio", { durationMs: 1000 });
  assert.equal(value.mimeType, "audio/wav"); assert.equal(value.byteSize, 32044); assert.match(value.sha256, /^[a-f0-9]{64}$/);
  for (const file of ["../outside.wav", "/private/tmp/case-001.wav", "https://example.com/case-001.wav"]) {
    assert.throws(() => artifactMetadata(wav(), file, "audio"));
  }
  assert.throws(() => artifactMetadata(Buffer.alloc(0), "assets/case-001.wav", "audio"));
  assert.throws(() => artifactMetadata(Buffer.alloc(7_000_001), "assets/case-001.wav", "audio"));
  assert.throws(() => artifactMetadata(wav(), "assets/case-001.mp4", "audio"));
  assert.throws(() => artifactMetadata(wav(), "assets/case-001.wav", "audio", { sha256: "forged" }));
  assert.throws(() => artifactMetadata(wav(), "assets/case-001.wav", "audio", { durationMs: -1 }));
});
test("review embeds inputs as safe data, has no network/storage API and exports only manually entered labels", () => {
  const template = readFileSync(new URL("./screening-kit-review.html", import.meta.url), "utf8");
  const html = renderScreeningReview(template, { cases: [{ id: "case-001", text: "</script><img src=x>", media: [] }] });
  assert.equal(html.includes('text":"</script>'), false);
  assert.match(html, /\\u003c\/script>/); assert.match(html, /connect-src 'none'/);
  assert.equal(/localStorage|indexedDB|fetch\(|XMLHttpRequest|document\.cookie/.test(html), false);
  assert.match(html, /expected:null/); assert.match(html, /labels-review-/);
  assert.throws(() => renderScreeningReview("missing slot", {}));
});
test("review starts blank, requires an include category and clears a stale danger category when changing to skip", () => {
  const template = readFileSync(new URL("./screening-kit-review.html", import.meta.url), "utf8");
  const html = renderScreeningReview(template, { cases: [{ id: "case-001", text: "虚构复核输入。", media: [] }] });
  const dom = new JSDOM(html, { runScripts: "dangerously", virtualConsole: new VirtualConsole() });
  try {
    const $ = id => dom.window.document.getElementById(id);
    assert.equal($("export").disabled, true); assert.match($("progress").textContent, /0／1/);
    dom.window.document.querySelector('[data-decision="include"]').click();
    assert.equal($("export").disabled, true);
    $("category").value = "danger"; $("category").dispatchEvent(new dom.window.Event("change"));
    assert.equal($("export").disabled, false); assert.match($("summary").textContent, /标注为危险 1/);
    dom.window.document.querySelector('[data-decision="skip"]').click();
    assert.equal($("category").value, ""); assert.equal($("category").disabled, true);
    assert.match($("summary").textContent, /标注为危险 0/);
    dom.window.document.querySelector('[data-decision="include"]').click();
    assert.equal($("category").disabled, false); assert.equal($("export").disabled, true);
  } finally { dom.window.close(); }
});
test("a removed previous media element cannot mark the current case as broken", () => {
  const template = readFileSync(new URL("./screening-kit-review.html", import.meta.url), "utf8");
  const html = renderScreeningReview(template, { cases: [1, 2].map(number => ({ id: `case-00${number}`,
    text: "虚构图片输入。", media: [{ kind: "image", file: `assets/case-00${number}.png` }] })) });
  const dom = new JSDOM(html, { runScripts: "dangerously", virtualConsole: new VirtualConsole() });
  try {
    const $ = id => dom.window.document.getElementById(id);
    const previous = $("media").querySelector("img");
    $("next").click(); previous.dispatchEvent(new dom.window.Event("error"));
    assert.equal($("media-error").textContent, "");
    $("media").querySelector("img").dispatchEvent(new dom.window.Event("error"));
    assert.match($("media-error").textContent, /媒体未能加载/);
  } finally { dom.window.close(); }
});
