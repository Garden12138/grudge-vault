import { describe, expect, it } from "vitest";
import { searchCoverageMessage, searchIndexIncomplete } from "./search-coverage";

describe("current search index coverage", () => {
  it("does not invent a limitation for absent metadata or a fully covered empty index", () => {
    expect(searchIndexIncomplete({})).toBe(false);
    expect(searchCoverageMessage({ semantic: "ready" })).toBeUndefined();
    expect(searchIndexIncomplete({ indexCoverage: { currentFragments: 0, expectedFragments: 0, outdatedFragments: 0 } })).toBe(false);
    expect(searchCoverageMessage({ semantic: "ready", indexCoverage: { currentFragments: 3, expectedFragments: 3, outdatedFragments: 0 } })).toBeUndefined();
  });
  it("distinguishes still-current semantic matches from complete search coverage", () => {
    const value = { semantic: "ready" as const, indexCoverage: { currentFragments: 3, expectedFragments: 4, outdatedFragments: 1 } };
    expect(searchIndexIncomplete(value)).toBe(true);
    expect(searchCoverageMessage(value)).toContain("3／4 个片段，1 个过期片段已排除");
    expect(searchCoverageMessage(value)).toContain("仍有效的语义匹配");
    expect(searchCoverageMessage(value)).toContain("未找到匹配不代表没有相关记录");
  });
  it("reports obsolete extra fragments even when every current fragment is covered", () => {
    expect(searchIndexIncomplete({ indexCoverage: { currentFragments: 3, expectedFragments: 3, outdatedFragments: 1 } })).toBe(true);
  });
  it("does not claim semantic matches when only local keywords can be searched", () => {
    const text = searchCoverageMessage({ semantic: "building", indexCoverage: { currentFragments: 0, expectedFragments: 4, outdatedFragments: 4 } });
    expect(text).toContain("仅使用本地关键词"); expect(text).not.toContain("仍有效的语义匹配");
  });
});
