import { describe, expect, it, vi } from "vitest";
import type { LegalResearchInput } from "@grudge-vault/application";
import { BailianOfficialLegalResearchAdapter } from "./legal-research";

const input: LegalResearchInput = {
  jurisdiction: "中国大陆", occurredAt: { kind: "date", value: "2025-03-01" },
  occurredAtSource: "source", occurredAtPrecision: "exact", reportedFacts: [],
  confirmedFacts: ["私密事实不要进入搜索"],
  issues: ["需核对劳动报酬的适用规定"], sourceVersion: "source-v1"
};

describe("official legal source discovery", () => {
  it.each(["search", "official-page"] as const)("propagates cancellation during %s fetch", async (stage) => {
    const controller = new AbortController();
    const cancelled = new globalThis.DOMException("report cancelled", "AbortError");
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    let requestSignal: AbortSignal | undefined;
    let calls = 0;
    const official = "https://flk.npc.gov.cn/cancel-test.html";
    const fetcher = (async (_url: string | URL | globalThis.Request, init?: globalThis.RequestInit) => {
      calls += 1;
      if (stage === "official-page" && calls === 1) return globalThis.Response.json({
        choices: [{ message: { content: JSON.stringify({ sources: [{
          title: "合成法规", url: official, excerpt: "合成的连续法规文字用于取消测试", issueIndex: 0
        }] }) } }]
      });
      return new Promise<globalThis.Response>((_resolve, reject) => {
        requestSignal = init?.signal ?? undefined;
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
        fetchStarted();
      });
    }) as typeof globalThis.fetch;
    const adapter = new BailianOfficialLegalResearchAdapter(() => ({
      apiKey: "synthetic-key", region: "cn-beijing"
    }), fetcher);
    const pending = adapter.research(input, controller.signal);
    await started;
    controller.abort(cancelled);
    await expect(pending).rejects.toBe(cancelled);
    expect(requestSignal?.aborted).toBe(true);
    expect(calls).toBe(stage === "search" ? 1 : 2);
  });

  it("reads exact official pages and keeps applicability pending", async () => {
    const requests: Array<{ url: string; init?: globalThis.RequestInit }> = [];
    const official = "https://flk.npc.gov.cn/detail2.html?id=1";
    const unmatched = "https://www.mohrss.gov.cn/example.html";
    const fetcher = vi.fn(async (url: string | URL | globalThis.Request, init?: globalThis.RequestInit) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      if (requests.length === 1) return globalThis.Response.json({ choices: [{ message: { content: JSON.stringify({ sources: [
        { title: "测试法规甲", url: official, excerpt: "用人单位应按约定支付劳动报酬", issueIndex: 0 },
        { title: "伪造站点", url: "https://evil.flk.npc.gov.cn/secret", excerpt: "不应被请求的伪造来源文字", issueIndex: 0 },
        { title: "测试法规乙", url: unmatched, excerpt: "模型编造的不存在摘录文字", issueIndex: 0 },
        { title: "私网地址", url: "https://127.0.0.1/secret", excerpt: "不应被请求的私网来源文字", issueIndex: 0 }
      ] }) } }] });
      if (String(url) === official) return new globalThis.Response(
        "<html><title>测试法规甲</title><body>第一条 用人单位应按约定支付劳动报酬。</body></html>",
        { status: 200, headers: { "content-type": "text/html" } }
      );
      if (String(url) === unmatched) return new globalThis.Response(
        "<html><title>测试法规乙</title><body>本页没有候选摘录。</body></html>",
        { status: 200, headers: { "content-type": "text/html" } }
      );
      throw new Error("unexpected URL");
    }) as typeof globalThis.fetch;
    const adapter = new BailianOfficialLegalResearchAdapter(() => ({
      apiKey: "test-key", region: "cn-beijing", workspaceId: "ws-123"
    }), fetcher);
    const result = await adapter.research(input);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
      official, unmatched
    ]);
    expect(requests[0]?.init?.redirect).toBe("error");
    expect(requests[1]?.init?.redirect).toBe("error");
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      enable_search: true, search_options: { search_strategy: "agent" }
    });
    expect(String(requests[0]?.init?.body)).not.toContain("私密事实不要进入搜索");
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({
      url: official, publisher: "全国人大常委会办公厅·国家法律法规数据库",
      supportingExcerpt: "用人单位应按约定支付劳动报酬", claimId: "issue-1",
      verificationStatus: "pending", verificationEvidence: {
        officialSource: true, excerptSupportsClaim: false, jurisdictionMatches: true,
        effectiveAtOccurredAt: false
      }
    });
    expect(result.citations[0]?.effectiveInfo).toBe("生效、失效信息及事发时点的适用性尚未核验。");
  });

  it("does not call the network for unsupported jurisdictions or missing credentials", async () => {
    const fetcher = vi.fn() as unknown as typeof globalThis.fetch;
    const withoutKey = new BailianOfficialLegalResearchAdapter(() => undefined, fetcher);
    expect((await withoutKey.research(input)).citations).toEqual([]);
    const withKey = new BailianOfficialLegalResearchAdapter(() => ({ apiKey: "test", region: "cn-beijing" }), fetcher);
    expect((await withKey.research({ ...input, jurisdiction: "美国" })).citations).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps unresolved current time and reported facts explicit without broadening public discovery", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>(async () =>
      globalThis.Response.json({ choices: [{ message: { content: '{"sources":[]}' } }] }));
    const adapter = new BailianOfficialLegalResearchAdapter(() => ({ apiKey: "synthetic-key", region: "cn-beijing" }), fetcher);
    const result = await adapter.research({ ...input, occurredAt: { kind: "relative", text: "合成私密时间描述" },
      occurredAtSource: "user", occurredAtPrecision: "approximate", reportedFacts: ["私密摘要不应进入公开发现"], confirmedFacts: [] });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(JSON.parse(body.messages[1].content)).toEqual({ issues: input.issues });
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain("私密摘要");
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain("source-v1");
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain("合成私密时间描述");
    expect(result.coverageNotes.some((note) => note.includes("请补充可核对的日期或范围"))).toBe(true);
    expect(result.coverageNotes.some((note) => note.includes("不是已确认法律事实"))).toBe(true);
  });

  it.each(["header", "meta"] as const)("matches a bounded GB2312 official page declared by %s", async (declaration) => {
    const official = "https://www.mohrss.gov.cn/example-gb2312.html";
    const titleBytes = Buffer.from("D6D0CEC4", "hex");
    const page = Buffer.concat([
      Buffer.from(`<html><head>${declaration === "meta" ? '<meta http-equiv="Content-Type" content="text/html; charset=gb2312">' : ""}</head><body><h1>`),
      titleBytes, Buffer.from("</h1><p>"), Buffer.from("D6D0CEC4".repeat(5), "hex"), Buffer.from("</p></body></html>")
    ]);
    const fetcher = vi.fn(async (url: string | URL | globalThis.Request) => String(url) === official
      ? new globalThis.Response(page, { status: 200, headers: {
        "content-type": declaration === "header" ? "text/html; charset=gb2312" : "text/html"
      } })
      : globalThis.Response.json({ choices: [{ message: { content: JSON.stringify({ sources: [{
        title: "中文", url: official, excerpt: "中文中文中文中文中文", issueIndex: 0
      }] }) } }] })) as typeof globalThis.fetch;
    const adapter = new BailianOfficialLegalResearchAdapter(() => ({ apiKey: "test", region: "cn-beijing" }), fetcher);
    const result = await adapter.research(input);
    expect(result.citations).toMatchObject([{ url: official, verificationStatus: "pending", supportingExcerpt: "中文中文中文中文中文" }]);
  });
});
