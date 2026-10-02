// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRecordDetail } from "@grudge-vault/domain";
import { useRecordSelection } from "./use-record-selection";

function detail(id = "record-a", revision = 1, state: EventRecordDetail["record"]["reportState"] = "running"): EventRecordDetail {
  const now = "2026-09-28T00:00:00.000Z";
  return {
    record: {
      id, origin: "manual", categories: ["rights"], title: id, summary: `revision-${revision}-${state}`, revision,
      occurredAt: { kind: "unknown" }, recordedAt: now, reportState: state, sourceUpdated: false,
      sourceReviewRequired: false, attachmentCount: 0, createdAt: now, updatedAt: now
    },
    source: { id: `source-${id}`, recordId: id, origin: "manual", sourceVersion: "v1", contentHash: "hash", recordedAt: now, createdAt: now },
    attachments: [], overrides: []
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function accessPort() {
  const listeners = new Set<() => void>();
  return {
    listeners,
    read: vi.fn<(id: string) => Promise<EventRecordDetail>>(),
    subscribe: vi.fn((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    emit() { for (const listener of [...listeners]) listener(); }
  };
}

describe("live record selection", () => {
  let root: Root | undefined;
  let current: ReturnType<typeof useRecordSelection>;
  beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    root = undefined;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });
  const mount = async (access: ReturnType<typeof accessPort>) => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    function Probe() {
      current = useRecordSelection(access);
      return createElement("div", null, current.selected?.record.summary ?? "no selection");
    }
    await act(async () => { root?.render(createElement(Probe)); });
  };

  it("subscribes before opening and refreshes an analysis completion without reopening", async () => {
    const access = accessPort();
    access.read.mockImplementation(async () => { expect(access.listeners.size).toBe(1); return detail(); });
    await mount(access);
    await act(async () => { expect(await current.open("record-a")).toBe(true); });
    expect(current.selected?.record.reportState).toBe("running");
    access.read.mockResolvedValue(detail("record-a", 1, "complete"));
    await act(async () => { access.emit(); });
    expect(current.selected?.record.reportState).toBe("complete");
    expect(access.subscribe).toHaveBeenCalledTimes(1);
  });

  it("does not lose a completion notification received during the initial read", async () => {
    const access = accessPort();
    const initial = deferred<EventRecordDetail>();
    access.read.mockReturnValueOnce(initial.promise).mockResolvedValue(detail("record-a", 1, "complete"));
    await mount(access);
    let opened!: Promise<boolean>;
    await act(async () => { opened = current.open("record-a"); });
    await act(async () => { access.emit(); });
    expect(current.selected?.record.reportState).toBe("complete");
    await act(async () => { initial.resolve(detail()); expect(await opened).toBe(false); });
    expect(current.selected?.record.reportState).toBe("complete");
  });

  it("ignores a late refresh after returning to the list", async () => {
    const access = accessPort();
    access.read.mockResolvedValueOnce(detail());
    await mount(access);
    await act(async () => { await current.open("record-a"); });
    const late = deferred<EventRecordDetail>();
    access.read.mockReturnValueOnce(late.promise);
    await act(async () => { access.emit(); current.close(); });
    await act(async () => { late.resolve(detail("record-a", 1, "complete")); });
    expect(current.selected).toBeNull();
    expect(current.error).toBeNull();
    await act(async () => { access.emit(); });
    expect(access.read).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"])("keeps a newer selection when an older request returns %s", async (outcome) => {
    const access = accessPort();
    const old = deferred<EventRecordDetail>();
    access.read.mockReturnValueOnce(old.promise).mockResolvedValue(detail("record-b", 1, "complete"));
    await mount(access);
    let opened!: Promise<boolean>;
    await act(async () => { opened = current.open("record-a"); await current.open("record-b"); });
    await act(async () => {
      if (outcome === "success") old.resolve(detail()); else old.reject(new Error("old request failed"));
      expect(await opened).toBe(false);
    });
    expect(current.selected?.record.id).toBe("record-b");
    expect(current.error).toBeNull();
  });

  it("invalidates old reads when applying an edit and catches up after the edit response", async () => {
    const access = accessPort();
    const late = deferred<EventRecordDetail>();
    access.read.mockResolvedValueOnce(detail()).mockReturnValueOnce(late.promise)
      .mockResolvedValue(detail("record-a", 2, "complete"));
    await mount(access);
    await act(async () => { await current.open("record-a"); });
    await act(async () => { access.emit(); });
    await act(async () => { await current.reload(detail("record-a", 2, "running")); });
    await act(async () => { late.resolve(detail("record-a", 1, "failed")); });
    expect(current.selected?.record.revision).toBe(2);
    expect(current.selected?.record.reportState).toBe("complete");
    expect(access.read).toHaveBeenCalledTimes(3);
  });

  it("preserves a successful detail on refresh failure and clears the error after retry", async () => {
    const access = accessPort();
    const failure = new Error("synthetic refresh failed");
    access.read.mockResolvedValueOnce(detail()).mockRejectedValueOnce(failure).mockResolvedValue(detail("record-a", 1, "complete"));
    await mount(access);
    await act(async () => { await current.open("record-a"); access.emit(); });
    expect(current.selected?.record.reportState).toBe("running");
    expect(current.error).toBe(failure);
    await act(async () => { expect(await current.reload()).toBe(true); });
    expect(current.selected?.record.reportState).toBe("complete");
    expect(current.error).toBeNull();
  });

  it("unsubscribes and refuses in-flight or retained callbacks after unmount", async () => {
    const access = accessPort();
    const late = deferred<EventRecordDetail>();
    access.read.mockReturnValue(late.promise);
    await mount(access);
    const retained = [...access.listeners][0]!;
    let opened!: Promise<boolean>;
    await act(async () => { opened = current.open("record-a"); root?.unmount(); root = undefined; });
    await act(async () => { late.resolve(detail()); retained(); expect(await opened).toBe(false); });
    expect(access.listeners.size).toBe(0);
    expect(access.read).toHaveBeenCalledTimes(1);
  });

  it("rejects an older revision or an edit belonging to another record", async () => {
    const access = accessPort();
    access.read.mockResolvedValueOnce(detail("record-a", 2)).mockResolvedValue(detail("record-a", 1));
    await mount(access);
    await act(async () => { await current.open("record-a"); access.emit(); });
    expect(current.selected?.record.revision).toBe(2);
    await act(async () => { expect(await current.reload(detail("record-b", 3))).toBe(false); });
    expect(current.selected?.record.id).toBe("record-a");
    expect(access.read).toHaveBeenCalledTimes(2);
  });
});
