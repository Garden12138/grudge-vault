import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelUsageTotals, ScreenedZipImportProgress, ScreenedZipImportSummary } from "@grudge-vault/domain";

export type DayOneProgressRead = () => Promise<ScreenedZipImportProgress | null>;
const PROGRESS_READ_TIMEOUT_MS = 5_000;
const MAX_UNANSWERED_PROGRESS_READS = 2;
export function dayOneImportActive(value: ScreenedZipImportProgress | null): boolean {
  return Boolean(value && !["completed", "cancelled", "failed"].includes(value.phase));
}
export function dayOneImportSummaryLabel(value: ScreenedZipImportSummary): string {
  return `已检查 ${value.totalEntries} 条：收录 ${value.included}，跳过 ${value.skipped}，待确认 ${value.review}，失败 ${value.failed}；媒体缺失或不可检查 ${value.missingMedia}，包内问题 ${value.issueCount}。${value.failed > 0 ? "失败条目未计入跳过；请检查导出包和模型配置后重新选择 ZIP。" : ""}`;
}
export function dayOneImportUsageLabel(usage: ModelUsageTotals | undefined): string {
  const scope = "只统计本批筛选，含媒体分段和格式修复；不含报告等后续调用。费用以服务商账单为准。";
  if (!usage) return `筛选用量暂不可用。${scope}`;
  const missing = usage.requests - usage.completeUsageResponses;
  return `已发起 ${usage.requests.toLocaleString()} 次筛选模型请求；已返回用量：输入 ${usage.promptTokens.toLocaleString()}、输出 ${usage.completionTokens.toLocaleString()} token。${missing ? `有 ${missing.toLocaleString()} 次请求未取得完整用量，累计并不完整。` : ""}${scope}`;
}
export function dayOneImportPhaseLabel(value: ScreenedZipImportProgress): string {
  const labels: Record<ScreenedZipImportProgress["phase"], string> = {
    selecting: "正在选择 ZIP…", previewing: "正在检查导出包…", confirming: "等待导入确认…",
    screening: "正在逐条筛选…", pausing: "正在暂停筛选…", paused: "筛选已暂停。",
    stopping: "正在停止导入…", completed: "本次导入已完成。",
    cancelled: "本次导入已取消或停止。", failed: "本次导入未完成。"
  };
  return labels[value.phase];
}
export function dayOneImportProgressLabel(value: ScreenedZipImportProgress): string {
  if (value.phase === "completed" && value.summary) return dayOneImportSummaryLabel(value.summary);
  const processed = value.included + value.skipped + value.review + value.failed;
  const counts = `已处理 ${processed} 条${value.totalEntries === null ? "" : `／包内共 ${value.totalEntries} 条`}：收录 ${value.included}，跳过 ${value.skipped}，待确认 ${value.review}，失败 ${value.failed}；包内问题 ${value.issueCount}。`;
  const retained = ["stopping", "cancelled", "failed"].includes(value.phase)
    ? " 已处理的正式记录和待确认项会保留；再次导入不会从断点自动恢复。" : "";
  const warning = value.phase === "stopping" ? " 当前模型请求可能仍会完成，之后会清理临时文件。" : "";
  const pause = value.phase === "pausing" ? " 正等待当前条目处理完；之后不再开始新条目。"
    : value.phase === "paused" ? " 继续筛选会接着当前批次处理，不重复检查已处理条目。" : "";
  const pauseBoundary = ["pausing", "paused"].includes(value.phase)
    ? " 已保存记录的报告分析仍可继续；暂停最多四小时，锁定、关闭工作区或退出后本批次不再恢复。" : "";
  const failure = value.phase !== "failed" ? "" : value.errorCode === "CLEANUP_FAILED"
    ? " 清理临时内容失败，请先检查工作区状态，不要重复提交。" : " 请检查导出包和模型配置后重试。";
  return `${dayOneImportPhaseLabel(value)} ${counts}${warning}${pause}${pauseBoundary}${retained}${failure}`;
}

/** Reads only the main process's volatile aggregate; never starts or resumes an import. */
export function useDayOneImportProgress(read: DayOneProgressRead, onSettled: () => void) {
  const [progress, setProgress] = useState<ScreenedZipImportProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const generation = useRef(0);
  const settled = useRef(onSettled);
  useEffect(() => { settled.current = onSettled; }, [onSettled]);
  useEffect(() => {
    let disposed = false; let inFlight = 0; let timelyReads = 0; let latestIssued = 0;
    let lastSettled: string | undefined;
    const deadlines = new Set<ReturnType<typeof globalThis.setTimeout>>();
    const poll = async () => {
      // IPC promises cannot be cancelled. Allow one replacement read after a timeout,
      // but cap unanswered requests so a broken bridge cannot queue them indefinitely.
      if (disposed || inFlight >= MAX_UNANSWERED_PROGRESS_READS || timelyReads > 0) return;
      inFlight += 1; timelyReads += 1;
      const version = generation.current;
      const sequence = ++latestIssued;
      let expired = false;
      const deadline = globalThis.setTimeout(() => {
        expired = true;
        timelyReads -= 1;
        if (!disposed && version === generation.current && sequence === latestIssued) {
          setLoading(false); setUnavailable(true);
        }
      }, PROGRESS_READ_TIMEOUT_MS);
      deadlines.add(deadline);
      try {
        const next = await read();
        if (disposed || expired || version !== generation.current || sequence !== latestIssued) return;
        setProgress((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        setLoading(false); setUnavailable(false);
        if (next && !dayOneImportActive(next) && lastSettled !== next.operationId) {
          lastSettled = next.operationId;
          settled.current();
        }
      } catch {
        if (!disposed && !expired && version === generation.current && sequence === latestIssued) {
          setLoading(false); setUnavailable(true);
        }
      } finally {
        globalThis.clearTimeout(deadline); deadlines.delete(deadline);
        if (!expired) timelyReads -= 1;
        inFlight -= 1;
      }
    };
    void poll();
    const timer = globalThis.setInterval(() => { void poll(); }, 1_000);
    return () => {
      disposed = true;
      globalThis.clearInterval(timer);
      for (const deadline of deadlines) globalThis.clearTimeout(deadline);
      deadlines.clear();
    };
  }, [read]);
  const begin = useCallback(() => {
    generation.current += 1;
    setProgress(null); setUnavailable(false);
  }, []);
  return { progress, loading, unavailable, begin };
}
