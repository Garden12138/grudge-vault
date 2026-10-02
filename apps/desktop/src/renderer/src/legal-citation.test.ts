// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegalCitation } from "@grudge-vault/domain";
import { CitationCard } from "./legal-citation";

const citation: LegalCitation = { id: "synthetic-citation", title: "合成规则（非实际法律）", publisher: "中国政府网", jurisdiction: "中国大陆",
  url: "https://www.gov.cn/synthetic-rule", retrievedAt: "2026-09-29T00:00:00.000Z", effectiveInfo: "生效信息仍待核对",
  supportingExcerpt: "合成原文摘录", claimId: "issue-2", verificationStatus: "pending" };

describe("visible legal citation provenance", () => {
  let root: Root | undefined;
  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
  afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined;
    document.body.replaceChildren(); vi.unstubAllGlobals(); });
  const render = async (value: LegalCitation, issues: string[], onOpen = vi.fn(async () => {})) => {
    root ??= createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root?.render(createElement(CitationCard, { citation: value, issues, onOpen })));
    return onOpen;
  };
  it("shows the original URL, retrieved time, effective information and exactly the corresponding issue without opening it", async () => {
    const onOpen = await render(citation, ["问题甲", "问题乙"]);
    expect(document.querySelector(".legal-claim")?.textContent).toBe("对应问题：问题乙");
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe(citation.retrievedAt);
    expect(document.querySelector("time")?.textContent).toContain("UTC");
    expect(document.querySelector(".citation-url")?.textContent).toContain(citation.url);
    expect(document.body.textContent).toContain(citation.effectiveInfo);
    expect(document.body.textContent).toContain("待核验"); expect(onOpen).not.toHaveBeenCalled();
    await act(async () => document.querySelector("button")!.click());
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(citation.url);
  });
  it("does not manufacture an issue, effective date or verification for missing legacy metadata", async () => {
    const { effectiveInfo, ...legacy } = citation;
    expect(effectiveInfo).toBeTruthy();
    for (const claimId of ["unknown-claim", "issue-0", "issue-02", "issue-3", "issue-999999999999999999999999999"]) {
      await render({ ...legacy, claimId, retrievedAt: "invalid-time", verificationStatus: "verified" }, ["问题甲", "问题乙"]);
      expect(document.body.textContent).toContain("尚未关联具体问题");
      expect(document.body.textContent).toContain("生效、失效信息及事发时点的适用性尚未核验。");
      expect(document.body.textContent).toContain("检索时间尚待补充。");
      expect(document.body.textContent).not.toContain("已核验");
    }
  });
  it("renders untrusted title, excerpt and issue as text, and preserves a complete verified label", async () => {
    await render({ ...citation, title: "<img src=synthetic onerror=alert(1)>", supportingExcerpt: "<script>synthetic</script>",
      effectiveInfo: "合成规则 2026-09-01 生效（非实际法律）", verificationStatus: "verified" }, ["问题甲", "<b>问题乙</b>"]);
    expect(document.querySelector("img")).toBeNull(); expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector(".legal-claim")?.textContent).toBe("对应问题：<b>问题乙</b>");
    expect(document.body.textContent).toContain("已核验");
  });
  it("does not normalize an impossible legacy retrieval date or a missing timezone into an invented timestamp", async () => {
    for (const retrievedAt of ["2026-02-30T00:00:00Z", "2026-09-29T24:00:00Z", "2026-09-29T00:00:00", "1"]) {
      await render({ ...citation, retrievedAt, verificationStatus: "verified" }, ["问题甲", "问题乙"]);
      expect(document.querySelector("time")).toBeNull();
      expect(document.body.textContent).toContain("检索时间尚待补充。");
      expect(document.body.textContent).not.toContain("已核验");
    }
  });
});
