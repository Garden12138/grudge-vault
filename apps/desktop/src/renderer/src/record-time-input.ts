import { z } from "zod";
import type { TemporalValue } from "@grudge-vault/domain";
import { projectRecordDate } from "@grudge-vault/shared";

export interface TimeEditorDraft {
  kind: TemporalValue["kind"];
  value: string;
  from: string;
  to: string;
  text: string;
  anchorRef?: string;
}

export function timeEditorDraft(value?: TemporalValue): TimeEditorDraft {
  return { kind: value?.kind === "unknown" || !value ? "date" : value.kind,
    value: value && "value" in value ? value.value : "",
    from: value?.kind === "range" ? value.from ?? "" : "",
    to: value?.kind === "range" ? value.to ?? "" : "",
    text: value?.kind === "relative" ? value.text : "",
    ...(value?.kind === "relative" && value.anchorRef ? { anchorRef: value.anchorRef } : {}) };
}

const month = /^\d{4}-(0[1-9]|1[0-2])$/;
const explicitInstant = z.iso.datetime({ offset: true });
const date = z.iso.date();
type TimeEditorResult = { value: TemporalValue; error?: never } | { value?: never; error: string };

export function timeEditorValue(draft: TimeEditorDraft): TimeEditorResult {
  const value = draft.value.trim();
  if (draft.kind === "unknown") return { value: { kind: "unknown" } };
  if (draft.kind === "date") return date.safeParse(value).success
    ? { value: { kind: "date", value } } : { error: "请填写有效日期，不需要填写时刻。" };
  if (draft.kind === "month") return month.test(value)
    ? { value: { kind: "month", value } } : { error: "请填写有效月份，例如 2026-09；不需要补出具体某一天。" };
  if (draft.kind === "instant") {
    if (!explicitInstant.safeParse(value).success) return { error: "具体时刻需要明确时区，例如 2026-10-02T15:30:00+08:00。" };
    // Main accepts UTC instants. An explicit offset can be normalized without guessing the user's zone.
    // Do not silently discard sub-millisecond digits while converting an offset value.
    if (!value.endsWith("Z") && /\.\d{4,}/.test(value)) return { error: "带时区偏移的时刻最多保留三位小数；也可填写原始 UTC（Z）时刻。" };
    return { value: { kind: "instant", value: value.endsWith("Z") ? value : new Date(value).toISOString() } };
  }
  if (draft.kind === "relative") {
    const text = draft.text.trim();
    if (!text || text.length > 200) return { error: "请填写不超过 200 字符的时间描述；不会自动推算具体日期。" };
    return { value: { kind: "relative", text, ...(draft.anchorRef ? { anchorRef: draft.anchorRef } : {}) } };
  }
  const from = draft.from.trim(), to = draft.to.trim();
  if (!from && !to) return { error: "请至少填写范围的一端；完全不记得时请选择“尚不确定”。" };
  if (from.length > 200 || to.length > 200) return { error: "范围的每一端请不超过 200 字符。" };
  const result: TemporalValue = { kind: "range", ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const known = (text: string) => date.safeParse(text).success || month.test(text) || explicitInstant.safeParse(text).success;
  if (from && to && known(from) && known(to) && projectRecordDate({ occurredAt: result,
    recordedAt: "2000-01-01T00:00:00Z" }, "UTC")?.basis === "recorded") {
    return { error: "范围终点不能早于起点；月份仍按完整月份比较。" };
  }
  return { value: result };
}
