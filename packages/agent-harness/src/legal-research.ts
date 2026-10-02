import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveLlmProviderEndpoint, type LegalResearchInput, type LegalResearchPort, type LegalResearchResult } from "@grudge-vault/application";
import { legalContextCoverageNotes, PENDING_EFFECTIVE_INFO } from "./legal-research-context";

export interface BailianLegalCredentials {
  apiKey: string;
  region: "cn-beijing" | "ap-southeast-1" | "us-east-1" | "cn-hongkong";
  workspaceId?: string;
}

const OFFICIAL_PUBLISHERS: Readonly<Record<string, string>> = {
  "flk.npc.gov.cn": "全国人大常委会办公厅·国家法律法规数据库",
  "www.npc.gov.cn": "全国人民代表大会",
  "gongbao.court.gov.cn": "最高人民法院公报",
  "www.court.gov.cn": "最高人民法院",
  "www.spp.gov.cn": "最高人民检察院",
  "www.mohrss.gov.cn": "人力资源和社会保障部",
  "www.moj.gov.cn": "司法部",
  "www.samr.gov.cn": "国家市场监督管理总局",
  "www.gov.cn": "中国政府网"
};

const candidateSchema = z.object({
  sources: z.array(z.object({
    title: z.string().trim().min(2).max(300),
    url: z.url().max(2_000),
    excerpt: z.string().trim().min(10).max(500),
    issueIndex: z.number().int().min(0).max(4)
  })).max(5)
});

async function readBounded(response: globalThis.Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("response too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty response");
  const cancelOnAbort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancelOnAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (signal?.aborted) cancelOnAbort();
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function decodeText(response: globalThis.Response, bytes: Uint8Array): string {
  const declared = /(?:^|;)\s*charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
  const head = Buffer.from(bytes.subarray(0, 4_096)).toString("latin1");
  const meta = /<meta\b[^>]*?charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(head)?.[1];
  return new globalThis.TextDecoder(declared ?? meta ?? "utf-8", { fatal: true }).decode(bytes);
}

export function officialLegalUrl(value: string): { url: URL; publisher: string } | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return undefined;
  const publisher = OFFICIAL_PUBLISHERS[url.hostname.toLowerCase()];
  if (!publisher) return undefined;
  return { url, publisher };
}

function htmlText(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_match, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([a-f\d]+);/gi, (_match, value: string) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&nbsp;|&ensp;|&emsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ").trim();
}

function comparableText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").replace(/[“”‘’]/g, '"');
}

function decodeCandidates(modelText: string): z.infer<typeof candidateSchema> {
  const trimmed = modelText.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return candidateSchema.parse(JSON.parse(fenced?.[1] ?? trimmed));
}

/** Search discovers leads; only a bounded read of an exact official host can create a pending citation. */
export class BailianOfficialLegalResearchAdapter implements LegalResearchPort {
  constructor(
    private readonly credentials: () => BailianLegalCredentials | undefined,
    private readonly fetcher: typeof globalThis.fetch = globalThis.fetch
  ) {}

  async research(input: LegalResearchInput, signal?: AbortSignal): Promise<LegalResearchResult> {
    signal?.throwIfAborted();
    const contextNotes = legalContextCoverageNotes(input);
    if (input.jurisdiction.trim() !== "中国大陆") {
      return { issues: [], citations: [], coverageNotes: ["当前只配置了中国大陆官方来源；此法域依据待核验。", ...contextNotes] };
    }
    const credentials = this.credentials();
    if (!credentials) {
      return { issues: [], citations: [], coverageNotes: ["未启用可进行官方来源检索的百炼模型；依据待核验。", ...contextNotes] };
    }
    const issues = input.issues.slice(0, 5).map((issue) => issue.slice(0, 500));
    if (issues.length === 0) return { issues: [], citations: [], coverageNotes: [] };
    let leads: z.infer<typeof candidateSchema>;
    const searchController = new AbortController();
    const searchTimeout = setTimeout(() => searchController.abort(), 20_000);
    const searchSignal = signal ? AbortSignal.any([searchController.signal, signal]) : searchController.signal;
    try {
      const response = await this.fetcher(
        `${resolveLlmProviderEndpoint("bailian", credentials.region, credentials.workspaceId)}/chat/completions`, {
          method: "POST", redirect: "error", signal: searchSignal,
          headers: { "content-type": "application/json", authorization: `Bearer ${credentials.apiKey}` },
          body: JSON.stringify({
            model: "qwen3.8-omni-flash", reasoning_effort: "none", stream: false,
            enable_search: true, search_options: { search_strategy: "agent" },
            messages: [
              { role: "system", content: "只检索中国大陆法律、司法解释和主管机关文件的官方原文。返回 JSON：{\"sources\":[{\"title\":\"...\",\"url\":\"https://...\",\"excerpt\":\"原文连续摘录\",\"issueIndex\":0}]}。最多 5 项。不要编造网址或条文；找不到则返回空数组。不要给法律结论。" },
              { role: "user", content: JSON.stringify({ issues }) }
            ]
          })
        }
      );
      if (!response.ok) throw new Error("search failed");
      const raw = JSON.parse(decodeText(response, await readBounded(response, 1_000_000, searchSignal)));
      const modelText = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) })
        .parse(raw).choices[0]!.message.content;
      leads = decodeCandidates(modelText);
    } catch {
      signal?.throwIfAborted();
      return { issues: [], citations: [], coverageNotes: ["官方法律来源检索失败；依据待核验。", ...contextNotes] };
    } finally {
      clearTimeout(searchTimeout);
    }

    const citations: LegalResearchResult["citations"] = [];
    for (const candidate of leads.sources) {
      signal?.throwIfAborted();
      if (candidate.issueIndex >= issues.length) continue;
      const official = officialLegalUrl(candidate.url);
      if (!official || citations.some(({ url }) => url === official.url.href)) continue;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      try {
        const response = await this.fetcher(official.url.href, {
          method: "GET", redirect: "error", signal: requestSignal,
          headers: { accept: "text/html, text/plain;q=0.8" }
        });
        if (!response.ok || !/^(?:text\/html|text\/plain)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) continue;
        if (response.url && new URL(response.url).href !== official.url.href) continue;
        const page = htmlText(decodeText(response, await readBounded(response, 1_000_000, requestSignal)));
        if (!comparableText(page).includes(comparableText(candidate.title)) ||
          !comparableText(page).includes(comparableText(candidate.excerpt))) continue;
        citations.push({
          id: randomUUID(), title: candidate.title, publisher: official.publisher,
          url: official.url.href, retrievedAt: new Date().toISOString(), jurisdiction: "中国大陆",
          effectiveInfo: PENDING_EFFECTIVE_INFO,
          supportingExcerpt: candidate.excerpt, claimId: `issue-${candidate.issueIndex + 1}`,
          verificationStatus: "pending",
          verificationEvidence: {
            officialSource: true, excerptSupportsClaim: false, jurisdictionMatches: true,
            effectiveAtOccurredAt: false, factsSupportApplicability: false
          }
        });
      } catch {
        signal?.throwIfAborted();
        // A failed original-page fetch never becomes a citation.
      } finally {
        clearTimeout(timeout);
      }
    }
    signal?.throwIfAborted();
    return {
      issues: [], citations,
      coverageNotes: [...(citations.length
        ? ["已取得官方候选原文；是否支撑具体论点及事发时点的适用性仍待核验。"]
        : ["未取得可核对的官方原文；依据待核验。"]), ...contextNotes]
    };
  }
}
