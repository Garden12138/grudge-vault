import { createHash } from "node:crypto";
import type { LegalResearchInput, LegalResearchResult } from "@grudge-vault/application";
import type { AnalysisReportContent, TemporalValue } from "@grudge-vault/domain";
import { calendarDateDay, projectRecordDate, projectRecordOccurrence } from "@grudge-vault/shared";

export const PENDING_EFFECTIVE_INFO = "生效、失效信息及事发时点的适用性尚未核验。";

export function currentLegalOccurrence(time: AnalysisReportContent["time"]): Pick<LegalResearchInput,
  "occurredAt" | "occurredAtSource" | "occurredAtPrecision"> {
  // Unknown current material must not resurrect a previous report's occurrence date.
  const projection = projectRecordOccurrence({ kind: "unknown" }, time);
  return { occurredAt: projection.value, occurredAtSource: time.source,
    occurredAtPrecision: time.value?.precision ?? "unknown" };
}

function canonicalTemporal(time: TemporalValue): unknown {
  switch (time.kind) {
    case "date": case "month": case "instant": return { kind: time.kind, value: time.value };
    case "range": return { kind: time.kind, from: time.from ?? null, to: time.to ?? null };
    case "relative": return { kind: time.kind, text: time.text, anchorRef: time.anchorRef ?? null };
    case "unknown": return { kind: time.kind };
  }
}

/** Currency binding only; the research port must separately provide actual source/applicability evidence. */
export function legalContextFingerprint(input: LegalResearchInput): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, jurisdiction: input.jurisdiction.trim(),
    occurredAt: canonicalTemporal(input.occurredAt), occurredAtSource: input.occurredAtSource,
    occurredAtPrecision: input.occurredAtPrecision, sourceVersion: input.sourceVersion,
    confirmedFacts: input.confirmedFacts, reportedFacts: input.reportedFacts, issues: input.issues })).digest("hex");
}

function endpoint(value: string): Extract<TemporalValue, { kind: "date" | "month" | "instant" }> | undefined {
  if (calendarDateDay(value) !== undefined) return { kind: "date", value };
  if (/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) return { kind: "month", value };
  if (/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) &&
    calendarDateDay(value.slice(0, 10)) !== undefined && Number.isFinite(Date.parse(value))) return { kind: "instant", value };
  return undefined;
}

export function legalOccurrenceWindow(input: Pick<LegalResearchInput, "occurredAt" | "occurredAtPrecision">):
  { lowerDay: number; upperDay: number } | undefined {
  // Approximate dates do not specify uncertainty bounds. Never invent those bounds from recordedAt.
  if (input.occurredAtPrecision === "unknown" || input.occurredAtPrecision === "approximate") return undefined;
  const time = input.occurredAt;
  if (time.kind === "relative" || time.kind === "unknown") return undefined;
  if (time.kind === "range" ? input.occurredAtPrecision !== "range" : input.occurredAtPrecision !== "exact") return undefined;
  if (time.kind === "range") {
    if (!time.from || !time.to || !endpoint(time.from) || !endpoint(time.to)) return undefined;
  } else if (endpoint(time.value)?.kind !== time.kind) return undefined;
  const projection = projectRecordDate({ occurredAt: time, recordedAt: "" }, "Asia/Shanghai");
  if (projection?.basis !== "occurred" || projection.lowerDay === undefined || projection.upperDay === undefined) return undefined;
  if (time.kind === "range") {
    const windows = [endpoint(time.from!)!, endpoint(time.to!)!].map((occurredAt) =>
      projectRecordDate({ occurredAt, recordedAt: "" }, "Asia/Shanghai"));
    if (windows.some((window) => window?.basis !== "occurred" || window.lowerDay === undefined || window.upperDay === undefined)) return undefined;
    // A month endpoint is uncertain throughout that month. Do not silently narrow it using the other endpoint.
    return { lowerDay: Math.min(...windows.map((window) => window!.lowerDay!)),
      upperDay: Math.max(...windows.map((window) => window!.upperDay!)) };
  }
  return { lowerDay: projection.lowerDay, upperDay: projection.upperDay };
}

export function legalContextCoverageNotes(input: LegalResearchInput): string[] {
  return [
    ...(!legalOccurrenceWindow(input)
      ? ["本次事发时间未知、近似或缺少完整边界；请补充可核对的日期或范围，再核对规则生效与失效时间。"] : []),
    ...(input.reportedFacts.length > 0 && input.confirmedFacts.length === 0
      ? ["本次报告的事实摘要仍是待核对陈述，不是已确认法律事实；请核对约定、当事人关系及相关凭证。"] : [])
  ];
}

export function hasCurrentLegalVerification(citation: LegalResearchResult["citations"][number], input: LegalResearchInput): boolean {
  const evidence = citation.verificationEvidence;
  const window = legalOccurrenceWindow(input);
  const from = evidence?.effectivePeriod ? calendarDateDay(evidence.effectivePeriod.from) : undefined;
  const to = evidence?.effectivePeriod?.toExclusive === undefined ? undefined : calendarDateDay(evidence.effectivePeriod.toExclusive);
  const issue = /^issue-([1-9]\d*)$/.exec(citation.claimId);
  return Boolean(evidence?.officialSource && evidence.excerptSupportsClaim && evidence.jurisdictionMatches &&
    evidence.effectiveAtOccurredAt && evidence.factsSupportApplicability &&
    evidence.contextFingerprint === legalContextFingerprint(input) && citation.jurisdiction.trim() === input.jurisdiction.trim() &&
    citation.effectiveInfo?.trim() && issue && Number(issue[1]) <= input.issues.length &&
    window && from !== undefined && window.lowerDay >= from &&
    (evidence.effectivePeriod?.toExclusive === undefined || to !== undefined && to > from && window.upperDay < to));
}
