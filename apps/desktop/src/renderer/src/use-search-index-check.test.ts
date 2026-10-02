// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordSearchIndexStatus } from "@grudge-vault/domain";
import { useSearchIndexCheckRefresh } from "./use-search-index-check";

const status = (state: RecordSearchIndexStatus["state"]): RecordSearchIndexStatus => ({ state,
  available: true, enabled: state !== "paused", inputModalities: ["text"], queryModalities: ["text"], fragmentCount: 50_000 });

describe("read-only index check refresh", () => {
  let root: Root | undefined;
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
  afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined;
    document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  const mount = async (read: () => Promise<RecordSearchIndexStatus>, publish = vi.fn(), failed = vi.fn()) => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    function Probe({ state }: { state: RecordSearchIndexStatus["state"] }) {
      useSearchIndexCheckRefresh(state, read, publish, failed); return null;
    }
    const render = async (state: RecordSearchIndexStatus["state"]) => {
      await act(async () => root?.render(createElement(Probe, { state })));
    };
    await render("checking"); return { render, publish, failed };
  };

  it("publishes completion without a job event and then stops reading", async () => {
    const read = vi.fn().mockResolvedValueOnce(status("checking")).mockResolvedValue(status("ready"));
    const view = await mount(read);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(view.publish).toHaveBeenLastCalledWith(status("checking"));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(view.publish).toHaveBeenLastCalledWith(status("ready"));
    await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(["paused", "unmounted"] as const)("ignores a late check reply after the view is %s", async (change) => {
    let resolve!: (value: RecordSearchIndexStatus) => void;
    const read = vi.fn(() => new Promise<RecordSearchIndexStatus>((done) => { resolve = done; }));
    const view = await mount(read);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    if (change === "paused") await view.render("paused");
    else await act(async () => { root?.unmount(); root = undefined; });
    await act(async () => resolve(status("ready")));
    expect(view.publish).not.toHaveBeenCalled(); expect(view.failed).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(read).toHaveBeenCalledOnce();
  });

  it("does not overlap a slow status read", async () => {
    let resolve!: (value: RecordSearchIndexStatus) => void;
    const read = vi.fn(() => new Promise<RecordSearchIndexStatus>((done) => { resolve = done; }));
    await mount(read);
    await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(read).toHaveBeenCalledOnce();
    await act(async () => resolve(status("ready")));
    await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(read).toHaveBeenCalledOnce();
  });

  it("bounds consecutive failed reads rather than polling indefinitely", async () => {
    const read = vi.fn().mockRejectedValue(new Error("Synthetic unavailable status"));
    const view = await mount(read);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(read).toHaveBeenCalledTimes(3); expect(view.failed).toHaveBeenCalledTimes(3); expect(view.publish).not.toHaveBeenCalled();
  });
});
