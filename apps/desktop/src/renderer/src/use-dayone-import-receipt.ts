import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenedZipImportReceipt } from "@grudge-vault/domain";

export type DayOneReceiptRead = () => Promise<ScreenedZipImportReceipt | null>;
export const dayOneImportEndTimeLabel = (finishedAt: string): string =>
  `导入结束时间：${new Date(finishedAt).toLocaleString("zh-CN")}（本机时间）`;
export function dayOneImportReceiptLabel(value: ScreenedZipImportReceipt): string {
  const outcome = { completed: "扫描完成", cancelled: "已取消或停止，未扫描完整批次", failed: "批次未完成" }[value.outcome];
  const processed = value.included + value.skipped + value.review + value.failed;
  const media = value.missingMedia === undefined ? "媒体缺失情况未取得最终汇总" : `媒体缺失或不可检查 ${value.missingMedia}`;
  return `最近已保存的批次摘要：${outcome}。已处理 ${processed} 条${value.totalEntries === null ? "，包内总数未取得" : `／所选包共 ${value.totalEntries} 条`}：收录 ${value.included}，跳过 ${value.skipped}，待确认 ${value.review}，失败 ${value.failed}；${media}，包内问题 ${value.issueCount}。${value.errorCode ? `错误代码：${value.errorCode}。` : ""}这不是 Day One 全部历史的同步状态，也不是可恢复的导入断点。`;
}

/** Read-only metadata lifecycle. A receipt never starts, retries or resumes work. */
export function useDayOneImportReceipt(read: DayOneReceiptRead) {
  const [receipt, setReceipt] = useState<ScreenedZipImportReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const mounted = useRef(false); const generation = useRef(0);
  const reload = useCallback(async () => {
    if (!mounted.current) return;
    const version = ++generation.current;
    setLoading(true);
    try {
      const next = await read();
      if (mounted.current && version === generation.current) { setReceipt(next); setUnavailable(false); }
    } catch {
      if (mounted.current && version === generation.current) setUnavailable(true);
    } finally {
      if (mounted.current && version === generation.current) setLoading(false);
    }
  }, [read]);
  useEffect(() => {
    mounted.current = true; void reload();
    return () => { mounted.current = false; generation.current += 1; };
  }, [reload]);
  return { receipt, loading, unavailable, reload };
}
