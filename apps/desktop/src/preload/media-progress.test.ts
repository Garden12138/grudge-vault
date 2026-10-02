import { describe, expect, it, vi } from "vitest";
import { parseMediaProgress, subscribeMediaProgress } from "./media-progress";

const valid = { sessionId: "00000000-0000-4000-8000-000000000001", mediaId: "00000000-0000-4000-8000-000000000002",
  mediaNumber: 1, mediaCount: 2, stage: "understanding", segmentNumber: 2, checkedDurationMs: 10_000, sourceDurationMs: 20_000 };

describe("private bounded media progress bridge", () => {
  it("accepts only bounded metadata, including pre-probe and summarizing states", () => {
    expect(parseMediaProgress(valid)).toEqual(valid);
    const unknownDuration: Partial<typeof valid> = { ...valid }; delete unknownDuration.sourceDurationMs;
    expect(parseMediaProgress({ ...unknownDuration, stage: "processing", segmentNumber: 0, checkedDurationMs: 0 }))
      .not.toHaveProperty("sourceDurationMs");
    expect(parseMediaProgress({ ...valid, stage: "summarizing" })?.stage).toBe("summarizing");
  });
  it.each([
    { path: "/private/diary.wav" }, { text: "private diary" }, { apiKey: "private key" },
    { sessionId: "invalid" }, { mediaNumber: 3 }, { mediaCount: 21 }, { segmentNumber: 129 },
    { checkedDurationMs: 20_001 }, { sourceDurationMs: -1 }, { stage: "complete" }, { checkedDurationMs: NaN }
  ])("drops invalid or private fields %j", (change) => {
    expect(parseMediaProgress({ ...valid, ...change })).toBeUndefined();
  });
  it("unsubscribes exactly once and refuses delivery from a queued callback after disposal", () => {
    let listener!: (event: unknown, value: unknown) => void;
    const port = { on: vi.fn((_channel, value) => { listener = value; }), removeListener: vi.fn() };
    const callback = vi.fn(); const dispose = subscribeMediaProgress(port, "intake:media-progress", callback);
    listener({}, valid); listener({}, { ...valid, path: "private" });
    expect(callback).toHaveBeenCalledOnce(); dispose(); dispose(); listener({}, valid);
    expect(callback).toHaveBeenCalledOnce(); expect(port.removeListener).toHaveBeenCalledOnce();
    expect(port.removeListener).toHaveBeenCalledWith("intake:media-progress", listener);
  });
});
