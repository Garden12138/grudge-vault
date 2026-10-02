import { useCallback, useEffect, useState, type RefObject } from "react";
import type { NativeMediaProgress } from "@grudge-vault/domain";

export type MediaProgressSubscription = (listener: (value: NativeMediaProgress & { sessionId: string }) => void) => () => void;

/** A stale operation must never replace the current operation's volatile progress. */
export function useMediaProgress(subscribe: MediaProgressSubscription, sessionId: RefObject<string | undefined>, active: RefObject<boolean>) {
  const [progress, setProgress] = useState<NativeMediaProgress>();
  useEffect(() => {
    let disposed = false;
    const unsubscribe = subscribe((value) => {
      if (!disposed && active.current && sessionId.current === value.sessionId) setProgress(value);
    });
    return () => { disposed = true; unsubscribe(); };
  }, [active, sessionId, subscribe]);
  const clear = useCallback(() => setProgress(undefined), []);
  return { progress, clear };
}

export function mediaProgressLabel(value: NativeMediaProgress): string {
  const prefix = `附件 ${value.mediaNumber}/${value.mediaCount}`;
  if (value.stage === "processing") return `${prefix}：正在准备私有处理副本…`;
  if (value.stage === "summarizing") return "正在汇总已检查的媒体描述…";
  const time = value.sourceDurationMs !== undefined
    ? `；已检查 ${(value.checkedDurationMs / 1_000).toFixed(1)} / ${(value.sourceDurationMs / 1_000).toFixed(1)} 秒` : "";
  return `${prefix}：${value.stage === "understanding" ? "正在检查" : "已检查"}第 ${value.segmentNumber} 段${time}。`;
}
