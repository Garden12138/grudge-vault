import type { AnalysisReportContent } from "@grudge-vault/domain";

/** Search user-facing report content, not internal IDs, anchors or model metadata. */
export function reportContentSearchText(content: AnalysisReportContent, options: { includeAnchoredContent?: boolean } = {}): string {
  const time = content.time.value;
  const knownTime = time?.precision !== "unknown" && time?.value.trim() ? time.value : undefined;
  const location = content.location.value?.trim() ? content.location.value : undefined;
  return [
    content.summary, knownTime ?? content.time.prompt ?? "", location ?? content.location.prompt ?? "",
    ...content.people.filter(({ name }) => name.trim()).map(({ name, role }) => `${name}${role?.trim() ? ` ${role}` : ""}`),
    ...(options.includeAnchoredContent === false ? [] : [
      ...content.chronology.map(({ text }) => text), ...(content.mediaSegments ?? []).map(({ description }) => description)
    ]),
    ...content.unknowns, ...content.disputes, ...(content.speculations ?? []), ...content.suggestions,
    ...content.legalIssues,
    ...content.citations.flatMap((citation) => [citation.title, citation.publisher, citation.jurisdiction,
      citation.effectiveInfo ?? "", citation.supportingExcerpt, citation.url, citation.retrievedAt]),
    ...content.coverageNotes
  ].filter((text) => text.trim()).join("\n");
}
