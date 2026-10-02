import { afterEach, describe, expect, it, vi } from "vitest";
import { DayOneImportPause, MAX_DAYONE_PAUSE_MS } from "./dayone-import-pause";

describe("entry-boundary Day One pause gate", () => {
  afterEach(() => vi.useRealTimers());

  it("lets active work finish but waits before starting the next item and resumes the same boundary", async () => {
    const phases: string[] = []; const expired = vi.fn();
    const gate = new DayOneImportPause((phase) => phases.push(phase), expired); const signal = new AbortController().signal;
    await gate.beforeItem(signal);
    expect(gate.pause()).toBe(true); expect(gate.pause()).toBe(false);
    let passed = false;
    const pending = gate.beforeItem(signal).then(() => { passed = true; });
    await Promise.resolve(); expect(passed).toBe(false); expect(phases).toEqual(["pausing", "paused"]);
    expect(gate.resume()).toBe(true); expect(gate.resume()).toBe(false);
    await pending; expect(passed).toBe(true); expect(phases).toEqual(["pausing", "paused", "screening"]);
    await gate.beforeItem(signal); expect(expired).not.toHaveBeenCalled(); gate.dispose();
  });

  it("withdraws a pause request before the next boundary without claiming it was paused", async () => {
    const changed = vi.fn(); const gate = new DayOneImportPause(changed, vi.fn());
    gate.pause(); gate.resume(); await gate.beforeItem(new AbortController().signal);
    expect(changed.mock.calls.map(([phase]) => phase)).toEqual(["pausing", "screening"]); gate.dispose();
  });

  it("does not let queued continuation pass a newer pause or abort", async () => {
    const gate = new DayOneImportPause(vi.fn(), vi.fn()); const controller = new AbortController();
    gate.pause(); let passed = false;
    const pending = gate.beforeItem(controller.signal).then(() => { passed = true; });
    gate.resume(); gate.pause(); await Promise.resolve(); expect(passed).toBe(false);
    const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    gate.resume(); controller.abort(); await failure; expect(passed).toBe(false); gate.dispose();
  });

  it("rejects aborted waits, releases listeners and cannot revive a disposed batch", async () => {
    const gate = new DayOneImportPause(vi.fn(), vi.fn()); const controller = new AbortController();
    const removal = vi.spyOn(controller.signal, "removeEventListener"); gate.pause();
    const pending = gate.beforeItem(controller.signal); const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await failure; expect(removal).toHaveBeenCalledOnce();
    gate.dispose(); expect(gate.pause()).toBe(false); expect(gate.resume()).toBe(false);
    await expect(gate.beforeItem(new AbortController().signal)).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
  });

  it("handles abort before entry and dispose while paused without leaking an unresolved waiter", async () => {
    const gate = new DayOneImportPause(vi.fn(), vi.fn()); const controller = new AbortController(); controller.abort();
    await expect(gate.beforeItem(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    gate.pause(); const first = gate.beforeItem(new AbortController().signal); const second = gate.beforeItem(new AbortController().signal);
    const failures = [expect(first).rejects.toMatchObject({ code: "IMPORT_CANCELLED" }), expect(second).rejects.toMatchObject({ code: "IMPORT_CANCELLED" })];
    gate.dispose(); await Promise.all(failures);
  });

  it("bounds pauses to four hours and clears the timer on resume or cleanup", async () => {
    vi.useFakeTimers(); const expired = vi.fn(); const gate = new DayOneImportPause(vi.fn(), expired);
    gate.pause(); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(MAX_DAYONE_PAUSE_MS - 1); expect(expired).not.toHaveBeenCalled();
    gate.resume(); expect(vi.getTimerCount()).toBe(0);
    gate.pause(); const pending = gate.beforeItem(new AbortController().signal);
    const failure = expect(pending).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
    await vi.advanceTimersByTimeAsync(MAX_DAYONE_PAUSE_MS); await failure;
    expect(expired).toHaveBeenCalledOnce(); expect(gate.resume()).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the gate functional if a progress observer throws", async () => {
    const gate = new DayOneImportPause(() => { throw new Error("synthetic observation failure"); }, vi.fn());
    gate.pause(); const pending = gate.beforeItem(new AbortController().signal); gate.resume(); await pending; gate.dispose();
  });

  it("releases an expired wait even if its expiry observer fails", async () => {
    vi.useFakeTimers();
    const gate = new DayOneImportPause(vi.fn(), () => { throw new Error("synthetic expiry failure"); });
    gate.pause(); const pending = gate.beforeItem(new AbortController().signal);
    const failure = expect(pending).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
    await vi.advanceTimersByTimeAsync(MAX_DAYONE_PAUSE_MS); await failure;
    expect(gate.resume()).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
});
