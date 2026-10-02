import type { EventRecord } from "@grudge-vault/domain";

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
type RecordTime = Pick<EventRecord, "occurredAt" | "recordedAt">;

export interface RecordDateProjection {
  lowerDay?: number;
  upperDay?: number;
  sortKey: string;
  basis: "occurred" | "recorded";
}
export interface RecordDateFilter {
  fromDay?: number;
  toDay?: number;
  timeZone: string;
}

function formatter(timeZone: string): Intl.DateTimeFormat | undefined {
  if (!timeZone || timeZone.length > 100 || !/^[A-Za-z0-9_:+/-]+$/.test(timeZone)) return undefined;
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  try {
    const value = new Intl.DateTimeFormat("en-US", { calendar: "iso8601", numberingSystem: "latn", timeZone,
      era: "short", year: "numeric", month: "2-digit", day: "2-digit" });
    if (formatters.size >= 16) formatters.delete(formatters.keys().next().value!);
    formatters.set(timeZone, value);
    return value;
  } catch { return undefined; }
}

export function recordTimeZone(value?: string): string | undefined {
  return formatter(value ?? new Intl.DateTimeFormat().resolvedOptions().timeZone)?.resolvedOptions().timeZone;
}

function civilDay(year: number, month: number, day: number): number | undefined {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.getTime() / DAY_MS : undefined;
}

export function calendarDateDay(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? civilDay(Number(match[1]), Number(match[2]), Number(match[3])) : undefined;
}

export function resolveRecordDateFilter(input: { from?: string; to?: string; timeZone?: string }): RecordDateFilter | undefined {
  const timeZone = recordTimeZone(input.timeZone);
  const fromDay = input.from === undefined ? undefined : calendarDateDay(input.from);
  const toDay = input.to === undefined ? undefined : calendarDateDay(input.to);
  if (!timeZone || input.from !== undefined && fromDay === undefined || input.to !== undefined && toDay === undefined ||
    fromDay !== undefined && toDay !== undefined && fromDay > toDay) return undefined;
  return { timeZone, ...(fromDay !== undefined ? { fromDay } : {}), ...(toDay !== undefined ? { toDay } : {}) };
}

function sortKey(day: number, instantMs?: number): string {
  // Calendar units have no invented clock time. The second key only orders known instants.
  const withinDay = instantMs === undefined ? 0 : instantMs + 63_000_000_000_000;
  return `${String(day + 100_000_000).padStart(9, "0")}:${String(withinDay).padStart(15, "0")}`;
}

interface Endpoint { lower: number; upper: number; lowerKey: string; upperKey: string; instantMs?: number }
function endpoint(value: string | undefined, timeZone: string): Endpoint | undefined {
  if (!value) return undefined;
  const day = calendarDateDay(value);
  if (day !== undefined) return { lower: day, upper: day, lowerKey: sortKey(day), upperKey: sortKey(day) };
  const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (month) {
    const year = Number(month[1]); const number = Number(month[2]);
    const lower = civilDay(year, number, 1)!;
    const next = new Date(0); next.setUTCFullYear(year, number, 1); next.setUTCHours(0, 0, 0, 0);
    const upper = next.getTime() / DAY_MS - 1;
    return { lower, upper, lowerKey: sortKey(lower), upperKey: sortKey(upper) };
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    calendarDateDay(value.slice(0, 10)) === undefined) return undefined;
  const instantMs = Date.parse(value);
  if (!Number.isFinite(instantMs)) return undefined;
  const parts = formatter(timeZone)?.formatToParts(new Date(instantMs));
  if (!parts) return undefined;
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  const displayedYear = Number(part("year"));
  const localDay = civilDay(part("era") === "BC" ? 1 - displayedYear : displayedYear, Number(part("month")), Number(part("day")));
  if (localDay === undefined) return undefined;
  return { lower: localDay, upper: localDay, lowerKey: sortKey(localDay, instantMs), upperKey: sortKey(localDay, instantMs), instantMs };
}

export function projectRecordDate(record: RecordTime, timeZone: string): RecordDateProjection | undefined {
  if (!formatter(timeZone)) return undefined;
  const time = record.occurredAt;
  if (time.kind === "instant" || time.kind === "date" || time.kind === "month") {
    const value = endpoint(time.value, timeZone);
    if (value) return { lowerDay: value.lower, upperDay: value.upper, sortKey: value.lowerKey, basis: "occurred" };
  } else if (time.kind === "range") {
    const from = endpoint(time.from, timeZone); const to = endpoint(time.to, timeZone);
    const reversed = from && to && (from.lower > to.upper ||
      from.instantMs !== undefined && to.instantMs !== undefined && from.instantMs > to.instantMs);
    if (!reversed && (from || to)) return {
      ...(from ? { lowerDay: from.lower } : {}), ...(to ? { upperDay: to.upper } : {}),
      sortKey: from?.lowerKey ?? to!.upperKey, basis: "occurred"
    };
  }
  const recorded = endpoint(record.recordedAt, timeZone);
  return recorded ? { lowerDay: recorded.lower, upperDay: recorded.upper, sortKey: recorded.lowerKey, basis: "recorded" } : undefined;
}

export function recordDateMatches(projection: RecordDateProjection, filter: RecordDateFilter): boolean {
  return !(filter.fromDay !== undefined && projection.upperDay !== undefined && projection.upperDay < filter.fromDay ||
    filter.toDay !== undefined && projection.lowerDay !== undefined && projection.lowerDay > filter.toDay);
}
