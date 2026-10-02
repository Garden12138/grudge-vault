import type { AnalysisReportContent, ReportFieldSource, TemporalValue } from "@grudge-vault/domain";

/** Unknown precision is an unresolved field, not a concrete time to persist or index. */
export function normalizeReportTime(field: {
  source: ReportFieldSource; value?: AnalysisReportContent["time"]["value"] | undefined; prompt?: string | undefined;
}): {
  time: AnalysisReportContent["time"]; droppedValue: boolean;
} {
  const known = field.value && field.value.precision !== "unknown" && field.value.value.trim() ? field.value : undefined;
  const droppedValue = field.value !== undefined && known === undefined;
  return { droppedValue, time: { source: field.source,
    ...(known ? { value: { value: known.value, precision: known.precision } } : {}),
    ...(field.prompt?.trim() ? { prompt: field.prompt } : droppedValue ? { prompt: "待补充：大约何时发生？" } : {})
  } };
}

/** Protected user temporal values are meaningful text, never internal JSON or invented dates. */
export function userReportTime(temporal: TemporalValue): AnalysisReportContent["time"] {
  const unresolved: AnalysisReportContent["time"] = { source: "user", prompt: "待补充：大约何时发生？" };
  if (temporal.kind === "instant" || temporal.kind === "date" || temporal.kind === "month") {
    return temporal.value.trim() ? { source: "user", value: { value: temporal.value, precision: "exact" } } : unresolved;
  }
  if (temporal.kind === "relative") return temporal.text.trim()
    ? { source: "user", value: { value: temporal.text, precision: "approximate" } } : unresolved;
  if (temporal.kind === "range") {
    const from = temporal.from?.trim() ? temporal.from : undefined;
    const to = temporal.to?.trim() ? temporal.to : undefined;
    return from || to ? { source: "user", value: { value: `${from ?? "?"} — ${to ?? "?"}`, precision: "range" } } : unresolved;
  }
  return unresolved;
}
