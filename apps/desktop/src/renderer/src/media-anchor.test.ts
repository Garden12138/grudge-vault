import { describe, expect, it } from "vitest";
import { mediaAnchorSeek } from "./media-anchor";

describe("media anchor playback bounds", () => {
  it("keeps valid interval and frame positions unchanged", () => {
    expect(mediaAnchorSeek({ intervalMs: [1_000, 2_000] }, 2)).toEqual({ positionSeconds: 1, invalid: false });
    expect(mediaAnchorSeek({ frameTimeMs: 500 }, 1)).toEqual({ positionSeconds: 0.5, invalid: false });
  });

  it.each([
    { intervalMs: [10_000, 11_000] as [number, number] },
    { intervalMs: [500, 1_500] as [number, number] },
    { intervalMs: [500, 100] as [number, number] },
    { frameTimeMs: 1_000 },
    { frameTimeMs: -1 },
    { frameTimeMs: Number.NaN }
  ])("does not silently clamp an invalid anchor to the media end: %j", (anchor) => {
    expect(mediaAnchorSeek(anchor, 1)).toEqual({ positionSeconds: 0, invalid: true });
  });

  it("does not seek before duration metadata is available or when no timed anchor exists", () => {
    expect(mediaAnchorSeek({ intervalMs: [1_000, 2_000] }, Number.NaN)).toEqual({ invalid: false });
    expect(mediaAnchorSeek({}, 10)).toEqual({ invalid: false });
  });
});
