import type { AnalysisReportContent, Precision, ReportFieldSource, TemporalValue } from "@grudge-vault/domain";
import { calendarDateDay } from "./record-dates";

export interface RecordOccurrenceProjection {
  value: TemporalValue;
  source?: ReportFieldSource;
  precision?: Precision;
}

function absolute(value: string): Extract<TemporalValue, { kind: "date" | "month" | "instant" }> | undefined {
  const date = /^(\d{4})(?:-(\d{1,2})-(\d{1,2})|年(\d{1,2})月(\d{1,2})日)$/.exec(value);
  if (date) {
    const canonical = `${date[1]}-${(date[2] ?? date[4])!.padStart(2, "0")}-${(date[3] ?? date[5])!.padStart(2, "0")}`;
    if (calendarDateDay(canonical) !== undefined) return { kind: "date", value: canonical };
    return undefined;
  }
  const month = /^(\d{4})(?:-(\d{1,2})|年(\d{1,2})月)$/.exec(value);
  if (month) {
    const canonical = `${month[1]}-${(month[2] ?? month[3])!.padStart(2, "0")}`;
    if (calendarDateDay(`${canonical}-01`) !== undefined) return { kind: "month", value: canonical };
    return undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    calendarDateDay(value.slice(0, 10)) !== undefined && Number.isFinite(Date.parse(value))) return { kind: "instant", value };
  return undefined;
}

function reportTemporal(value: string, precision: Precision): TemporalValue {
  const input = value.trim();
  if (precision === "range") {
    const endpoints = input.split(/\s*(?:—|–|~|～|至|到)\s*|\s+[-/]\s+/);
    if (endpoints.length === 2) {
      const endpoint = (text: string) => text && text !== "?" && text !== "待补充" ? absolute(text)?.value ?? text : undefined;
      const from = endpoint(endpoints[0]!); const to = endpoint(endpoints[1]!);
      return { kind: "range", ...(from ? { from } : {}), ...(to ? { to } : {}) };
    }
  } else {
    // Do not extract narrative date fragments or guess missing years, zones or range widths.
    const plain = precision === "approximate" ? input.replace(/^(?:大约|约)\s*/, "") : input;
    const parsed = absolute(plain);
    if (parsed) return parsed;
  }
  return { kind: "relative", text: value };
}

/** Read-only, reversible occurrence selection. Report provenance is not verification. */
export function projectRecordOccurrence(stored: TemporalValue, reportTime?: AnalysisReportContent["time"], userSupplied = false): RecordOccurrenceProjection {
  if (userSupplied) return { value: stored, source: "user" };
  const time = reportTime?.value;
  if (time && time.precision !== "unknown" && time.value.trim()) return {
    value: reportTemporal(time.value, time.precision), source: reportTime!.source, precision: time.precision
  };
  // Legacy fields do not necessarily carry provenance; do not relabel them as original material.
  return { value: stored };
}
