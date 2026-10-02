// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeMediaProgress } from "@grudge-vault/domain";
import { mediaProgressLabel, useMediaProgress, type MediaProgressSubscription } from "./use-media-progress";

const value: NativeMediaProgress & { sessionId: string } = { sessionId: "current", mediaId: "media", mediaNumber: 1, mediaCount: 2,
  stage: "understanding", segmentNumber: 2, checkedDurationMs: 10_000, sourceDurationMs: 20_000 };

describe("operation-scoped media progress", () => {
  let root: Root | undefined;
  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
  afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });
  it("ignores other sessions, cancelled work and queued callbacks after unmount, and clears before retry", async () => {
    const session = { current: "current" as string | undefined };
    const active = { current: true };
    let current!: ReturnType<typeof useMediaProgress>; let listener!: Parameters<MediaProgressSubscription>[0];
    const unsubscribe = vi.fn(); const subscribe: MediaProgressSubscription = (callback) => { listener = callback; return unsubscribe; };
    function Probe() { current = useMediaProgress(subscribe, session, active); return createElement("div", null, current.progress ? mediaProgressLabel(current.progress) : "none"); }
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root?.render(createElement(Probe)));
    await act(async () => listener({ ...value, sessionId: "old" })); expect(current.progress).toBeUndefined();
    await act(async () => listener(value)); expect(current.progress?.segmentNumber).toBe(2);
    active.current = false;
    await act(async () => listener({ ...value, segmentNumber: 3 })); expect(current.progress?.segmentNumber).toBe(2);
    await act(async () => current.clear()); expect(current.progress).toBeUndefined();
    active.current = true; session.current = "retry";
    await act(async () => listener(value)); expect(current.progress).toBeUndefined();
    await act(async () => listener({ ...value, sessionId: "retry" })); expect(current.progress).toBeDefined();
    await act(async () => root?.unmount()); root = undefined;
    expect(unsubscribe).toHaveBeenCalledOnce(); await act(async () => listener(value));
  });
  it("labels real checked duration without claiming a total number of not-yet-exported clips", () => {
    expect(mediaProgressLabel(value)).toBe("附件 1/2：正在检查第 2 段；已检查 10.0 / 20.0 秒。");
    expect(mediaProgressLabel({ ...value, stage: "processing" })).toContain("私有处理副本");
    expect(mediaProgressLabel({ ...value, stage: "checked" })).toContain("已检查第 2 段");
    expect(mediaProgressLabel({ ...value, stage: "summarizing" })).toContain("汇总已检查");
  });
});
