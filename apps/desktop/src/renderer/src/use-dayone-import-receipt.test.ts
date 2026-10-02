// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenedZipImportReceipt } from "@grudge-vault/domain";
import { dayOneImportReceiptLabel, useDayOneImportReceipt, type DayOneReceiptRead } from "./use-dayone-import-receipt";

const receipt: ScreenedZipImportReceipt = { finishedAt: "2026-09-29T08:30:00.000Z", outcome: "completed", totalEntries: 3,
  included: 1, skipped: 1, review: 1, failed: 0, issueCount: 0, mediaEntries: 0, missingMedia: 0 };
describe("read-only terminal import metadata", () => {
  let root: Root | undefined; let current: ReturnType<typeof useDayOneImportReceipt>;
  beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
  afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined;
    document.body.replaceChildren(); vi.unstubAllGlobals(); });
  const mount = async (read: DayOneReceiptRead) => {
    function Probe() { current = useDayOneImportReceipt(read); return createElement("div"); }
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root?.render(createElement(Probe)));
  };
  it("loads existing metadata on remount and distinguishes no saved receipt from read failure", async () => {
    const read = vi.fn(async (): Promise<ScreenedZipImportReceipt | null> => receipt); await mount(read);
    expect(current!.receipt).toEqual(receipt); expect(current!.loading).toBe(false); expect(read).toHaveBeenCalledOnce();
    await act(async () => root?.unmount()); root = undefined;
    await mount(read); expect(read).toHaveBeenCalledTimes(2);
    read.mockRejectedValueOnce(new Error("private-synthetic-error"));
    await act(async () => current!.reload()); expect(current!.unavailable).toBe(true); expect(current!.receipt).toEqual(receipt);
    read.mockResolvedValueOnce(null);
    await act(async () => current!.reload()); expect(current!.receipt).toBeNull(); expect(current!.unavailable).toBe(false);
  });
  it("ignores late reads and errors after a newer request or unmount", async () => {
    const pending: Array<{ resolve(value: ScreenedZipImportReceipt | null): void; reject(cause: Error): void }> = [];
    const read = vi.fn(() => new Promise<ScreenedZipImportReceipt | null>((resolve, reject) => pending.push({ resolve, reject })));
    await mount(read); let latest!: Promise<void>;
    await act(async () => { latest = current!.reload(); });
    await act(async () => { pending[1]!.resolve(receipt); await latest; });
    await act(async () => pending[0]!.resolve(null)); expect(current!.receipt).toEqual(receipt);
    await act(async () => { void current!.reload(); }); await act(async () => root?.unmount()); root = undefined;
    await act(async () => pending[2]!.reject(new Error("synthetic-private-late-read-error"))); expect(current!.receipt).toEqual(receipt);
  });
  it("labels incomplete outcomes and unknown media without claiming success or a resumable checkpoint", () => {
    const partial: ScreenedZipImportReceipt = { finishedAt: receipt.finishedAt, outcome: "cancelled", totalEntries: 10,
      included: 1, skipped: 1, review: 0, failed: 0, issueCount: 0 };
    expect(dayOneImportReceiptLabel(partial)).toContain("已取消或停止，未扫描完整批次");
    expect(dayOneImportReceiptLabel(partial)).toContain("已处理 2 条／所选包共 10 条");
    expect(dayOneImportReceiptLabel(partial)).toContain("媒体缺失情况未取得最终汇总");
    expect(dayOneImportReceiptLabel({ ...partial, outcome: "failed", errorCode: "CLEANUP_FAILED" })).toContain("批次未完成");
    expect(dayOneImportReceiptLabel(receipt)).toContain("扫描完成");
    expect(dayOneImportReceiptLabel(receipt)).toContain("不是可恢复的导入断点");
  });
});
