// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenedZipImportProgress } from "@grudge-vault/domain";
import { dayOneImportActive, dayOneImportPhaseLabel, dayOneImportProgressLabel, dayOneImportUsageLabel, useDayOneImportProgress, type DayOneProgressRead } from "./use-dayone-import-progress";

const active: ScreenedZipImportProgress = { operationId: "current", phase: "screening", totalEntries: 4,
  included: 1, skipped: 1, review: 0, failed: 0, issueCount: 0, updatedAt: "2026-09-29T03:00:00Z" };

describe("Day One progress page lifecycle", () => {
  let root: Root | undefined; let current: ReturnType<typeof useDayOneImportProgress>;
  beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); });
  afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined;
    document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  const mount = async (read: DayOneProgressRead, onSettled = vi.fn()) => {
    function Probe() { current = useDayOneImportProgress(read, onSettled); return createElement("div"); }
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root?.render(createElement(Probe)));
  };
  it("restores active progress on remount, refreshes once after completion and clears on workspace change", async () => {
    let next: ScreenedZipImportProgress | null = active; const settled = vi.fn();
    const read = vi.fn(async () => next);
    await mount(read, settled); expect(current!.progress).toEqual(active); expect(current!.loading).toBe(false);
    await act(async () => root?.unmount()); root = undefined;
    await mount(read, settled); expect(dayOneImportActive(current!.progress)).toBe(true);
    next = { ...active, phase: "completed" };
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(current!.progress?.phase).toBe("completed"); expect(settled).toHaveBeenCalledOnce();
    next = { ...active, operationId: "retry", phase: "cancelled" };
    await act(async () => vi.advanceTimersByTimeAsync(1_000)); expect(settled).toHaveBeenCalledTimes(2);
    next = null; await act(async () => vi.advanceTimersByTimeAsync(1_000)); expect(current!.progress).toBeNull();
  });
  it("does not overlap reads and ignores a previous batch response after a new local start", async () => {
    let resolve!: (value: ScreenedZipImportProgress | null) => void;
    const read = vi.fn(() => new Promise<ScreenedZipImportProgress | null>((done) => { resolve = done; }));
    await mount(read); await act(async () => vi.advanceTimersByTimeAsync(3_000)); expect(read).toHaveBeenCalledOnce();
    await act(async () => current!.begin()); await act(async () => resolve({ ...active, phase: "completed" }));
    expect(current!.progress).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1_000)); expect(read).toHaveBeenCalledTimes(2);
    await act(async () => resolve({ ...active, operationId: "retry" }));
    expect(current!.progress?.operationId).toBe("retry");
  });
  it("recovers from one unanswered status read and rejects its late result", async () => {
    const pending: Array<(value: ScreenedZipImportProgress | null) => void> = [];
    const read = vi.fn(() => new Promise<ScreenedZipImportProgress | null>((resolve) => { pending.push(resolve); }));
    const settled = vi.fn();
    await mount(read, settled);
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(read).toHaveBeenCalledTimes(2);
    expect(current!.unavailable).toBe(true);
    expect(current!.loading).toBe(false);
    const paused = { ...active, phase: "paused" as const };
    await act(async () => pending[1]!(paused));
    expect(current!.progress).toEqual(paused); expect(current!.unavailable).toBe(false);
    await act(async () => pending[0]!({ ...active, phase: "completed" }));
    expect(current!.progress).toEqual(paused); expect(settled).not.toHaveBeenCalled();
  });
  it("bounds unanswered status reads without starting or resuming an import", async () => {
    const read = vi.fn(() => new Promise<ScreenedZipImportProgress | null>(() => {}));
    await mount(read);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(read).toHaveBeenCalledTimes(2);
    expect(current!.unavailable).toBe(true);
    expect(current!.progress).toBeNull();
    expect(current!.loading).toBe(false);
  });
  it("continues polling after an expired read finally releases a bounded slot", async () => {
    const pending: Array<(value: ScreenedZipImportProgress | null) => void> = [];
    const read = vi.fn(() => new Promise<ScreenedZipImportProgress | null>((resolve) => { pending.push(resolve); }));
    await mount(read);
    await act(async () => vi.advanceTimersByTimeAsync(11_000));
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => pending[0]!(null));
    expect(current!.progress).toBeNull(); expect(current!.unavailable).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => pending[2]!(active));
    expect(current!.progress).toEqual(active); expect(current!.unavailable).toBe(false);
  });
  it("restores a paused batch on page return without treating pause as completion or changing it", async () => {
    const paused = { ...active, phase: "paused" as const }; const settled = vi.fn();
    const read = vi.fn(async () => paused);
    await mount(read, settled); expect(current!.progress).toEqual(paused);
    await act(async () => root?.unmount()); root = undefined;
    await mount(read, settled); await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(dayOneImportActive(current!.progress)).toBe(true); expect(current!.progress).toEqual(paused);
    expect(settled).not.toHaveBeenCalled();
  });
  it("drops queued reads after unmount and removes the polling timer", async () => {
    let resolve!: (value: ScreenedZipImportProgress | null) => void; const settled = vi.fn();
    const read = vi.fn(() => new Promise<ScreenedZipImportProgress | null>((done) => { resolve = done; }));
    await mount(read, settled); await act(async () => root?.unmount()); root = undefined;
    await act(async () => resolve({ ...active, phase: "completed" }));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(read).toHaveBeenCalledOnce(); expect(settled).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("retries unavailable status reads without starting an import or exposing an error body", async () => {
    const read = vi.fn<DayOneProgressRead>().mockRejectedValueOnce(new Error("synthetic-private-path"))
      .mockResolvedValue(active);
    await mount(read); expect(current!.unavailable).toBe(true); expect(current!.progress).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(current!.unavailable).toBe(false); expect(current!.progress).toEqual(active);
  });
  it("labels checked counters and partial cancellation without claiming a resumed checkpoint or model percentage", () => {
    expect(dayOneImportProgressLabel(active)).toContain("已处理 2 条／包内共 4 条：收录 1，跳过 1，待确认 0，失败 0");
    expect(dayOneImportPhaseLabel({ ...active, phase: "previewing" })).toBe("正在检查导出包…");
    expect(dayOneImportProgressLabel({ ...active, phase: "stopping" })).toContain("当前模型请求可能仍会完成");
    expect(dayOneImportProgressLabel({ ...active, phase: "pausing" })).toContain("等待当前条目处理完");
    const paused = dayOneImportProgressLabel({ ...active, phase: "paused" });
    expect(paused).toContain("不重复检查已处理条目"); expect(paused).toContain("报告分析仍可继续");
    expect(paused).toContain("最多四小时"); expect(paused).toContain("退出后本批次不再恢复");
    expect(dayOneImportProgressLabel({ ...active, phase: "cancelled" })).toContain("不会从断点自动恢复");
    expect(dayOneImportProgressLabel({ ...active, totalEntries: null })).not.toContain("包内共");
    expect(dayOneImportProgressLabel({ ...active, phase: "failed", errorCode: "CLEANUP_FAILED" })).toContain("不要重复提交");
    expect(dayOneImportProgressLabel({ ...active, phase: "completed", summary: { ...active, totalEntries: 4,
      mediaEntries: 0, missingMedia: 0, failed: 1, issueCount: 1 } })).toContain("已检查 4 条：收录 1，跳过 1，待确认 0，失败 1");
  });

  it("labels unavailable, partial and reported zero usage without estimating money or including later reports", () => {
    expect(dayOneImportUsageLabel(undefined)).toContain("暂不可用");
    const partial = dayOneImportUsageLabel({ requests: 3, responses: 2, completeUsageResponses: 1, promptTokens: 20, completionTokens: 5 });
    expect(partial).toContain("输入 20、输出 5 token"); expect(partial).toContain("有 2 次请求未取得完整用量");
    expect(partial).toContain("不含报告等后续调用"); expect(partial).toContain("服务商账单");
    const zero = dayOneImportUsageLabel({ requests: 1, responses: 1, completeUsageResponses: 1, promptTokens: 0, completionTokens: 0 });
    expect(zero).toContain("输入 0、输出 0 token"); expect(zero).not.toContain("累计并不完整");
    expect(zero).not.toMatch(/[¥$]|免费|零费用/);
  });
});
