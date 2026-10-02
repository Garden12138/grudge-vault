import { describe, expect, it, vi } from "vitest";
import type { NativeMediaSegment, NativeMediaSegmentInput, NativeMediaSegmentPort } from "@grudge-vault/application";
import type { NativeMediaProgress } from "@grudge-vault/domain";
import { AppError } from "@grudge-vault/shared";
import { needsNativeMediaSegmentation, segmentedMediaContext, understandSegmentedMedia, type StructuredMediaInvoker } from "./native-media";

const source: NativeMediaSegmentInput = {
  kind: "video", mimeType: "video/mp4", byteSize: 8_000_000, sha256: "a".repeat(64),
  async open() { throw new Error("Only the injected segmenter reads this source"); }
};
const clips = (): NativeMediaSegment[] => [0, 1].map((index) => ({
  index, startMs: index * 10_000, endMs: (index + 1) * 10_000, sourceDurationMs: 20_000,
  mimeType: "video/mp4", bytes: Buffer.from(`synthetic-clip-${index}`)
}));
function segmenter(values = clips()) {
  const cleaned = vi.fn();
  const port: NativeMediaSegmentPort = {
    async *segments() { try { yield* values; } finally { cleaned(); } }
  };
  return { port, cleaned };
}
function observer(reply?: (index: number) => unknown) {
  let calls = 0;
  const invoke: StructuredMediaInvoker = async (request) => {
    const index = calls++;
    expect(request.name).toBe("submit_media_segment_observations");
    const content = request.userContent as Array<{ type: string }>;
    expect(content.filter(({ type }) => type === "input_audio" || type === "video_url")).toHaveLength(1);
    return request.schema.parse(reply?.(index) ?? {
      examinedSegmentId: `segment-${index}`, coverage: "complete",
      summary: index ? "后段中的争议话语，需要核对" : "开头是普通日常",
      observations: [{ description: "合成观察", intervalMs: [100, 200], frameTimeMs: 150 }], notes: []
    });
  };
  return { invoke, calls: () => calls };
}

describe("bounded complete native media understanding", () => {
  it("examines every clip and rebases interval and video frame once onto the unchanged original", async () => {
    const { port, cleaned } = segmenter(); const { invoke, calls } = observer();
    const result = await understandSegmentedMedia("original", source, port, invoke);
    expect(calls()).toBe(2); expect(cleaned).toHaveBeenCalledOnce();
    expect(result.segments[1]).toMatchObject({ startMs: 10_000, endMs: 20_000,
      observations: [{ intervalMs: [10_100, 10_200], frameTimeMs: 10_150 }] });
    expect(segmentedMediaContext(result)).toContain("后段中的争议话语");
    expect(segmentedMediaContext(result)).toContain("不是原文或已核验事实");
  });

  it("uses the whole clip as a conservative anchor when the model cannot provide a timestamp", async () => {
    const { port } = segmenter();
    const { invoke } = observer((index) => ({ examinedSegmentId: `segment-${index}`, coverage: "complete",
      summary: "合成概括", observations: [{ description: "无法精确定位" }], notes: [] }));
    expect((await understandSegmentedMedia("original", source, port, invoke)).segments[1]?.observations)
      .toEqual([{ description: "无法精确定位", intervalMs: [10_000, 20_000] }]);
  });

  it("reports only actually checked duration and metadata, and never a guessed total segment count", async () => {
    const events: NativeMediaProgress[] = [];
    await understandSegmentedMedia("original", source, segmenter().port, observer().invoke, { mediaNumber: 2, mediaCount: 3,
      onProgress(value) { events.push(value); } });
    expect(events.map(({ stage, segmentNumber, checkedDurationMs }) => [stage, segmentNumber, checkedDurationMs]))
      .toEqual([["processing", 0, 0], ["understanding", 1, 0], ["checked", 1, 10_000],
        ["understanding", 2, 10_000], ["checked", 2, 20_000]]);
    expect(events.every(({ mediaNumber, mediaCount }) => mediaNumber === 2 && mediaCount === 3)).toBe(true);
    expect(Object.keys(events[1]!)).toEqual(["mediaId", "mediaNumber", "mediaCount", "stage", "segmentNumber", "checkedDurationMs", "sourceDurationMs"]);
  });

  it("stops and closes native iteration before classification if any clip coverage is partial", async () => {
    const { port, cleaned } = segmenter();
    const { invoke, calls } = observer((index) => ({ examinedSegmentId: `segment-${index}`, coverage: "partial",
      summary: "无法完整检查", observations: [], notes: [] }));
    await expect(understandSegmentedMedia("original", source, port, invoke)).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
    expect(calls()).toBe(1); expect(cleaned).toHaveBeenCalledOnce();
  });

  it.each(["empty", "missing tail", "gap", "overlap", "reordered", "changed duration", "oversized", "wrong format"])(
    "rejects %s rather than returning a checked prefix", async (fault) => {
      const values = clips();
      if (fault === "empty") values.splice(0);
      if (fault === "missing tail") values.pop();
      if (fault === "gap") values[1]!.startMs += 1;
      if (fault === "overlap") values[1]!.startMs -= 1;
      if (fault === "reordered") values[0]!.index = 1;
      if (fault === "changed duration") values[1]!.sourceDurationMs += 1;
      if (fault === "oversized") values[0]!.bytes = Buffer.alloc(7_000_001);
      if (fault === "wrong format") values[0]!.mimeType = "audio/wav";
      const { port, cleaned } = segmenter(values);
      await expect(understandSegmentedMedia("original", source, port, observer().invoke)).rejects.toBeInstanceOf(AppError);
      expect(cleaned).toHaveBeenCalledOnce();
    }
  );

  it.each(["wrong clip", "late interval", "reversed interval", "late frame", "audio frame"])(
    "rejects model %s instead of inventing a valid original location", async (fault) => {
      const values = clips(); const audio = fault === "audio frame";
      if (audio) values.forEach((clip) => { clip.mimeType = "audio/wav"; });
      const { port, cleaned } = segmenter(values);
      const { invoke } = observer((index) => ({ examinedSegmentId: fault === "wrong clip" ? "segment-other" : `segment-${index}`,
        coverage: "complete", summary: "合成概括", notes: [], observations: [{ description: "无效定位",
          intervalMs: fault === "late interval" ? [0, 10_001] : fault === "reversed interval" ? [200, 100] : [100, 200],
          frameTimeMs: fault === "late frame" ? 10_001 : 150 }] }));
      await expect(understandSegmentedMedia("original", audio ? { ...source, kind: "audio", mimeType: "audio/wav" } : source,
        port, invoke)).rejects.toMatchObject({ name: "ZodError" });
      expect(cleaned).toHaveBeenCalledOnce();
    }
  );

  it.each(["cancel", "configuration changed", "model outage"])("cleans up and stops further clip calls after %s", async (fault) => {
    const controller = new AbortController(); const { port, cleaned } = segmenter();
    let current = true; const { invoke: valid } = observer(); let calls = 0;
    const error = new AppError("LLM_CONFIGURATION_CHANGED", "synthetic changed configuration");
    const invoke: StructuredMediaInvoker = async (request) => {
      calls++;
      if (fault === "model outage") throw error;
      const value = await valid(request);
      if (fault === "cancel") controller.abort(error); else current = false;
      return value;
    };
    await expect(understandSegmentedMedia("original", source, port, invoke, { signal: controller.signal,
      assertCurrent() { if (!current) throw error; } })).rejects.toBe(error);
    expect(calls).toBe(1); expect(cleaned).toHaveBeenCalledOnce();
  });

  it("fails on a full-description budget instead of dropping later observations", async () => {
    const values: NativeMediaSegment[] = Array.from({ length: 40 }, (_, index) => ({
      index, startMs: index, endMs: index + 1, sourceDurationMs: 40, mimeType: "video/mp4", bytes: Buffer.from("clip")
    }));
    const { port, cleaned } = segmenter(values);
    const { invoke, calls } = observer((index) => ({ examinedSegmentId: `segment-${index}`, coverage: "complete",
      summary: "字".repeat(1200), notes: [], observations: Array.from({ length: 8 }, () => ({ description: "字".repeat(500) })) }));
    await expect(understandSegmentedMedia("original", source, port, invoke)).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
    expect(calls()).toBeLessThan(40); expect(cleaned).toHaveBeenCalledOnce();
  });

  it("routes M4A and large audio/video through segmentation but preserves small direct inputs", () => {
    expect(needsNativeMediaSegmentation("audio/mp4", 100)).toBe(true);
    expect(needsNativeMediaSegmentation("audio/x-m4a", 100)).toBe(true);
    expect(needsNativeMediaSegmentation("audio/mpeg", 7_000_001)).toBe(true);
    expect(needsNativeMediaSegmentation("video/mp4", 7_000_000)).toBe(false);
  });
});
