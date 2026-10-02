import { describe, expect, it } from "vitest";
import type { LegalResearchInput, LegalResearchResult } from "@grudge-vault/application";
import type { TemporalValue } from "@grudge-vault/domain";
import { currentLegalOccurrence, hasCurrentLegalVerification, legalContextFingerprint, legalOccurrenceWindow } from "./legal-research-context";

const input: LegalResearchInput = { jurisdiction: "中国大陆", occurredAt: { kind: "date", value: "2026-09-12" },
  occurredAtSource: "source", occurredAtPrecision: "exact", sourceVersion: "synthetic-v2", confirmedFacts: [],
  reportedFacts: ["合成事实陈述，仍待核对"], issues: ["合成待核对问题"] };

function verifiedCandidate(context: LegalResearchInput = input): LegalResearchResult["citations"][number] {
  return { id: "synthetic-rule", title: "合成规则（不是实际法律）", publisher: "中国政府网", url: "https://www.gov.cn/synthetic",
    retrievedAt: "2026-09-29T00:00:00.000Z", jurisdiction: "中国大陆", effectiveInfo: "合成规则从 2026-09-01 至 2026-10-01（不含）",
    supportingExcerpt: "合成原文", claimId: "issue-1", verificationStatus: "verified", verificationEvidence: {
      officialSource: true, excerptSupportsClaim: true, jurisdictionMatches: true, effectiveAtOccurredAt: true,
      factsSupportApplicability: true, contextFingerprint: legalContextFingerprint(context),
      effectivePeriod: { from: "2026-09-01", toExclusive: "2026-10-01" }
    } };
}

describe("legal verification context and time bounds", () => {
  it("normalizes only the current report occurrence and keeps unknown or ambiguous material unresolved", () => {
    expect(currentLegalOccurrence({ source: "ai" })).toEqual({ occurredAt: { kind: "unknown" }, occurredAtSource: "ai", occurredAtPrecision: "unknown" });
    expect(currentLegalOccurrence({ source: "source", value: { value: "2026年9月12日", precision: "exact" } })).toEqual({
      occurredAt: { kind: "date", value: "2026-09-12" }, occurredAtSource: "source", occurredAtPrecision: "exact" });
    expect(currentLegalOccurrence({ source: "ai", value: { value: "2026-02-30", precision: "exact" } }).occurredAt)
      .toEqual({ kind: "relative", text: "2026-02-30" });
  });

  it.each([
    [{ kind: "date", value: "2026-09-01" }, "exact", true], [{ kind: "date", value: "2026-09-30" }, "exact", true],
    [{ kind: "date", value: "2026-10-01" }, "exact", false], [{ kind: "month", value: "2026-09" }, "exact", true],
    [{ kind: "month", value: "2026-08" }, "exact", false],
    [{ kind: "range", from: "2026-09-01", to: "2026-09-30" }, "range", true],
    [{ kind: "range", from: "2026-09", to: "2026-10" }, "range", false],
    [{ kind: "range", from: "2026-09-20", to: "2026-09-10" }, "range", false],
    [{ kind: "range", to: "2026-09-12" }, "range", false], [{ kind: "range", from: "invalid", to: "2026-09-12" }, "range", false],
    [{ kind: "unknown" }, "unknown", false], [{ kind: "relative", text: "上周" }, "approximate", false],
    [{ kind: "date", value: "2026-09-12" }, "approximate", false], [{ kind: "date", value: "2026-09-12" }, "unknown", false],
    [{ kind: "date", value: "2026-02-30" }, "exact", false], [{ kind: "month", value: "2026-13" }, "exact", false],
    [{ kind: "instant", value: "2026-09-30T15:59:59Z" }, "exact", true],
    [{ kind: "instant", value: "2026-09-30T16:00:00Z" }, "exact", false],
    [{ kind: "instant", value: "2026-09-12T24:00:00Z" }, "exact", false],
    [{ kind: "date", value: "2026-09-12" }, "range", false],
    [{ kind: "range", from: "2026-09-01", to: "2026-09-30" }, "exact", false]
  ] as const)("requires the whole known occurrence window to lie in the effective interval (%j, %s)", (occurredAt, occurredAtPrecision, expected) => {
    const context = { ...input, occurredAt: occurredAt as TemporalValue, occurredAtPrecision };
    expect(hasCurrentLegalVerification(verifiedCandidate(context), context)).toBe(expected);
  });

  it("rejects a period that covers only part of a month, malformed endpoints or an empty interval", () => {
    const context: LegalResearchInput = { ...input, occurredAt: { kind: "month", value: "2026-09" } };
    for (const period of [{ from: "2026-09-02", toExclusive: "2026-10-01" }, { from: "2026-09-01", toExclusive: "2026-09-30" },
      { from: "2026-02-30" }, { from: "2026-09-01", toExclusive: "invalid" }, { from: "2026-09-01", toExclusive: "2026-09-01" }]) {
      const citation = verifiedCandidate(context); citation.verificationEvidence!.effectivePeriod = period;
      expect(hasCurrentLegalVerification(citation, context)).toBe(false);
    }
    const citation = verifiedCandidate(context); citation.verificationEvidence!.effectivePeriod = { from: "2026-09-01" };
    expect(hasCurrentLegalVerification(citation, context)).toBe(true);
  });

  it("binds verification to source version, facts, issue ordering, jurisdiction and current temporal provenance", () => {
    for (const changed of [{ ...input, sourceVersion: "old-v1" }, { ...input, reportedFacts: ["另一份事实摘要"] },
      { ...input, confirmedFacts: ["新确认的事实"] }, { ...input, issues: ["另一争点"] }, { ...input, jurisdiction: "其他法域" },
      { ...input, occurredAt: { kind: "month", value: "2026-09" } as const }, { ...input, occurredAtSource: "user" as const },
      { ...input, occurredAtPrecision: "approximate" as const }]) {
      expect(legalContextFingerprint(changed)).not.toBe(legalContextFingerprint(input));
      expect(hasCurrentLegalVerification(verifiedCandidate(input), changed)).toBe(false);
    }
    const reordered = { ...input, occurredAt: { value: "2026-09-12", kind: "date" as const } };
    expect(legalContextFingerprint(reordered)).toBe(legalContextFingerprint(input));
    const citation = verifiedCandidate(); citation.claimId = "issue-2";
    expect(hasCurrentLegalVerification(citation, input)).toBe(false);
  });

  it("does not narrow mixed endpoint precision into a falsely applicable short interval", () => {
    for (const [occurredAt, effectivePeriod] of [
      [{ kind: "range", from: "2026-09", to: "2026-09-12" }, { from: "2026-09-01", toExclusive: "2026-09-13" }],
      [{ kind: "range", from: "2026-09-20", to: "2026-09" }, { from: "2026-09-20", toExclusive: "2026-10-01" }]
    ] as const) {
      const context: LegalResearchInput = { ...input, occurredAt, occurredAtPrecision: "range" };
      const candidate = verifiedCandidate(context); candidate.verificationEvidence!.effectivePeriod = effectivePeriod;
      expect(legalOccurrenceWindow(context)).toEqual(legalOccurrenceWindow({ ...input, occurredAt: { kind: "month", value: "2026-09" } }));
      expect(hasCurrentLegalVerification(candidate, context)).toBe(false);
    }
  });

  it("never substitutes four applicability flags for missing facts, context, interval or effective information", () => {
    for (const key of ["officialSource", "excerptSupportsClaim", "jurisdictionMatches", "effectiveAtOccurredAt", "factsSupportApplicability"] as const) {
      const citation = verifiedCandidate(); citation.verificationEvidence![key] = false;
      expect(hasCurrentLegalVerification(citation, input)).toBe(false);
    }
    for (const key of ["contextFingerprint", "effectivePeriod", "factsSupportApplicability"] as const) {
      const citation = verifiedCandidate(); delete citation.verificationEvidence![key];
      expect(hasCurrentLegalVerification(citation, input)).toBe(false);
    }
    const citation = verifiedCandidate(); citation.effectiveInfo = " ";
    expect(hasCurrentLegalVerification(citation, input)).toBe(false);
    expect(legalOccurrenceWindow({ ...input, occurredAt: { kind: "relative", text: "记录当日" } })).toBeUndefined();
  });
});
