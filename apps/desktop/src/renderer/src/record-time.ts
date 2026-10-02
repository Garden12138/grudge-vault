import type { EventRecord } from "@grudge-vault/domain";
import { projectRecordDate, recordTimeZone } from "@grudge-vault/shared";

type RecordTime = Pick<EventRecord, "occurredAt" | "recordedAt" | "occurredAtSource" | "occurredAtPrecision">;

function formatInstant(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  const beforeCommonEra = new Intl.DateTimeFormat("en-US", { timeZone, era: "short", year: "numeric" })
    .formatToParts(date).some(({ type, value }) => type === "era" && value === "BC");
  return new Intl.DateTimeFormat("zh-CN", { ...options, timeZone,
    ...(beforeCommonEra ? { era: "short" as const } : {}) }).format(date);
}

export function recordTimeSourceLabel(record: RecordTime): string | undefined {
  return record.occurredAtSource ? { source: "来自原始材料", ai: "AI 整理", user: "你已补充" }[record.occurredAtSource] : undefined;
}

export function dateLabel(value: string, timeZone?: string): string {
  // A calendar date or month is not a UTC instant. Never fill missing precision.
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (isCalendarDate(value)) {
      const [year, month, day] = value.split("-");
      return `${year}年${Number(month)}月${Number(day)}日`;
    }
    return value;
  }
  if (!isZonedInstant(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const zone = recordTimeZone(timeZone);
  return zone ? formatInstant(date, zone, { year: "numeric", month: "long", day: "numeric" }) : value;
}

function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isZonedInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && isCalendarDate(value.slice(0, 10));
}

function rangeLabel(time: Extract<RecordTime["occurredAt"], { kind: "range" }>): string | undefined {
  const from = time.from?.trim() ? time.from : undefined;
  const to = time.to?.trim() ? time.to : undefined;
  return from || to ? `${from ?? "?"} — ${to ?? "?"}` : undefined;
}

function occurrenceLabel(record: RecordTime, timeZone?: string): string {
  const time = record.occurredAt;
  if (time.kind === "instant") {
    const date = new Date(time.value);
    const zone = recordTimeZone(timeZone);
    return zone && isZonedInstant(time.value) && !Number.isNaN(date.getTime())
      ? formatInstant(date, zone, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) : time.value;
  }
  if (time.kind === "date" || time.kind === "month") return time.value;
  if (time.kind === "range") return rangeLabel(time) ?? "时间范围待补充";
  if (time.kind === "relative") return time.text;
  return `${dateLabel(record.recordedAt, timeZone)} · 记录日期`;
}

export function occurrenceTimeLabel(record: RecordTime, timeZone?: string): string {
  const label = occurrenceLabel(record, timeZone);
  const precision = record.occurredAtPrecision === "approximate" ? "（大约时间）" : "";
  return `${label}${precision}`;
}

export function temporalLabel(record: RecordTime, timeZone?: string): string {
  const label = occurrenceTimeLabel(record, timeZone);
  const zone = recordTimeZone(timeZone);
  const fallback = zone && projectRecordDate(record, zone)?.basis === "recorded" && record.occurredAt.kind !== "unknown";
  return `${label}${fallback ? ` · ${dateLabel(record.recordedAt, timeZone)} · 记录日期` : ""}`;
}

export function timelineGroupLabel(record: RecordTime, timeZone?: string): string {
  const time = record.occurredAt;
  const zone = recordTimeZone(timeZone);
  const fallback = zone && projectRecordDate(record, zone)?.basis === "recorded";
  const recorded = `${dateLabel(record.recordedAt, timeZone)} · 记录日期`;
  const precision = record.occurredAtPrecision === "approximate" ? "（大约时间）" : "";
  if (time.kind === "instant" || time.kind === "date") return fallback ? recorded : `${dateLabel(time.value, timeZone)}${precision}`;
  if (time.kind === "month") return fallback ? recorded : `${time.value}${precision}`;
  if (time.kind === "range") {
    const label = rangeLabel(time);
    if (label) return `${label} · 时间范围${fallback ? ` · ${recorded}` : ""}`;
  }
  return recorded;
}
