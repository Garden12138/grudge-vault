import type { RecordSearchPage } from "@grudge-vault/domain";

type SearchCapabilities = Pick<RecordSearchPage["capabilities"], "semantic" | "indexCoverage">;

export function searchIndexIncomplete(capabilities: Pick<SearchCapabilities, "indexCoverage">): boolean {
  const coverage = capabilities.indexCoverage;
  return Boolean(coverage && (coverage.currentFragments < coverage.expectedFragments || coverage.outdatedFragments > 0));
}

export function searchCoverageMessage(capabilities: SearchCapabilities): string | undefined {
  if (!searchIndexIncomplete(capabilities)) return undefined;
  const coverage = capabilities.indexCoverage!;
  const scope = capabilities.semantic === "ready" ? "本次包含本地关键词及仍有效的语义匹配" : "本次仅使用本地关键词";
  return `语义索引已覆盖当前 ${coverage.currentFragments}／${coverage.expectedFragments} 个片段，${coverage.outdatedFragments} 个过期片段已排除。${scope}；未找到匹配不代表没有相关记录，请更新索引后重试。`;
}
