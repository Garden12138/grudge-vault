import type { LegalCitation } from "@grudge-vault/domain";
import { calendarDateDay } from "@grudge-vault/shared";

export function CitationCard({ citation, issues, onOpen }: {
  citation: LegalCitation; issues: readonly string[]; onOpen(url: string): Promise<void>;
}) {
  const match = /^issue-([1-9]\d*)$/.exec(citation.claimId);
  const index = match ? Number(match[1]) : 0;
  const issue = Number.isSafeInteger(index) && index > 0 ? issues[index - 1]?.trim() : undefined;
  const retrieved = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(citation.retrievedAt) &&
    calendarDateDay(citation.retrievedAt.slice(0, 10)) !== undefined && Number.isFinite(Date.parse(citation.retrievedAt))
    ? new Date(citation.retrievedAt).toLocaleString("zh-CN", { timeZone: "UTC", hour12: false }) : undefined;
  const verified = citation.verificationStatus === "verified" && issue && citation.effectiveInfo?.trim() && retrieved;
  return <li className="citation-card">
    <div><strong>{citation.title}</strong><span>{citation.publisher} · {citation.jurisdiction} · {verified ? "已核验" : "待核验"}</span></div>
    <p className="legal-claim">对应问题：{issue || "尚未关联具体问题，请核对。"}</p>
    <p>{citation.effectiveInfo?.trim() || "生效、失效信息及事发时点的适用性尚未核验。"}</p>
    <blockquote>{citation.supportingExcerpt}</blockquote>
    <p className="muted">{retrieved ? <>检索时间：<time dateTime={citation.retrievedAt}>{retrieved} UTC</time></> : "检索时间尚待补充。"}</p>
    <p className="citation-url muted">原始链接：{citation.url}</p>
    <button className="text-button" onClick={() => void onOpen(citation.url)}>在浏览器打开来源</button>
  </li>;
}
