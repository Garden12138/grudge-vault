import type { AnalysisReportContent } from "@grudge-vault/domain";
import { describe, expect, it } from "vitest";
import { reportContentSearchText } from "./report-search-text";

const report = (): AnalysisReportContent => ({
  summary: "SUMMARYONLY", time: { source: "source", value: { value: "TIMEONLY", precision: "exact" } },
  location: { source: "ai", value: "LOCATIONONLY" }, people: [{ name: "PERSONONLY", role: "ROLEONLY", source: "ai" }],
  chronology: [{ id: "INTERNALSTEPID", text: "CHRONOLOGYONLY", anchor: { sourceVersion: "INTERNALVERSION", textRange: [0, 2] } }],
  mediaSegments: [{ id: "INTERNALSEGMENTID", description: "MEDIAONLY", anchor: { sourceVersion: "INTERNALVERSION", assetId: "INTERNALASSETID" } }],
  unknowns: ["UNKNOWNQUESTIONONLY"], disputes: ["DISPUTEONLY"], speculations: ["SPECULATIONONLY"],
  suggestions: ["SUGGESTIONONLY"], legalIssues: ["LEGALISSUEONLY"], coverageNotes: ["COVERAGEONLY"],
  citations: [{ id: "INTERNALCITATIONID", title: "CITATIONTITLEONLY", publisher: "PUBLISHERONLY", jurisdiction: "JURISDICTIONONLY",
    url: "https://www.gov.cn/synthetic", retrievedAt: "2026-09-29T00:00:00.000Z", effectiveInfo: "EFFECTIVEONLY",
    supportingExcerpt: "EXCERPTONLY", claimId: "INTERNALCLAIMID", verificationStatus: "pending" }]
});

describe("searchable report content projection", () => {
  it("includes all meaningful report fields and citation text, without internal identities", () => {
    const text = reportContentSearchText(report());
    for (const token of ["SUMMARYONLY", "TIMEONLY", "LOCATIONONLY", "PERSONONLY", "ROLEONLY", "CHRONOLOGYONLY", "MEDIAONLY",
      "UNKNOWNQUESTIONONLY", "DISPUTEONLY", "SPECULATIONONLY", "SUGGESTIONONLY", "LEGALISSUEONLY", "COVERAGEONLY",
      "CITATIONTITLEONLY", "PUBLISHERONLY", "JURISDICTIONONLY", "EFFECTIVEONLY", "EXCERPTONLY", "https://www.gov.cn/synthetic",
      "2026-09-29T00:00:00.000Z"]) expect(text).toContain(token);
    expect(text).not.toContain("INTERNAL");
    expect(text).not.toMatch(/verificationStatus|sourceVersion|textRange|precision|claimId/);
  });
  it("excludes anchored descriptions only when separate semantic fragments retain their anchors", () => {
    const text = reportContentSearchText(report(), { includeAnchoredContent: false });
    expect(text).toContain("TIMEONLY"); expect(text).toContain("EXCERPTONLY");
    expect(text).not.toContain("CHRONOLOGYONLY"); expect(text).not.toContain("MEDIAONLY");
  });
  it("indexes unknown-time prompts but not contradictory concrete values", () => {
    const content = report(); content.time = { source: "ai", value: { value: "CONTRADICTORYTIME", precision: "unknown" }, prompt: "时间待补充" };
    expect(reportContentSearchText(content)).toContain("时间待补充");
    expect(reportContentSearchText(content)).not.toContain("CONTRADICTORYTIME");
  });
  it("uses prompts for blank fields and does not index hidden prompts for known values", () => {
    const content = report(); content.time.prompt = "HIDDENTIMEPROMPT"; content.location.prompt = "HIDDENLOCATIONPROMPT";
    expect(reportContentSearchText(content)).not.toContain("HIDDEN");
    content.time.value = { value: " ", precision: "exact" }; content.location.value = " ";
    expect(reportContentSearchText(content)).toContain("HIDDENTIMEPROMPT");
    expect(reportContentSearchText(content)).toContain("HIDDENLOCATIONPROMPT");
  });
  it("does not invent roles or expose the role of an unnamed hidden person", () => {
    const content = report(); content.people = [{ name: " ", role: "HIDDENROLE", source: "ai" }, { name: "Known", source: "source" }];
    expect(reportContentSearchText(content)).toContain("Known");
    expect(reportContentSearchText(content)).not.toContain("HIDDENROLE");
  });
  it("does not mutate the report or its source anchors", () => {
    const content = report(); const before = globalThis.structuredClone(content);
    reportContentSearchText(content); reportContentSearchText(content, { includeAnchoredContent: false });
    expect(content).toEqual(before);
  });
});
