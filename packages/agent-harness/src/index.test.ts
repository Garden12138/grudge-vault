import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GrudgeVaultApplication,
  type LegalResearchInput,
  type LegalResearchPort,
  type NativeMediaSegmentPort,
  type NativeMediaSegmentInput,
  type NativeImageConversionPort,
  type ReportAnalysisInput,
  type ObjectVaultPort,
  type WorkspaceManagerPort,
  type WorkspaceSession
} from "@grudge-vault/application";
import {
  runMigrations,
  SqliteAgentRepository,
  SqliteAssetRepository,
  SqliteDayOneRepository,
  SqliteJobRepository,
  SqliteMemoryRepository,
  SqlitePhaseFiveRepository
} from "@grudge-vault/persistence-sqlite";
import { AppError } from "@grudge-vault/shared";
import { legalContextFingerprint } from "./legal-research-context";
import type { ModelUsageEvent } from "@grudge-vault/domain";
import {
  AGENT_TOOL_SCHEMA_VERSION,
  AgentHarness,
  BailianMultimodalEmbeddingAdapter,
  BailianNativeMediaQueryAdapter,
  MAX_AGENT_MODEL_ROUNDS,
  OpenAiCompatibleChatAdapter,
  createDefaultAgentToolRegistry,
  exportAgentToolSchemasV3,
  redactExternalText,
  resolveBailianEmbeddingEndpoint,
  type RegisteredAgentTool,
  resolveBailianCatalogEndpoint,
  routeAgentIntent,
  type AgentModelAdapterPort
} from "./index";

const ALL_AGENT_CATEGORIES = [
  "conversation_text", "event_fields", "source_excerpt", "asset_metadata", "ocr_excerpt", "transcript_excerpt"
] as const;

function configureTestLlm(application: GrudgeVaultApplication, grantConsent = true): void {
  application.saveLlmConnection({
    provider: "nvidia", model: "fake", apiKey: "test-api-key"
  }, "2026-08-30T00:00:00.000Z");
  if (grantConsent) application.grantAgentDataCategories([...ALL_AGENT_CATEGORIES]);
}

function createContext(nativeImageConversion?: NativeImageConversionPort) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  const vault: ObjectVaultPort = {
    async put() { return { sha256: "a".repeat(64), byteSize: 4, vaultFormat: 1, deduplicated: false }; },
    async putStream() { return { sha256: "a".repeat(64), byteSize: 4, vaultFormat: 1, deduplicated: false }; },
    async open() { return Readable.from(Buffer.from("test")); },
    async verify() { return true; },
    async exists() { return true; },
    async remove() {},
    async cleanupTempFiles() {}
  };
  const memory = new SqliteMemoryRepository(database);
  const session: WorkspaceSession = {
    workspace: {
      id: "00000000-0000-4000-8000-000000000001", name: "Test", rootPath: "/tmp/test",
      formatVersion: 1, createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z"
    },
    key: Buffer.alloc(32, 7), assets: new SqliteAssetRepository(database), jobs: new SqliteJobRepository(database),
    memory, agents: new SqliteAgentRepository(database), phase5: new SqlitePhaseFiveRepository(database, memory),
    dayOne: new SqliteDayOneRepository(database, memory), vault,
    async backupDatabase() {}, async close() { database.close(); }
  };
  const manager: WorkspaceManagerPort = {
    current: () => session,
    async create() { return session; }, async open() { return session; },
    async createBackup() { throw new Error("unused"); }, async restoreBackup() { return session; },
    async close() {}
  };
  return { database, session, manager, application: new GrudgeVaultApplication(manager,
    undefined, undefined, undefined, {}, undefined, undefined, undefined, nativeImageConversion) };
}

function jsonResponse(value: unknown, init: globalThis.ResponseInit = {}): globalThis.Response {
  return new globalThis.Response(JSON.stringify(value), {
    status: 200, headers: { "content-type": "application/json" }, ...init
  });
}

function eventStreamResponse(events: unknown[]): globalThis.Response {
  return new globalThis.Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }
  });
}

const AUXILIARY_ASSET_ID = "00000000-0000-4000-8000-000000000041";

function syntheticAuxiliaryReport(source: Pick<NativeMediaSegmentInput, "mimeType" | "sha256" | "byteSize">): ReportAnalysisInput {
  return {
    record: { id: "auxiliary-record", origin: "manual", categories: ["rights"], title: "合成辅助媒体", summary: "", revision: 1,
      occurredAt: { kind: "unknown" }, recordedAt: "2026-09-28T00:00:00Z", reportState: "queued", sourceUpdated: false,
      sourceReviewRequired: false, attachmentCount: 1, createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z" },
    source: { id: "auxiliary-source", recordId: "auxiliary-record", origin: "manual", sourceVersion: "auxiliary-v1",
      contentHash: "b".repeat(64), text: "合成材料", recordedAt: "2026-09-28T00:00:00Z", createdAt: "2026-09-28T00:00:00Z" },
    attachments: [{ id: AUXILIARY_ASSET_ID, sha256: source.sha256, byteSize: source.byteSize, mimeType: source.mimeType,
      originalFileName: "synthetic-media", vaultFormat: 2, integrityStatus: "verified", availabilityStatus: "available", createdAt: "2026-09-28T00:00:00Z" }],
    overrides: []
  };
}

function auxiliaryRouteFixture(kind: "audio" | "video", options: {
  partial?: boolean; afterClip?: () => void; afterAggregate?: () => void;
} = {}) {
  const calls: Array<{ tool: string; model: string; baseUrl: string }> = [];
  const closed = vi.fn();
  const source: NativeMediaSegmentInput = { kind, mimeType: kind === "audio" ? "audio/wav" : "video/mp4",
    byteSize: 4, sha256: "a".repeat(64), async open() { throw new Error("Injected synthetic native port only"); } };
  const nativeMediaSegments: NativeMediaSegmentPort = { async *segments(input) {
    expect(input).toMatchObject({ kind, mimeType: source.mimeType, byteSize: source.byteSize, sha256: source.sha256 });
    try {
      for (let index = 0; index < 2; index++) yield { index, startMs: index * 10_000, endMs: (index + 1) * 10_000,
        sourceDurationMs: 20_000, mimeType: kind === "audio" ? "audio/wav" : "video/mp4", bytes: Buffer.from("clip") };
    } finally { closed(); }
  } };
  const modelAdapter: AgentModelAdapterPort = { identity: "test.auxiliary-route", version: 1, async run(input) {
    const tool = input.tools[0]!.name;
    calls.push({ tool, model: input.model, baseUrl: input.baseUrl });
    if (tool === "submit_media_segment_observations") {
      expect(input.model).toBe("qwen3.8-omni-flash");
      expect(input.apiKey).toBe("synthetic-auxiliary-key");
      expect(input.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
      const clipId = /segment-\d+/.exec(input.user)![0];
      await input.executeTool(tool, { examinedSegmentId: clipId, coverage: options.partial ? "partial" : "complete",
        summary: clipId === "segment-0" ? "普通开头" : "后段合成争议",
        observations: [{ description: "合成观察", intervalMs: [100, 200] }], notes: [] }, "clip");
      options.afterClip?.();
    } else {
      expect(input.model).toBe("MiniMax-M3");
      expect(input.apiKey).toBe("synthetic-main-key");
      const content = input.userContent as Array<{ type: string }> | undefined;
      expect(content?.every(({ type }) => type === "text") ?? true).toBe(true);
      if (content) expect(JSON.stringify(content)).toContain("后段合成争议");
      if (tool === "submit_screening") {
        await input.executeTool(tool, { decision: "include", categories: ["rights"], reason: "合成相关",
          anchors: [{ sourceVersion: "auxiliary-v1", temporaryMediaRef: AUXILIARY_ASSET_ID, intervalMs: [10_100, 10_200] }],
          coverage: "complete", policyVersion: "screening-v1" }, "screen");
      } else {
        await input.executeTool(tool, { summary: "合成事件报告", time: { source: "ai" }, location: { source: "ai" },
          people: [], chronology: [], mediaSegments: [], examinedAttachmentIds: content ? [AUXILIARY_ASSET_ID] : [],
          unknowns: [], disputes: [], suggestions: [], legalIssues: [], coverageNotes: [], state: "complete" }, "report");
      }
      options.afterAggregate?.();
    }
    return { model: input.model };
  } };
  const screening = { text: "", origin: "manual" as const, sourceVersion: "auxiliary-v1", media: [{
    id: AUXILIARY_ASSET_ID, kind, mimeType: source.mimeType, byteSize: source.byteSize, screenedSha256: source.sha256,
    fileName: "synthetic-media", path: "/synthetic/only-injected-port"
  }] };
  return { source, modelAdapter, nativeMediaSegments, calls, closed, screening };
}

function configureSyntheticAuxiliary(application: GrudgeVaultApplication, auxiliary = true): void {
  if (auxiliary) application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash",
    apiKey: "synthetic-auxiliary-key", region: "cn-beijing" }, "2026-09-28T00:00:00Z");
  application.saveLlmConnection({ provider: "minimax", model: "MiniMax-M3", apiKey: "synthetic-main-key" }, "2026-09-28T00:00:00Z");
}

describe("Phase 4 Agent Harness", () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const database of databases.splice(0)) if (database.open) database.close();
  });

  it("uses the official Bailian multimodal embedding endpoint for local text and image data", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
    const fetcher = vi.fn(async (input: string | URL | globalThis.Request, init?: globalThis.RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({
        url: String(input), body,
        authorization: new globalThis.Headers(init?.headers).get("authorization")
      });
      return jsonResponse({ output: { embeddings: [
        { index: 1, type: "image", embedding: Array.from({ length: 1024 }, () => 0.25) },
        { index: 0, type: "text", embedding: Array.from({ length: 1024 }, () => 0.5) }
      ] } });
    });
    const adapter = new BailianMultimodalEmbeddingAdapter(() => ({
      apiKey: "secret-bailian-key", region: "cn-beijing", workspaceId: "ws-123"
    }), fetcher as typeof globalThis.fetch);
    const vectors = await adapter.embed([
      { modality: "text", text: "蓝色收据", contentHash: "text-hash" },
      { modality: "image", bytes: Uint8Array.from([0x89, 0x50]), mimeType: "image/png", contentHash: "image-hash" }
    ]);
    expect(resolveBailianEmbeddingEndpoint("cn-beijing", "ws-123")).toBe(
      "https://ws-123.cn-beijing.maas.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding"
    );
    expect(requests[0]).toMatchObject({
      url: "https://ws-123.cn-beijing.maas.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
      authorization: "Bearer secret-bailian-key",
      body: { model: "qwen3-vl-embedding", parameters: { dimension: 1024 } }
    });
    expect(JSON.stringify(requests[0]?.body)).toContain("data:image/png;base64,");
    expect(vectors[0]?.[0]).toBe(0.5);
    expect(vectors[1]?.[0]).toBe(0.25);
    await expect(adapter.embed([{
      modality: "audio", bytes: Uint8Array.from([1]), mimeType: "audio/mpeg", contentHash: "audio-hash"
    }])).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("describes an audio query only in memory through the configured Omni model", async () => {
    const controller = new AbortController();
    const adapter = new BailianNativeMediaQueryAdapter(() => ({
      apiKey: "test-key", region: "cn-beijing"
    }), {
      identity: "test.omni-query", version: 1,
      async run(input) {
        expect(input.model).toBe("qwen3.8-omni-flash");
        expect(input.signal).toBe(controller.signal);
        expect(input.userContent).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "input_audio", input_audio: expect.objectContaining({
            data: expect.stringMatching(/^data:;base64,/), format: "mp3"
          }) })
        ]));
        await input.executeTool("submit_media_query_descriptions", {
          descriptions: [{ id: "audio-query", text: "会议上讨论了加班" }]
        }, "query-call");
        return { text: "submitted", model: input.model };
      }
    });
    await expect(adapter.describe([{ id: "audio-query", modality: "audio", mimeType: "audio/mpeg",
      bytes: Buffer.from("ID3synthetic") }], controller.signal)).resolves.toEqual([
      { id: "audio-query", text: "会议上讨论了加班" }
    ]);
  });

  it("exports versioned schemas and rejects unknown, unauthorized, and invalid tool calls", () => {
    const registry = createDefaultAgentToolRegistry();
    expect(AGENT_TOOL_SCHEMA_VERSION).toBe(3);
    expect(registry.definitions("record").every(({ version, jsonSchema }) =>
      version === 3 && jsonSchema.type === "object")).toBe(true);
    expect(exportAgentToolSchemasV3("strategy").every(({ version, schema }) =>
      version === 3 && schema.type === "object")).toBe(true);
    expect(registry.definitions("evidence").map(({ name }) => name)).toEqual(expect.arrayContaining([
      "get_evidence", "get_case", "build_case_timeline", "list_case_gaps", "prepare_case_bundle"
    ]));
    expect(() => registry.parse("retrieve", "propose_event", {})).toThrowError(AppError);
    expect(() => registry.parse("retrieve", "does_not_exist", {})).toThrowError(AppError);
    expect(() => registry.parse("retrieve", "get_event", { eventRef: "" })).toThrowError(AppError);
  });

  it("routes the fixed evaluation intents deterministically", () => {
    expect(routeAgentIntent("请记录今天发生的事")).toBe("record");
    expect(routeAgentIntent("回顾这一年发生了什么")).toBe("review");
    expect(routeAgentIntent("这个情况我该怎么办，有哪些风险？")).toBe("strategy");
    expect(routeAgentIntent("逐项补全这些澄清问题")).toBe("clarify");
    expect(routeAgentIntent("检查这个 Case 的证据和材料缺口")).toBe("evidence");
    expect(routeAgentIntent("Alex 的历史记录")).toBe("retrieve");
  });

  it("redacts names, contact details, account-like values, local paths, and file names", () => {
    const redacted = redactExternalText(
      "Alex alex@example.com +86 138 1234 5678 /Users/me/private/report.pdf account 1234567890 note.docx",
      ["Alex"]
    );
    expect(redacted).toContain("Person-1");
    expect(redacted).toContain("[email]");
    expect(redacted).toContain("[phone-or-account]");
    expect(redacted).toContain("[local-path]");
    expect(redacted).toContain("[file-name]");
    expect(redacted).not.toContain("1234567890");
  });

  it("keeps a JSON fallback when a provider ignores the streaming request", async () => {
    const requests: Array<{ url: string; init?: globalThis.RequestInit }> = [];
    const responses = [
      jsonResponse({ model: "local-test", choices: [{ message: {
        role: "assistant", content: null,
        tool_calls: [{ id: "call-1", type: "function", function: { name: "search_events", arguments: "{\"query\":\"report\"}" } }]
      } }] }),
      jsonResponse({ model: "local-test", choices: [{ message: { role: "assistant", content: "Grounded result" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 } })
    ];
    const fetcher = (async (input: string | URL | globalThis.Request, init?: globalThis.RequestInit) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      return responses.shift()!;
    }) as typeof globalThis.fetch;
    const executeTool = vi.fn(async () => [{ ref: "event_1" }]);
    const adapter = new OpenAiCompatibleChatAdapter(fetcher);
    const result = await adapter.run({
      baseUrl: "https://model.example/v1", model: "local-test", system: "grounded", user: "review",
      tools: createDefaultAgentToolRegistry().definitions("retrieve"), executeTool
    });
    expect(result).toMatchObject({ text: "Grounded result", promptTokens: 12, completionTokens: 3 });
    expect(executeTool).toHaveBeenCalledWith("search_events", { query: "report" }, "call-1");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("https://model.example/v1/chat/completions");
    expect(requests[0]?.init?.redirect).toBe("error");
    expect(result.streaming).toBeUndefined();
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ stream: true, tool_choice: "auto" });
  });

  it("reports each inference request and sums known usage across tool rounds instead of replacing it", async () => {
    const bodies: Array<Record<string, unknown>> = []; const events: ModelUsageEvent[] = [];
    const responses = [
      eventStreamResponse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "usage-tool", type: "function",
        function: { name: "search_events", arguments: "{\"query\":\"synthetic\"}" } }] } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 } }]),
      jsonResponse({ choices: [{ message: { role: "assistant", content: "synthetic result" } }], usage: { prompt_tokens: 7, completion_tokens: 2 } })
    ];
    const result = await new OpenAiCompatibleChatAdapter((async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body))); return responses.shift()!;
    }) as typeof globalThis.fetch).run({ baseUrl: "https://model.example/v1", model: "synthetic", system: "synthetic", user: "synthetic",
      tools: createDefaultAgentToolRegistry().definitions("retrieve"), executeTool: async () => ({}), includeUsage: true,
      onUsage(event) { events.push({ ...event }); if (event.kind === "response-received") event.promptTokens = 999; }
    });
    expect(result).toMatchObject({ promptTokens: 19, completionTokens: 5 });
    expect(events).toEqual([{ kind: "request-started" }, { kind: "response-received", promptTokens: 12, completionTokens: 3 },
      { kind: "request-started" }, { kind: "response-received", promptTokens: 7, completionTokens: 2 }]);
    expect(bodies.every((body) => JSON.stringify(body.stream_options) === JSON.stringify({ include_usage: true }))).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/synthetic|model|system|user|key|usage-tool/);
  });

  it("does not invent usage or request an unverified streaming option when it is absent", async () => {
    const events: ModelUsageEvent[] = []; let body: Record<string, unknown> = {};
    const result = await new OpenAiCompatibleChatAdapter((async (_url, init) => {
      body = JSON.parse(String(init?.body)); return jsonResponse({ choices: [{ message: { role: "assistant", content: "synthetic" } }] });
    }) as typeof globalThis.fetch).run({ baseUrl: "https://model.example/v1", model: "synthetic", system: "synthetic", user: "synthetic",
      tools: [], executeTool: async () => ({}), onUsage: (event) => events.push(event) });
    expect(events).toEqual([{ kind: "request-started" }, { kind: "response-received" }]);
    expect(result.promptTokens).toBeUndefined(); expect(result.completionTokens).toBeUndefined(); expect(body.stream_options).toBeUndefined();
  });

  it("keeps usage unknown after an HTTP error and ignores throwing observers on success", async () => {
    const events: ModelUsageEvent[] = [];
    const request = { baseUrl: "https://model.example/v1", model: "synthetic", system: "synthetic", user: "synthetic",
      tools: [], executeTool: async () => ({}), onUsage: (event: ModelUsageEvent) => { events.push(event); throw new Error("synthetic observer failure"); } };
    await expect(new OpenAiCompatibleChatAdapter((async () => jsonResponse({}, { status: 401 })) as typeof globalThis.fetch).run(request))
      .rejects.toMatchObject({ code: "LLM_AUTHENTICATION_FAILED" });
    expect(events).toEqual([{ kind: "request-started" }]);
    await expect(new OpenAiCompatibleChatAdapter((async () => jsonResponse({ choices: [{ message: { role: "assistant", content: "synthetic" } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 } })) as typeof globalThis.fetch).run(request)).resolves.toMatchObject({ promptTokens: 0, completionTokens: 0 });
    expect(events.at(-1)).toEqual({ kind: "response-received", promptTokens: 0, completionTokens: 0 });
  });

  it("aggregates streamed text, usage, and fragmented tool calls before validation", async () => {
    const requests: Array<{ init?: globalThis.RequestInit }> = [];
    const responses = [
      eventStreamResponse([
        { model: "stream-model", choices: [{ index: 0, delta: {
          tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "search_", arguments: "{\"query\":" } }]
        } }] },
        { choices: [{ index: 0, delta: {
          tool_calls: [{ index: 0, function: { name: "events", arguments: "\"report\"}" } }]
        } }] }
      ]),
      eventStreamResponse([
        { model: "stream-model", choices: [{ index: 0, delta: { content: "Grounded " } }] },
        { choices: [{ index: 0, delta: { content: "result" } }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }
      ])
    ];
    const fetcher = (async (_input: string | URL | globalThis.Request, init?: globalThis.RequestInit) => {
      requests.push({ ...(init ? { init } : {}) });
      return responses.shift()!;
    }) as typeof globalThis.fetch;
    const executeTool = vi.fn(async () => [{ ref: "event_1" }]);
    const result = await new OpenAiCompatibleChatAdapter(fetcher).run({
      baseUrl: "https://model.example/v1", model: "stream-model", system: "grounded", user: "review",
      tools: createDefaultAgentToolRegistry().definitions("retrieve"), executeTool
    });
    expect(result).toMatchObject({
      text: "Grounded result", model: "stream-model", promptTokens: 12, completionTokens: 3, streaming: true
    });
    expect(executeTool).toHaveBeenCalledWith("search_events", { query: "report" }, "call-1");
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ stream: true, tool_choice: "auto" });
  });

  it("rejects a truncated stream even when its partial text is otherwise valid", async () => {
    const adapter = new OpenAiCompatibleChatAdapter((async () => new globalThis.Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" } }] })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )) as typeof globalThis.fetch);
    await expect(adapter.run({
      baseUrl: "https://model.example/v1", model: "stream-model", system: "grounded", user: "review",
      tools: createDefaultAgentToolRegistry().definitions("retrieve"), executeTool: async () => []
    })).rejects.toMatchObject({ code: "AGENT_MODEL_UNAVAILABLE", retryable: true });
  });

  it("verifies a connection with a minimal completion and preserves provider headers", async () => {
    const requests: Array<{ url: string; init?: globalThis.RequestInit }> = [];
    const adapter = new OpenAiCompatibleChatAdapter((async (input, init) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "OK" } }] });
    }) as typeof globalThis.fetch);
    await adapter.testConnection({
      baseUrl: "https://openrouter.ai/api/v1", model: "tool-model", apiKey: "secret",
      extraHeaders: { "x-openrouter-title": "Grudge Vault" }
    });
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: "Bearer secret", "x-openrouter-title": "Grudge Vault"
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      model: "tool-model", stream: false, max_tokens: 8,
      messages: [{ role: "user", content: "Reply with OK." }]
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).not.toHaveProperty("tools");

    await adapter.testConnection({
      baseUrl: "https://integrate.api.nvidia.com/v1",
      model: "deepseek-ai/deepseek-v4-pro-0813",
      apiKey: "secret"
    });
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
      model: "deepseek-ai/deepseek-v4-pro-0813", reasoning_effort: "none"
    });

    await adapter.testConnection({
      baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M3", apiKey: "secret"
    });
    expect(requests[2]?.url).toBe("https://api.minimaxi.com/v1/chat/completions");
    expect(JSON.parse(String(requests[2]?.init?.body))).toMatchObject({
      model: "MiniMax-M3", max_completion_tokens: 8, thinking: { type: "disabled" }
    });
    expect(JSON.parse(String(requests[2]?.init?.body))).not.toHaveProperty("max_tokens");

    const pendingRequests: string[] = [];
    const pending = new OpenAiCompatibleChatAdapter((async (input) => {
      pendingRequests.push(String(input));
      return pendingRequests.length === 1
        ? jsonResponse({ requestId: "request-123" }, {
            status: 202, headers: { "content-type": "application/json", "nvcf-reqid": "request-123" }
          })
        : jsonResponse({ choices: [{ message: { role: "assistant", content: "OK" } }] });
    }) as typeof globalThis.fetch);
    await pending.testConnection({
      baseUrl: "https://integrate.api.nvidia.com/v1", model: "async-model", apiKey: "secret"
    });
    expect(pendingRequests).toEqual([
      "https://integrate.api.nvidia.com/v1/chat/completions",
      "https://integrate.api.nvidia.com/v1/status/request-123"
    ]);

    const incompatible = new OpenAiCompatibleChatAdapter((async () => jsonResponse({ choices: [] })) as typeof globalThis.fetch);
    await expect(incompatible.testConnection({
      baseUrl: "https://integrate.api.nvidia.com/v1", model: "plain", apiKey: "secret"
    })).rejects.toMatchObject({ code: "AGENT_MODEL_UNAVAILABLE" });
  });

  it("connects, switches, lists, and disconnects provider services without exposing credentials", async () => {
    const context = createContext();
    databases.push(context.database);
    const tested: Array<{ baseUrl: string; model: string; extraHeaders?: Record<string, string> }> = [];
    const cataloged: string[] = [];
    const adapter: AgentModelAdapterPort = {
      identity: "fake.providers", version: 1,
      async run(input) {
        if (input.tools[0]?.name === "confirm_model_capability") {
          await input.executeTool("confirm_model_capability", { ok: true }, "capability-test");
        }
        return { text: "ok", model: input.model, streaming: true };
      },
      async testConnection(input) { tested.push(input); },
      async listModels(input) {
        cataloged.push(input.baseUrl);
        if (input.baseUrl.includes("nvidia.com")) {
          return [{ id: "deepseek-ai/deepseek-v4-pro-0813", name: "DeepSeek V4 Pro" }];
        }
        return [
          { id: "tools-model", name: "Tools model", supportedParameters: ["tools"], inputModalities: ["text"], outputModalities: ["text"] },
          { id: "plain-model", name: "Plain model", supportedParameters: ["temperature"], inputModalities: ["text"], outputModalities: ["text"] }
        ];
      }
    };
    const harness = new AgentHarness(context.application, { modelAdapter: adapter });
    const models = await harness.listLlmModels({ provider: "openrouter", apiKey: "temporary-key" });
    expect(models.map(({ id }) => id)).toEqual(["tools-model", "plain-model"]);
    expect(models[0]).toMatchObject({
      inputModalities: ["text"], outputModalities: ["text"], compatibility: "compatible", modalitySource: "provider"
    });
    expect(models[1]).toMatchObject({ compatibility: "incompatible", compatibilityReason: "no_tool_calling" });
    const minimaxModels = await harness.listLlmModels({ provider: "minimax", apiKey: "temporary-key" });
    expect(minimaxModels).toEqual([expect.objectContaining({
      id: "MiniMax-M3", recommended: true, toolCapable: true, compatibility: "compatible",
      inputModalities: ["text", "image"], outputModalities: ["text"]
    })]);

    const saved = harness.saveLlm({
      provider: "nvidia", model: "deepseek-ai/deepseek-v4-pro-0813", apiKey: "nvidia-key"
    });
    expect(saved.activeProvider).toBeUndefined();
    expect(saved.providers.nvidia).toMatchObject({
      model: "deepseek-ai/deepseek-v4-pro-0813", credentialConfigured: true, status: "needs_attention"
    });
    expect(JSON.stringify(saved)).not.toContain("nvidia-key");
    expect(String(context.database.prepare(
      "SELECT envelope_json FROM llm_provider_credentials WHERE provider = 'nvidia'"
    ).pluck().get())).not.toContain("nvidia-key");

    const nvidia = await harness.connectLlm({ provider: "nvidia", model: "deepseek-ai/deepseek-v4-pro-0813" });
    expect(nvidia.activeProvider).toBe("nvidia");
    expect(nvidia.providers.nvidia).toMatchObject({ credentialConfigured: true, status: "ready" });
    const openrouter = await harness.connectLlm({ provider: "openrouter", model: "tools-model", apiKey: "router-key" });
    expect(openrouter.activeProvider).toBe("openrouter");
    expect(openrouter.providers.nvidia?.credentialConfigured).toBe(true);
    const minimax = await harness.connectLlm({ provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-key" });
    expect(minimax.activeProvider).toBe("minimax");
    expect(minimax.providers.minimax).toMatchObject({
      model: "MiniMax-M3", credentialConfigured: true, status: "ready",
      capabilities: {
        inputModalities: ["text"], outputModalities: ["text"], structuredOutput: true,
        streaming: true,
        verifiedTasks: ["connection", "structured_output"]
      }
    });
    expect(tested).toEqual(expect.arrayContaining([
      expect.objectContaining({ baseUrl: "https://integrate.api.nvidia.com/v1" }),
      expect.objectContaining({
        baseUrl: "https://openrouter.ai/api/v1", extraHeaders: { "x-openrouter-title": "Grudge Vault" }
      }),
      expect.objectContaining({ baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M3" })
    ]));
    expect(cataloged).toContain("https://integrate.api.nvidia.com/v1");
    expect(JSON.stringify(openrouter)).not.toContain("router-key");
    expect(String(context.database.prepare(
      "SELECT envelope_json FROM llm_provider_credentials WHERE provider = 'openrouter'"
    ).pluck().get())).not.toContain("router-key");
    expect(String(context.database.prepare(
      "SELECT envelope_json FROM llm_provider_credentials WHERE provider = 'minimax'"
    ).pluck().get())).not.toContain("minimax-key");
    const paused = harness.pauseLlm();
    expect(paused.activeProvider).toBeUndefined();
    expect(paused.providers.minimax).toMatchObject({ credentialConfigured: true, status: "ready" });
    expect(context.application.getLlmCredential("minimax")).toBe("minimax-key");
    expect((await harness.activateLlm("nvidia")).activeProvider).toBe("nvidia");
    expect(harness.disconnectLlm("nvidia").activeProvider).toBeUndefined();
  });

  it.each(["connect_connection", "connect_structured", "activate"].flatMap((operation) =>
    ["closed", "reopened", "other_workspace", "model", "credential", "paused", "disconnected", "other_provider"]
      .map((change) => ({ operation, change }))
  ))("rejects late $operation configuration results after $change", async ({ operation, change }) => {
    const context = createContext();
    databases.push(context.database);
    context.application.saveLlmConnection({
      provider: "bailian", model: "qwen3.7-plus", region: "cn-beijing", apiKey: "original-test-key"
    }, "2026-09-28T00:00:00.000Z");
    let release!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    let structuredCalls = 0;
    const adapter: AgentModelAdapterPort = {
      identity: "fake.configuration-race", version: 1,
      async testConnection() {
        if (operation !== "connect_structured") { notifyStarted(); await delayed; }
      },
      async run(input) {
        structuredCalls += 1;
        if (operation === "connect_structured") { notifyStarted(); await delayed; }
        await input.executeTool("confirm_model_capability", { ok: true }, "configuration-race");
        return { model: input.model, streaming: true };
      }
    };
    const harness = new AgentHarness(context.application, { modelAdapter: adapter });
    const pending = operation === "activate" ? harness.activateLlm("bailian") : harness.connectLlm({
      provider: "bailian", model: "qwen3.8-omni-flash", region: "cn-beijing", apiKey: "proposed-test-key"
    });
    await started;
    let destination: ReturnType<typeof createContext> | undefined;
    if (change === "closed") vi.spyOn(context.manager, "current").mockReturnValue(undefined);
    else if (change === "reopened") vi.spyOn(context.manager, "current").mockReturnValue({ ...context.session });
    else if (change === "other_workspace") {
      destination = createContext();
      databases.push(destination.database);
      destination.session.workspace = { ...destination.session.workspace, id: "00000000-0000-4000-8000-000000000002" };
      vi.spyOn(context.manager, "current").mockReturnValue(destination.session);
    } else if (change === "model") context.application.saveLlmConnection({
      provider: "bailian", model: "qwen3.8-flash", region: "cn-beijing", apiKey: "newer-test-key"
    }, "2026-09-28T00:00:01.000Z");
    else if (change === "credential") context.application.saveLlmProvider({
      provider: "bailian", model: "qwen3.7-plus", region: "cn-beijing", apiKey: "rotated-test-key"
    });
    else if (change === "paused") context.application.pauseLlmProviders();
    else if (change === "disconnected") context.application.disconnectLlmProvider("bailian");
    else if (change === "other_provider") context.application.saveLlmConnection({
      provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-test-key"
    }, "2026-09-28T00:00:01.000Z");
    const beforeSettings = context.session.agents.getLlmSettings();
    const beforeCredential = context.session.agents.getLlmCredential("bailian");
    const destinationSettings = destination?.session.agents.getLlmSettings();
    const destinationCredential = destination?.session.agents.getLlmCredential("bailian");
    release();
    await expect(pending).rejects.toMatchObject({ code: "LLM_CONFIGURATION_CHANGED", retryable: true });
    expect(context.session.agents.getLlmSettings()).toEqual(beforeSettings);
    expect(context.session.agents.getLlmCredential("bailian")).toEqual(beforeCredential);
    expect(destination?.session.agents.getLlmSettings()).toEqual(destinationSettings);
    expect(destination?.session.agents.getLlmCredential("bailian")).toEqual(destinationCredential);
    expect(structuredCalls).toBe(operation === "connect_structured" ? 1 : 0);
  });

  it.each(["connect", "activate"])("does not undo an idempotent pause during %s", async (operation) => {
    const context = createContext();
    databases.push(context.database);
    context.application.saveLlmConnection({
      provider: "minimax", model: "MiniMax-M3", apiKey: "saved-key"
    }, "2026-09-28T00:00:00.000Z");
    context.application.pauseLlmProviders();
    let release!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async (input: Parameters<AgentModelAdapterPort["run"]>[0]) => {
      await input.executeTool("confirm_model_capability", { ok: true }, "paused-capability");
      return { model: input.model };
    });
    const harness = new AgentHarness(context.application, { modelAdapter: {
      identity: "fake.idempotent-pause", version: 1, run,
      async testConnection() { notifyStarted(); await delayed; }
    } });
    const pending = operation === "activate" ? harness.activateLlm("minimax") : harness.connectLlm({
      provider: "minimax", model: "MiniMax-M3"
    });
    await started;
    context.application.pauseLlmProviders();
    const before = context.application.getLlmSettings();
    release();
    await expect(pending).rejects.toMatchObject({ code: "LLM_CONFIGURATION_CHANGED" });
    expect(run).not.toHaveBeenCalled();
    expect(context.application.getLlmSettings()).toEqual(before);
    expect(context.application.getLlmSettings().activeProvider).toBeUndefined();
  });

  it("only permits the latest connection request to save, even when an older request finishes first", async () => {
    const context = createContext();
    databases.push(context.database);
    let releaseOlder!: () => void;
    let releaseNewer!: () => void;
    let notifyOlder!: () => void;
    let notifyNewer!: () => void;
    const olderStarted = new Promise<void>((resolve) => { notifyOlder = resolve; });
    const newerStarted = new Promise<void>((resolve) => { notifyNewer = resolve; });
    const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const newerGate = new Promise<void>((resolve) => { releaseNewer = resolve; });
    const structuredModels: string[] = [];
    const harness = new AgentHarness(context.application, { modelAdapter: {
      identity: "fake.latest-connection", version: 1,
      async testConnection(input) {
        if (input.model === "older-model") { notifyOlder(); await olderGate; }
        else { notifyNewer(); await newerGate; }
      },
      async run(input) {
        structuredModels.push(input.model);
        await input.executeTool("confirm_model_capability", { ok: true }, "latest-capability");
        return { model: input.model };
      }
    } });
    const older = harness.connectLlm({ provider: "minimax", model: "older-model", apiKey: "older-key" });
    await olderStarted;
    const newer = harness.connectLlm({ provider: "minimax", model: "newer-model", apiKey: "newer-key" });
    await newerStarted;
    releaseOlder();
    await expect(older).rejects.toMatchObject({ code: "LLM_CONFIGURATION_CHANGED" });
    expect(context.application.getLlmSettings()).toEqual({ providers: {} });
    expect(context.session.agents.getLlmCredential("minimax")).toBeUndefined();
    releaseNewer();
    await expect(newer).resolves.toMatchObject({ activeProvider: "minimax", providers: { minimax: { model: "newer-model" } } });
    expect(context.application.getLlmCredential("minimax")).toBe("newer-key");
    expect(structuredModels).toEqual(["newer-model"]);
  });

  it("tests and saves a stable copy of the originally submitted connection input", async () => {
    const context = createContext();
    databases.push(context.database);
    let release!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const request = { provider: "minimax" as const, model: "original-model", apiKey: "original-key" };
    const harness = new AgentHarness(context.application, { modelAdapter: {
      identity: "fake.stable-connection-input", version: 1,
      async testConnection(input) {
        expect(input.model).toBe("original-model");
        notifyStarted(); await delayed;
      },
      async run(input) {
        expect(input.model).toBe("original-model");
        expect(input.apiKey).toBe("original-key");
        await input.executeTool("confirm_model_capability", { ok: true }, "stable-capability");
        return { model: input.model };
      }
    } });
    const pending = harness.connectLlm(request);
    await started;
    request.model = "mutated-model";
    request.apiKey = "mutated-key";
    release();
    await expect(pending).resolves.toMatchObject({ providers: { minimax: { model: "original-model" } } });
    expect(context.application.getLlmCredential("minimax")).toBe("original-key");
  });

  it("checks the exact image bytes before the model call and only then verifies image screening", async () => {
    const context = createContext();
    databases.push(context.database);
    context.application.saveLlmConnection({
      provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-key"
    }, "2026-09-20T00:00:00.000Z", {
      inputModalities: ["text"], outputModalities: ["text"], structuredOutput: true,
      verifiedTasks: ["connection", "structured_output"], lastVerifiedAt: "2026-09-20T00:00:00.000Z"
    });
    let modelCalls = 0;
    const adapter: AgentModelAdapterPort = {
      identity: "fake.image-screening", version: 1,
      async run(input) {
        modelCalls += 1;
        expect(input.userContent).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "image_url" })
        ]));
        await input.executeTool("submit_screening", {
          decision: "include", categories: ["rights"], reason: "图片显示具体权益争议。",
          anchors: [{ sourceVersion: "source-image-1", temporaryMediaRef: "temporary-image-1" }],
          coverage: "complete", policyVersion: "screening-v1"
        }, "screen-image");
        return { text: "submitted", model: input.model };
      }
    };
    const imagePath = join(tmpdir(), `grudge-vault-screen-${process.pid}-${Date.now()}.png`);
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(imagePath, imageBytes);
    try {
      const harness = new AgentHarness(context.application, { modelAdapter: adapter });
      const media = {
        id: "temporary-image-1", path: imagePath, fileName: "evidence.png",
        mimeType: "image/png", byteSize: imageBytes.length, kind: "image" as const
      };
      await expect(harness.screen({
        text: "", origin: "manual", sourceVersion: "source-image-1",
        media: [{ ...media, screenedSha256: "0".repeat(64) }]
      })).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
      expect(modelCalls).toBe(0);
      const result = await harness.screen({
        text: "", origin: "manual", sourceVersion: "source-image-1",
        media: [{ ...media, screenedSha256: createHash("sha256").update(imageBytes).digest("hex") }]
      });
      expect(result.decision).toBe("include");
      expect(modelCalls).toBe(1);
      expect(context.application.getLlmSettings().providers.minimax?.capabilities).toMatchObject({
        inputModalities: ["text", "image"], verifiedTasks: ["connection", "structured_output", "screening"]
      });
    } finally {
      await rm(imagePath, { force: true });
    }
  });

  it.each([
    "model", "region", "business_workspace", "credential", "retested", "active_provider", "paused", "workspace", "closed"
  ])("does not apply a late media capability result after changing %s", async (change) => {
    const context = createContext();
    databases.push(context.database);
    const testedAt = "2026-09-28T00:00:00.000Z";
    const original = {
      provider: "bailian" as const, model: "qwen3.8-omni-flash", region: "cn-beijing" as const,
      workspaceId: "ws-original", apiKey: "original-key"
    };
    const textCapabilities = {
      inputModalities: ["text" as const], outputModalities: ["text" as const], structuredOutput: true,
      verifiedTasks: ["connection" as const, "structured_output" as const], lastVerifiedAt: testedAt
    };
    context.application.saveLlmConnection(original, testedAt, textCapabilities);
    let release!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const adapter: AgentModelAdapterPort = {
      identity: "fake.late-capability", version: 1,
      async run(input) {
        notifyStarted();
        await delayed;
        await input.executeTool("submit_screening", {
          decision: "include", categories: ["rights"], reason: "合成图片中的权益争议。",
          anchors: [{ sourceVersion: "late-source", temporaryMediaRef: "late-image" }],
          coverage: "complete", policyVersion: "screening-v1"
        }, "late-screening");
        return { model: input.model };
      }
    };
    const screening = new AgentHarness(context.application, { modelAdapter: adapter }).screen({
      text: "合成权益材料", origin: "manual", sourceVersion: "late-source",
      media: [{ id: "late-image", fileName: "synthetic.png", mimeType: "image/png", kind: "image",
        byteSize: 4, bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) }]
    });
    await started;
    if (change === "model") context.application.saveLlmConnection({ ...original, model: "qwen3.7-plus" }, testedAt, textCapabilities);
    else if (change === "region") context.application.saveLlmConnection({ ...original, region: "ap-southeast-1" }, testedAt, textCapabilities);
    else if (change === "business_workspace") context.application.saveLlmConnection({ ...original, workspaceId: "ws-other" }, testedAt, textCapabilities);
    else if (change === "credential") context.application.saveLlmConnection({ ...original, apiKey: "rotated-key" }, testedAt, textCapabilities);
    else if (change === "retested") context.application.saveLlmConnection(original, "2026-09-28T00:00:01.000Z", textCapabilities);
    else if (change === "active_provider") context.application.saveLlmConnection({ provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-key" }, testedAt, textCapabilities);
    else if (change === "paused") context.application.pauseLlmProviders();
    else if (change === "workspace") context.session.workspace = { ...context.session.workspace, id: "00000000-0000-4000-8000-000000000002" };
    else if (change === "closed") vi.spyOn(context.manager, "current").mockReturnValue(undefined);
    const before = context.session.agents.getLlmProviderConfig("bailian");
    release();
    await expect(screening).resolves.toMatchObject({ decision: "include" });
    expect(context.session.agents.getLlmProviderConfig("bailian")).toEqual(before);
    expect(context.session.agents.getLlmProviderConfig("bailian")?.capabilities?.inputModalities).toEqual(["text"]);
    expect(context.session.agents.getLlmProviderConfig("minimax")?.capabilities?.inputModalities ?? ["text"]).toEqual(["text"]);
  });

  it("sends small audio and video directly to Qwen Omni without a local transcriber", async () => {
    const context = createContext();
    databases.push(context.database);
    context.application.saveLlmConnection({
      provider: "bailian", model: "qwen3.8-omni-flash", apiKey: "test-key", region: "cn-beijing"
    }, "2026-09-21T00:00:00.000Z", {
      inputModalities: ["text"], outputModalities: ["text"], structuredOutput: true,
      verifiedTasks: ["connection", "structured_output"], lastVerifiedAt: "2026-09-21T00:00:00.000Z"
    });
    const adapter: AgentModelAdapterPort = {
      identity: "fake.omni-screening", version: 1,
      async run(input) {
        expect(input.userContent).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "input_audio", input_audio: expect.objectContaining({ format: "mp3" }) }),
          expect.objectContaining({ type: "video_url" })
        ]));
        await input.executeTool("submit_screening", {
          decision: "include", categories: ["danger"], reason: "音视频中有具体安全风险。",
          anchors: [{ sourceVersion: "source-media", temporaryMediaRef: "audio-1" },
            { sourceVersion: "source-media", temporaryMediaRef: "video-1" }],
          coverage: "complete", policyVersion: "screening-v1"
        }, "screen-media");
        return { model: input.model };
      }
    };
    const audioPath = join(tmpdir(), `grudge-vault-audio-${process.pid}-${Date.now()}.mp3`);
    const videoPath = join(tmpdir(), `grudge-vault-video-${process.pid}-${Date.now()}.mp4`);
    await Promise.all([writeFile(audioPath, Buffer.from([1, 2, 3])), writeFile(videoPath, Buffer.from([4, 5, 6]))]);
    try {
      const result = await new AgentHarness(context.application, { modelAdapter: adapter }).screen({
        text: "", origin: "manual", sourceVersion: "source-media",
        media: [
          { id: "audio-1", path: audioPath, fileName: "evidence.mp3", mimeType: "audio/mpeg", byteSize: 3, kind: "audio" },
          { id: "video-1", path: videoPath, fileName: "evidence.mp4", mimeType: "video/mp4", byteSize: 3, kind: "video" }
        ]
      });
      expect(result.decision).toBe("include");
      expect(context.application.getLlmSettings().providers.bailian?.capabilities?.inputModalities)
        .toEqual(expect.arrayContaining(["audio", "video"]));
    } finally {
      await Promise.all([rm(audioPath, { force: true }), rm(videoPath, { force: true })]);
    }
  });

  it("keeps report media anchors only for attachments actually analyzed by the model", async () => {
    const context = createContext();
    databases.push(context.database);
    context.application.saveLlmConnection({
      provider: "bailian", model: "qwen3.8-omni-flash", apiKey: "test-key", region: "cn-beijing"
    }, "2026-09-23T00:00:00.000Z");
    const assetId = "00000000-0000-4000-8000-000000000011";
    vi.spyOn(context.application, "previewAsset").mockResolvedValue({
      assetId, fileName: "synthetic.mp3", mimeType: "audio/mpeg", bytes: Buffer.from("ID3synthetic")
    });
    let includeTimedSegment = true;
    const adapter: AgentModelAdapterPort = {
      identity: "test.report-anchors", version: 1,
      async run(input) {
        expect(input.userContent).toEqual(expect.arrayContaining([expect.objectContaining({ type: "input_audio" })]));
        await input.executeTool("submit_report", {
          summary: "通话里讨论了加班安排", time: { source: "ai" }, location: { source: "ai" }, people: [],
          chronology: includeTimedSegment ? [
            { text: "讨论了加班安排", attachmentRef: assetId, intervalMs: [1_000, 2_000] },
            { text: "无法定位的描述", attachmentRef: "00000000-0000-4000-8000-000000000099" }
          ] : [],
          mediaSegments: includeTimedSegment ? [
            { description: "录音中提到额外加班", attachmentRef: assetId, intervalMs: [3_000, 4_000] },
            { description: "没有时间的录音描述", attachmentRef: assetId },
            { description: "伪造的附件描述", attachmentRef: "00000000-0000-4000-8000-000000000099", intervalMs: [0, 1_000] }
          ] : [],
          examinedAttachmentIds: [assetId], unknowns: [], disputes: [],
          speculations: ["对方可能以后再安排类似加班，尚无证据。"], suggestions: [],
          legalIssues: [], coverageNotes: [], state: "complete"
        }, "report-call");
        return { model: input.model };
      }
    };
    const harness = new AgentHarness(context.application, { modelAdapter: adapter });
    const analysisInput: Parameters<AgentHarness["analyze"]>[0] = {
      record: {
        id: "record-1", origin: "manual", categories: ["grudge"], title: "通话", summary: "",
        revision: 1, occurredAt: { kind: "unknown" }, recordedAt: "2026-09-23T00:00:00.000Z",
        reportState: "queued", sourceUpdated: false, sourceReviewRequired: false, attachmentCount: 1,
        createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z"
      },
      source: {
        id: "source-1", recordId: "record-1", origin: "manual", sourceVersion: "audio-v1",
        contentHash: "a".repeat(64), text: "用户提交了通话", recordedAt: "2026-09-23T00:00:00.000Z",
        createdAt: "2026-09-23T00:00:00.000Z"
      },
      attachments: [{
        id: assetId, sha256: "b".repeat(64), byteSize: 12, mimeType: "audio/mpeg",
        originalFileName: "synthetic.mp3", vaultFormat: 2, integrityStatus: "verified",
        availabilityStatus: "available", createdAt: "2026-09-23T00:00:00.000Z"
      }], overrides: []
    };
    const report = await harness.analyze(analysisInput);
    expect(report.content.speculations).toEqual(["对方可能以后再安排类似加班，尚无证据。"]);
    expect(report.content.chronology[0]?.anchor).toEqual({
      sourceVersion: "audio-v1", assetId, intervalMs: [1_000, 2_000]
    });
    expect(report.content.chronology[1]?.anchor).toBeUndefined();
    expect(report.content.mediaSegments).toEqual([expect.objectContaining({
      description: "录音中提到额外加班",
      anchor: { sourceVersion: "audio-v1", assetId, intervalMs: [3_000, 4_000] }
    })]);
    expect(report.content.coverageNotes.some((note) => note.includes("缺少可核对的时间定位"))).toBe(true);
    expect(report.state).toBe("partial");
    includeTimedSegment = false;
    const unlocated = await harness.analyze(analysisInput);
    expect(unlocated.state).toBe("partial");
    expect(unlocated.content.coverageNotes.some((note) => note.includes("未返回可定位片段"))).toBe(true);
  });

  it("keeps protected user temporal values as meaningful report fields and labels previous AI occurrence as a projection", async () => {
    const context = createContext(); databases.push(context.database);
    context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash", apiKey: "test-key", region: "cn-beijing" },
      "2026-09-29T00:00:00Z");
    const adapter: AgentModelAdapterPort = { identity: "test.protected-report-time", version: 1, async run(input) {
      expect(input.system).toContain("不是已核实时间");
      await input.executeTool("submit_report", { summary: "合成事件报告", time: { source: "ai", value: { value: "2099-01-01", precision: "exact" } },
        location: { source: "ai" }, people: [], chronology: [], unknowns: [], disputes: [], suggestions: [], legalIssues: [],
        coverageNotes: [], state: "complete" }, "synthetic-time-report");
      return { model: input.model };
    } };
    const harness = new AgentHarness(context.application, { modelAdapter: adapter });
    for (const [value, expected] of [[{ kind: "unknown" }, { source: "user", prompt: "待补充：大约何时发生？" }],
      [{ kind: "relative", text: "上周" }, { source: "user", value: { value: "上周", precision: "approximate" } }],
      [{ kind: "range", to: "2026-09" }, { source: "user", value: { value: "? — 2026-09", precision: "range" } }]] as const) {
      const input = syntheticAuxiliaryReport({ mimeType: "audio/mpeg", sha256: "a".repeat(64), byteSize: 5 });
      input.attachments = [];
      input.record = { ...input.record, attachmentCount: 0, occurredAtSource: "ai", occurredAt: { kind: "date", value: "2026-09-20" } };
      input.overrides = [{ id: "00000000-0000-4000-8000-000000000022", recordId: input.record.id, fieldKey: "occurredAt", value,
        actor: "user", revision: 1, createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z" }];
      expect((await harness.analyze(input)).content.time).toEqual(expected);
    }
  });

  it("does not mark a media report complete when the model omits per-attachment coverage", async () => {
    const context = createContext();
    databases.push(context.database);
    context.application.saveLlmConnection({
      provider: "bailian", model: "qwen3.8-omni-flash", apiKey: "test-key", region: "cn-beijing"
    }, "2026-09-23T00:00:00.000Z");
    const assetId = "00000000-0000-4000-8000-000000000012";
    vi.spyOn(context.application, "previewAsset").mockResolvedValue({
      assetId, fileName: "synthetic.png", mimeType: "image/png", bytes: Buffer.from("synthetic-image")
    });
    let confirmsCoverage = false;
    const adapter: AgentModelAdapterPort = {
      identity: "test.report-missing-coverage", version: 1,
      async run(input) {
        expect(input.userContent).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url" })]));
        await input.executeTool("submit_report", {
          summary: "图片记录了现场情况", time: { source: "ai" }, location: { source: "ai" }, people: [],
          chronology: [{ text: "图片中的情况", attachmentRef: assetId }],
          ...(confirmsCoverage ? { examinedAttachmentIds: [assetId] } : {}),
          unknowns: [], disputes: [], suggestions: [], legalIssues: [], coverageNotes: [], state: "complete"
        }, "report-missing-coverage");
        return { model: input.model };
      }
    };
    const harness = new AgentHarness(context.application, { modelAdapter: adapter });
    const analysisInput: Parameters<AgentHarness["analyze"]>[0] = {
      record: {
        id: "record-coverage", origin: "manual", categories: ["grudge"], title: "现场", summary: "",
        revision: 1, occurredAt: { kind: "unknown" }, recordedAt: "2026-09-23T00:00:00.000Z",
        reportState: "queued", sourceUpdated: false, sourceReviewRequired: false, attachmentCount: 1,
        createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z"
      },
      source: {
        id: "source-coverage", recordId: "record-coverage", origin: "manual", sourceVersion: "image-v1",
        contentHash: "a".repeat(64), text: "用户提交了图片", recordedAt: "2026-09-23T00:00:00.000Z",
        createdAt: "2026-09-23T00:00:00.000Z"
      },
      attachments: [{
        id: assetId, sha256: "b".repeat(64), byteSize: 15, mimeType: "image/png",
        originalFileName: "synthetic.png", vaultFormat: 2, integrityStatus: "verified",
        availabilityStatus: "available", createdAt: "2026-09-23T00:00:00.000Z"
      }], overrides: []
    };
    const report = await harness.analyze(analysisInput);
    expect(report.state).toBe("partial");
    expect(report.content.chronology[0]?.anchor).toBeUndefined();
    expect(report.content.coverageNotes.some((note) => note.includes("未明确确认检查"))).toBe(true);
    confirmsCoverage = true;
    const retried = await harness.analyze(analysisInput);
    expect(retried.state).toBe("complete");
    expect(retried.content.chronology[0]?.anchor).toEqual({ sourceVersion: "image-v1", assetId });
  });

  it("propagates report cancellation through its model and legal-research phases", async () => {
    const context = createContext();
    databases.push(context.database);
    context.application.saveLlmConnection({
      provider: "minimax", model: "MiniMax-M3", apiKey: "synthetic-key"
    }, "2026-09-23T00:00:00.000Z");
    const controller = new AbortController();
    let legalStarted!: () => void;
    const started = new Promise<void>((resolve) => { legalStarted = resolve; });
    let releaseLegal!: () => void;
    const hold = new Promise<void>((resolve) => { releaseLegal = resolve; });
    const modelAdapter: AgentModelAdapterPort = {
      identity: "fake.cancelled-report", version: 1,
      async run(input) {
        expect(input.signal).toBe(controller.signal);
        await input.executeTool("submit_report", {
          summary: "存在报酬争议", time: { source: "ai" }, location: { source: "ai" }, people: [],
          chronology: [], examinedAttachmentIds: [], unknowns: [], disputes: [], suggestions: [],
          legalIssues: ["需核对报酬依据"], coverageNotes: [], state: "complete"
        }, "cancelled-report");
        return { model: input.model };
      }
    };
    const legalResearch: LegalResearchPort = {
      async research(_input, signal) {
        expect(signal).toBe(controller.signal);
        legalStarted();
        await hold;
        return { issues: [], citations: [], coverageNotes: [] };
      }
    };
    const analysisInput: Parameters<AgentHarness["analyze"]>[0] = {
      record: {
        id: "record-cancelled-report", origin: "manual", categories: ["rights"], title: "报酬争议", summary: "",
        revision: 1, occurredAt: { kind: "unknown" }, recordedAt: "2026-09-23T00:00:00.000Z",
        reportState: "queued", sourceUpdated: false, sourceReviewRequired: false, attachmentCount: 0,
        createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z"
      },
      source: {
        id: "source-cancelled-report", recordId: "record-cancelled-report", origin: "manual",
        sourceVersion: "cancelled-report-v1", contentHash: "a".repeat(64), text: "公司未结清奖金",
        recordedAt: "2026-09-23T00:00:00.000Z", createdAt: "2026-09-23T00:00:00.000Z"
      },
      attachments: [], overrides: []
    };
    const pending = new AgentHarness(context.application, { modelAdapter, legalResearch })
      .analyze(analysisInput, controller.signal);
    await started;
    controller.abort();
    releaseLegal();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not silently truncate or classify unsupported native audio", async () => {
    const context = createContext();
    databases.push(context.database);
    context.application.saveLlmConnection({
      provider: "bailian", model: "qwen3.8-omni-flash", apiKey: "test-key", region: "cn-beijing"
    }, "2026-09-21T00:00:00.000Z");
    const adapter: AgentModelAdapterPort = {
      identity: "fake.never-called", version: 1,
      async run() { throw new Error("unsupported media must not be sent to the model"); }
    };
    const audioPath = join(tmpdir(), `grudge-vault-unsupported-${process.pid}-${Date.now()}.m4a`);
    await writeFile(audioPath, Buffer.from([1, 2, 3]));
    try {
      const harness = new AgentHarness(context.application, { modelAdapter: adapter });
      await expect(harness.screen({ text: "", origin: "manual", sourceVersion: "v1",
        media: [{ id: "audio-1", path: audioPath, fileName: "call.m4a",
          mimeType: "audio/mp4", byteSize: 3, kind: "audio" }]
      })).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
      await expect(harness.screen({ text: "", origin: "manual", sourceVersion: "v1",
        media: [{ id: "audio-1", path: audioPath, fileName: "call.mp3",
          mimeType: "audio/mpeg", byteSize: 7_000_001, kind: "audio" }]
      })).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
    } finally {
      await rm(audioPath, { force: true });
    }
  });

  it.each(["complete", "partial", "pause and reactivate", "invalid time"] as const)(
    "screens all native clips with conservative failure on %s", async (mode) => {
      const context = createContext(); databases.push(context.database);
      context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash",
        apiKey: "synthetic-key", region: "cn-beijing" }, "2026-09-28T00:00:00Z");
      const closed = vi.fn(); const calls: string[] = [];
      const nativeMediaSegments: NativeMediaSegmentPort = {
        async *segments(source) {
          expect(source).toMatchObject({ kind: "audio", mimeType: "audio/mp4", sha256: "a".repeat(64) });
          try {
            for (let index = 0; index < 2; index++) yield { index, startMs: index * 10_000,
              endMs: (index + 1) * 10_000, sourceDurationMs: 20_000, mimeType: "audio/wav", bytes: Buffer.from("clip") };
          } finally { closed(); }
        }
      };
      const adapter: AgentModelAdapterPort = { identity: "test.full-clip-screen", version: 1,
        async run(input) {
          const tool = input.tools[0]!.name; calls.push(tool);
          if (tool === "submit_media_segment_observations") {
            const clipId = /segment-\d+/.exec(input.user)![0];
            await input.executeTool(tool, { examinedSegmentId: clipId,
              coverage: mode === "partial" ? "partial" : "complete",
              summary: clipId === "segment-0" ? "开头普通日常" : "后段包含合成争议话语",
              observations: [{ description: "合成观察", intervalMs: [100, 200] }], notes: [] }, "clip");
            if (mode === "pause and reactivate") {
              context.application.pauseLlmProviders();
              context.application.activateLlmProvider("bailian", "2026-09-28T00:00:00Z");
            } else context.application.markLlmModalityVerified("bailian", "image", "2026-09-28T00:00:00Z", {
              workspaceId: context.session.workspace.id,
              configuration: context.application.getLlmSettings().providers.bailian!,
              credentialHash: createHash("sha256").update("synthetic-key").digest("hex")
            });
          } else {
            const content = input.userContent as Array<{ type: string; text?: string }>;
            expect(content.every(({ type }) => type === "text")).toBe(true);
            expect(JSON.stringify(content)).toContain("后段包含合成争议话语");
            expect(JSON.stringify(content)).toContain("10100");
            await input.executeTool(tool, { decision: "include", categories: ["rights"], reason: "后段相关",
              anchors: [{ sourceVersion: "clip-v1", temporaryMediaRef: "audio-1",
                intervalMs: mode === "invalid time" ? [20_000, 20_001] : [10_100, 10_200] }],
              coverage: "complete", policyVersion: "screening-v1" }, "screen");
          }
          return { model: input.model };
        }
      };
      const pending = new AgentHarness(context.application, { modelAdapter: adapter, nativeMediaSegments }).screen({
        text: "", origin: "manual", sourceVersion: "clip-v1", media: [{ id: "audio-1", path: "/synthetic/not-read.m4a",
          kind: "audio", mimeType: "audio/mp4", byteSize: 8_000_000, fileName: "synthetic.m4a", screenedSha256: "a".repeat(64) }]
      });
      if (mode === "complete") {
        await expect(pending).resolves.toMatchObject({ decision: "include", anchors: [{ intervalMs: [10_100, 10_200] }] });
        expect(calls).toEqual(["submit_media_segment_observations", "submit_media_segment_observations", "submit_screening"]);
        expect(context.application.getLlmSettings().providers.bailian?.capabilities?.inputModalities).toContain("audio");
      } else {
        await expect(pending).rejects.toMatchObject({ code: mode === "partial" ? "MODALITY_UNAVAILABLE"
          : mode === "invalid time" ? "SCREENING_FAILED" : "LLM_CONFIGURATION_CHANGED" });
        if (mode !== "invalid time") expect(calls).toEqual(["submit_media_segment_observations"]);
        expect(context.application.getLlmSettings().providers.bailian?.capabilities?.inputModalities ?? []).not.toContain("audio");
      }
      expect(closed).toHaveBeenCalledOnce();
    }
  );

  it("retains the checked report tail on original-media anchors without buffering a large preview", async () => {
    const context = createContext(); databases.push(context.database);
    context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash",
      apiKey: "synthetic-key", region: "cn-beijing" }, "2026-09-28T00:00:00Z");
    const assetId = "00000000-0000-4000-8000-000000000021";
    const source: NativeMediaSegmentInput = { kind: "video", mimeType: "video/mp4", byteSize: 70 * 1024 * 1024,
      sha256: "a".repeat(64), async open() { throw new Error("Injected native port only"); } };
    vi.spyOn(context.application, "openMediaSourceForAnalysis").mockResolvedValue(source);
    const preview = vi.spyOn(context.application, "previewAsset").mockRejectedValue(new Error("Must not buffer long source"));
    const nativeMediaSegments: NativeMediaSegmentPort = { async *segments(input) {
      expect(input).toBe(source);
      for (let index = 0; index < 2; index++) yield { index, startMs: index * 10_000, endMs: (index + 1) * 10_000,
        sourceDurationMs: 20_000, mimeType: "video/mp4", bytes: Buffer.from("clip") };
    } };
    const adapter: AgentModelAdapterPort = { identity: "test.native-report", version: 1, async run(input) {
      const tool = input.tools[0]!.name;
      if (tool === "submit_media_segment_observations") {
        const id = /segment-\d+/.exec(input.user)![0];
        await input.executeTool(tool, { examinedSegmentId: id, coverage: "complete", summary: `${id} 已检查`,
          observations: [{ description: "后段动作", intervalMs: [100, 200], frameTimeMs: 150 }], notes: [] }, "clip");
      } else {
        expect(JSON.stringify(input.userContent)).toContain("segment-1 已检查");
        await input.executeTool(tool, { summary: "最终模型只概括了开头", time: { source: "ai" }, location: { source: "ai" },
          people: [], chronology: [{ text: "模型越界定位", attachmentRef: assetId, intervalMs: [0, 20_001] }],
          mediaSegments: [{ description: "模型越界帧", attachmentRef: assetId, frameTimeMs: 20_001 }],
          examinedAttachmentIds: [assetId], unknowns: [], disputes: [], suggestions: [], legalIssues: [], coverageNotes: [], state: "complete" }, "report");
      }
      return { model: input.model };
    } };
    const result = await new AgentHarness(context.application, { modelAdapter: adapter, nativeMediaSegments }).analyze({
      record: { id: "record-1", origin: "manual", categories: ["grudge"], title: "合成视频", summary: "", revision: 1,
        occurredAt: { kind: "unknown" }, recordedAt: "2026-09-28T00:00:00Z", reportState: "queued", sourceUpdated: false,
        sourceReviewRequired: false, attachmentCount: 1, createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z" },
      source: { id: "source-1", recordId: "record-1", origin: "manual", sourceVersion: "clip-report-v1",
        contentHash: "a".repeat(64), text: "合成视频", recordedAt: "2026-09-28T00:00:00Z", createdAt: "2026-09-28T00:00:00Z" },
      attachments: [{ id: assetId, sha256: source.sha256, byteSize: source.byteSize, mimeType: source.mimeType,
        originalFileName: "synthetic.mp4", vaultFormat: 2, integrityStatus: "verified", availabilityStatus: "available", createdAt: "2026-09-28T00:00:00Z" }],
      overrides: []
    });
    expect(preview).not.toHaveBeenCalled();
    expect(result.state).toBe("partial"); expect(result.promptVersion).toBe("report-v3");
    expect(result.content.chronology[0]?.anchor).toBeUndefined();
    expect(result.content.mediaSegments).toHaveLength(4);
    expect(result.content.mediaSegments).toContainEqual(expect.objectContaining({
      description: "分段 AI 描述（需核对）：后段动作", anchor: { sourceVersion: "clip-report-v1", assetId,
        intervalMs: [10_100, 10_200], frameTimeMs: 10_150 }
    }));
  });

  it.each([false, true])("builds a temporary streamed media query without using raw M4A in consolidation (configuration change=%s)", async (changed) => {
    let active = true; let calls = 0;
    const source: NativeMediaSegmentInput = { kind: "audio", mimeType: "audio/mp4", byteSize: 8_000_000,
      sha256: "a".repeat(64), async open() { throw new Error("Injected native port only"); } };
    const nativeMediaSegments: NativeMediaSegmentPort = { async *segments() {
      for (let index = 0; index < 2; index++) yield { index, startMs: index * 10_000, endMs: (index + 1) * 10_000,
        sourceDurationMs: 20_000, mimeType: "audio/wav", bytes: Buffer.from("clip") };
    } };
    const adapter: AgentModelAdapterPort = { identity: "test.streamed-query", version: 1, async run(input) {
      calls++;
      const tool = input.tools[0]!.name;
      if (tool === "submit_media_segment_observations") {
        await input.executeTool(tool, { examinedSegmentId: /segment-\d+/.exec(input.user)![0], coverage: "complete",
          summary: calls === 1 ? "普通开头" : "后段的独特争议", observations: [], notes: [] }, "clip");
        if (changed) active = false;
      } else {
        expect(JSON.stringify(input.userContent)).toContain("后段的独特争议");
        expect((input.userContent as Array<{ type: string }>).every(({ type }) => type === "text")).toBe(true);
        await input.executeTool(tool, { descriptions: [{ id: "query-1", text: "后段的独特争议" }] }, "query");
      }
      return { model: input.model };
    } };
    const query = new BailianNativeMediaQueryAdapter(() => active ? { apiKey: "synthetic-key", region: "cn-beijing" } : undefined,
      adapter, nativeMediaSegments).describeStreamed([{ id: "query-1", source }]);
    if (changed) { await expect(query).rejects.toMatchObject({ code: "LLM_CONFIGURATION_CHANGED" }); expect(calls).toBe(1); }
    else { await expect(query).resolves.toEqual([{ id: "query-1", text: "后段的独特争议" }]); expect(calls).toBe(3); }
  });

  it.each(["audio", "video"] as const)("uses configured Bailian %s understanding without sending raw media or capability labels to MiniMax", async (kind) => {
    const context = createContext(); databases.push(context.database);
    configureSyntheticAuxiliary(context.application);
    const fixture = auxiliaryRouteFixture(kind);
    const result = await new AgentHarness(context.application, fixture).screen(fixture.screening);
    expect(result.decision).toBe("include");
    expect(fixture.calls.map(({ tool }) => tool)).toEqual([
      "submit_media_segment_observations", "submit_media_segment_observations", "submit_screening"
    ]);
    expect(fixture.closed).toHaveBeenCalledOnce();
    const settings = context.application.getLlmSettings();
    expect(settings.activeProvider).toBe("minimax");
    expect(settings.providers.bailian?.capabilities?.inputModalities).toContain(kind);
    expect(settings.providers.minimax?.capabilities?.inputModalities ?? []).not.toContain(kind);
  });

  it.each(["png", "jpeg", "missing converter", "partial", "key change", "late aggregate", "cancel"] as const)(
    "screens HEIC using a labelled private representation (%s)", async (mode) => {
      const bytes = Buffer.from("synthetic-HEIC-private-GPS-marker");
      const converted = Buffer.from("model-adapter-only-converted-image");
      const controller = new AbortController();
      const context = createContext(); databases.push(context.database);
      const configure = (key: string) => context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash",
        apiKey: key, region: "cn-beijing" }, "2026-09-28T00:00:00Z");
      configure("synthetic-image-key");
      const convert = vi.fn(async (input: { mimeType: string; bytes: Uint8Array }) => {
        expect(input.mimeType).toBe("image/heic"); expect(Buffer.from(input.bytes).equals(bytes)).toBe(true);
        if (mode === "partial") throw new AppError("MODALITY_UNAVAILABLE", "Synthetic unsupported HDR");
        if (mode === "key change") configure("different-image-key");
        if (mode === "cancel") controller.abort(new globalThis.DOMException("Synthetic cancellation", "AbortError"));
        return { bytes: converted, width: 96, height: 64, mimeType: mode === "jpeg" ? "image/jpeg" as const : "image/png" as const };
      });
      const run = vi.fn(async (input: Parameters<AgentModelAdapterPort["run"]>[0]) => {
        const payload = JSON.stringify(input.userContent);
        expect(payload).toContain("HEIC 本机转换副本");
        expect(payload).toContain(`data:image/${mode === "jpeg" ? "jpeg" : "png"};base64,${converted.toString("base64")}`);
        expect(payload).not.toContain(bytes.toString("base64"));
        await input.executeTool("submit_screening", { decision: "include", categories: ["rights"], reason: "合成图片相关",
          anchors: [{ sourceVersion: "image-v1", temporaryMediaRef: AUXILIARY_ASSET_ID }], coverage: "complete", policyVersion: "screening-v1" }, "image");
        if (mode === "late aggregate") configure("different-image-key");
        return { model: input.model };
      });
      const harness = new AgentHarness(context.application, { modelAdapter: { identity: "test.heic-screen", version: 1, run },
        ...(mode !== "missing converter" ? { nativeImageConversion: { convert } } : {}) });
      const pending = harness.screen({ text: "", origin: "manual", sourceVersion: "image-v1", media: [{
        id: AUXILIARY_ASSET_ID, fileName: "synthetic.heic", kind: "image", mimeType: "image/heic", byteSize: bytes.length,
        bytes, screenedSha256: createHash("sha256").update(bytes).digest("hex")
      }] }, controller.signal);
      if (mode === "png" || mode === "jpeg") await expect(pending).resolves.toMatchObject({ decision: "include", coverage: "complete" });
      else {
        await expect(pending).rejects.toMatchObject(mode === "cancel" ? { name: "AbortError" }
          : { code: mode === "key change" || mode === "late aggregate" ? "LLM_CONFIGURATION_CHANGED" : "MODALITY_UNAVAILABLE" });
        expect(context.application.getLlmSettings().providers.bailian?.capabilities?.inputModalities ?? []).not.toContain("image");
        if (mode !== "late aggregate") expect(run).not.toHaveBeenCalled();
      }
    }
  );

  it.each(["complete", "corrupt", "lock", "cancel"] as const)("protects HEIC preview and underlying source on %s", async (mode) => {
    const bytes = Buffer.from("synthetic-HEIC-preview-original"); const converted = Buffer.from("synthetic-converted-image");
    const controller = new AbortController(); let started!: () => void; let release!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const convert = vi.fn(async (_input: { mimeType: string; bytes: Uint8Array }, signal?: AbortSignal) => {
      started(); if (mode === "lock" || mode === "cancel") await gate;
      if (mode === "lock" || mode === "cancel") expect(signal?.aborted).toBe(true);
      return { bytes: converted, width: 96, height: 64, mimeType: "image/png" as const };
    });
    const context = createContext({ convert }); databases.push(context.database);
    context.manager.lock = async () => ({ status: "locked", workspaceId: context.session.workspace.id, workspaceName: context.session.workspace.name });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    context.session.assets.upsert({ id: AUXILIARY_ASSET_ID, mimeType: "image/heic", byteSize: bytes.length, sha256,
      originalFileName: "synthetic.heic", vaultFormat: 2, integrityStatus: "verified", availabilityStatus: "available", createdAt: "2026-09-28T00:00:00Z" });
    const stream = Readable.from(mode === "corrupt" ? Buffer.alloc(bytes.length) : bytes);
    vi.spyOn(context.session.vault, "open").mockResolvedValue(stream);
    const pending = context.application.previewAsset(AUXILIARY_ASSET_ID, controller.signal);
    if (mode === "lock" || mode === "cancel") {
      await began;
      if (mode === "lock") await context.application.lockWorkspace(); else controller.abort(new globalThis.DOMException("Synthetic preview cancel", "AbortError"));
      release();
      await expect(pending).rejects.toMatchObject(mode === "lock" ? { code: "SOURCE_UNAVAILABLE" } : { name: "AbortError" });
    } else if (mode === "corrupt") {
      await expect(pending).rejects.toMatchObject({ code: "ASSET_CORRUPT" }); expect(convert).not.toHaveBeenCalled();
    } else {
      const preview = await pending;
      expect(preview).toMatchObject({ mimeType: "image/png", representation: "converted-image", fileName: "synthetic.heic" });
      expect(Buffer.from(preview.bytes).equals(converted)).toBe(true);
      expect(context.session.assets.findById(AUXILIARY_ASSET_ID)?.sha256).toBe(sha256);
    }
    expect(stream.destroyed).toBe(true);
  });

  it("builds a report from the converted HEIC preview while retaining original attachment provenance", async () => {
    const bytes = Buffer.from("synthetic-HEIC-report-original"), converted = Buffer.from("synthetic-image-raster");
    const context = createContext({ convert: async () => ({ bytes: converted, width: 96, height: 64, mimeType: "image/png" }) });
    databases.push(context.database);
    context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash", apiKey: "synthetic-key", region: "cn-beijing" }, "2026-09-28T00:00:00Z");
    const source = { mimeType: "image/heic", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const input = syntheticAuxiliaryReport(source);
    context.session.assets.upsert(input.attachments[0]!);
    vi.spyOn(context.session.vault, "open").mockResolvedValue(Readable.from(bytes));
    const adapter: AgentModelAdapterPort = { identity: "test.heic-report", version: 1, async run(request) {
      expect(JSON.stringify(request.userContent)).toContain("HEIC 本机转换副本");
      expect(JSON.stringify(request.userContent)).not.toContain(bytes.toString("base64"));
      expect(JSON.stringify(request.userContent)).toContain(`data:image/png;base64,${converted.toString("base64")}`);
      await request.executeTool("submit_report", { summary: "合成图像报告", time: { source: "ai" }, location: { source: "ai" }, people: [],
        chronology: [], mediaSegments: [{ description: "转换图片中的合成内容", attachmentRef: AUXILIARY_ASSET_ID }],
        examinedAttachmentIds: [AUXILIARY_ASSET_ID], unknowns: [], disputes: [], suggestions: [], legalIssues: [], coverageNotes: [], state: "complete" }, "report");
      return { model: request.model };
    } };
    const report = await new AgentHarness(context.application, { modelAdapter: adapter }).analyze(input);
    expect(report.state).toBe("complete");
    expect(report.content.mediaSegments?.[0]?.anchor.assetId).toBe(AUXILIARY_ASSET_ID);
    expect(context.session.assets.findById(AUXILIARY_ASSET_ID)).toMatchObject(source);
  });

  it("rejects an oversized HEIC preview before opening the encrypted source", async () => {
    const convert = vi.fn(); const context = createContext({ convert }); databases.push(context.database);
    context.session.assets.upsert({ id: AUXILIARY_ASSET_ID, mimeType: "image/heic", byteSize: 20 * 1024 * 1024 + 1, sha256: "f".repeat(64),
      originalFileName: "synthetic-oversized.heic", vaultFormat: 2, integrityStatus: "verified", availabilityStatus: "available", createdAt: "2026-09-28T00:00:00Z" });
    const open = vi.spyOn(context.session.vault, "open");
    await expect(context.application.previewAsset(AUXILIARY_ASSET_ID)).rejects.toMatchObject({ code: "ASSET_PREVIEW_UNAVAILABLE" });
    expect(open).not.toHaveBeenCalled(); expect(convert).not.toHaveBeenCalled();
  });

  it.each(["audio", "video"] as const)("builds a complete MiniMax report using only configured Bailian %s descriptions", async (kind) => {
    const context = createContext(); databases.push(context.database);
    configureSyntheticAuxiliary(context.application);
    const fixture = auxiliaryRouteFixture(kind);
    vi.spyOn(context.application, "openMediaSourceForAnalysis").mockResolvedValue(fixture.source);
    const preview = vi.spyOn(context.application, "previewAsset").mockRejectedValue(new Error("Must not buffer/send raw media"));
    const result = await new AgentHarness(context.application, fixture).analyze(syntheticAuxiliaryReport(fixture.source));
    expect(result.state).toBe("complete");
    expect(result.modelProfile).toBe("minimax:MiniMax-M3+media=bailian:qwen3.8-omni-flash");
    expect(result.content.mediaSegments).toContainEqual(expect.objectContaining({
      description: "分段 AI 描述（需核对）：后段合成争议", anchor: {
        sourceVersion: "auxiliary-v1", assetId: AUXILIARY_ASSET_ID, intervalMs: [10_000, 20_000]
      }
    }));
    expect(preview).not.toHaveBeenCalled();
    expect(fixture.calls.map(({ tool }) => tool)).toEqual([
      "submit_media_segment_observations", "submit_media_segment_observations", "submit_report"
    ]);
  });

  it.each(["missing", "needs attention", "wrong model", "missing region"] as const)(
    "never reads an unavailable auxiliary credential or sends raw media when configuration is %s", async (mode) => {
      const context = createContext(); databases.push(context.database);
      configureSyntheticAuxiliary(context.application, mode !== "missing");
      if (mode === "needs attention") context.application.markLlmProviderNeedsAttention("bailian");
      if (mode === "wrong model" || mode === "missing region") {
        const config = context.application.getLlmSettings().providers.bailian!;
        const { region: _region, ...withoutRegion } = config;
        void _region;
        context.session.agents.saveLlmProviderConfig(mode === "wrong model" ? { ...config, model: "qwen3.7-plus" } : withoutRegion, "2026-09-28T00:00:00Z");
      }
      const fixture = auxiliaryRouteFixture("audio");
      const credential = vi.spyOn(context.application, "getLlmCredential");
      const harness = new AgentHarness(context.application, fixture);
      await expect(harness.screen(fixture.screening)).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
      expect(fixture.calls).toEqual([]);
      const report = await harness.analyze(syntheticAuxiliaryReport(fixture.source));
      expect(report.state).toBe("partial");
      expect(fixture.calls.map(({ tool }) => tool)).toEqual(["submit_report"]);
      expect(credential.mock.calls.some(([provider]) => provider === "bailian")).toBe(false);
      expect(context.application.getLlmSettings().activeProvider).toBe("minimax");
    }
  );

  it.each(["screen", "report"] as const)("rejects incomplete auxiliary media understanding during %s", async (task) => {
    const context = createContext(); databases.push(context.database);
    configureSyntheticAuxiliary(context.application);
    const fixture = auxiliaryRouteFixture("audio", { partial: true });
    vi.spyOn(context.application, "openMediaSourceForAnalysis").mockResolvedValue(fixture.source);
    const harness = new AgentHarness(context.application, fixture);
    if (task === "screen") await expect(harness.screen(fixture.screening)).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
    else expect((await harness.analyze(syntheticAuxiliaryReport(fixture.source))).state).toBe("partial");
    expect(fixture.calls.filter(({ tool }) => tool === "submit_media_segment_observations")).toHaveLength(1);
    expect(fixture.calls.some(({ tool }) => tool === "submit_screening")).toBe(false);
    expect(fixture.closed).toHaveBeenCalledOnce();
  });

  it.each(["screen", "report"] as const)("does not send small native media directly to MiniMax without a private native port during %s", async (task) => {
    const context = createContext(); databases.push(context.database);
    configureSyntheticAuxiliary(context.application);
    const fixture = auxiliaryRouteFixture("audio");
    const harness = new AgentHarness(context.application, { modelAdapter: fixture.modelAdapter });
    if (task === "screen") await expect(harness.screen(fixture.screening)).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
    else expect((await harness.analyze(syntheticAuxiliaryReport(fixture.source))).state).toBe("partial");
    expect(fixture.calls.every(({ tool }) => tool === "submit_report")).toBe(true);
  });

  for (const task of ["screen", "report"] as const) {
    it.each(["cancel", "auxiliary disconnect", "main key change", "pause and resume", "late aggregate"] as const)(
      `invalidates composed ${task} results on %s`, async (mode) => {
        const context = createContext(); databases.push(context.database);
        configureSyntheticAuxiliary(context.application);
        const controller = new AbortController();
        const invalidate = () => {
          if (mode === "cancel") controller.abort(new globalThis.DOMException("Synthetic cancellation", "AbortError"));
          if (mode === "auxiliary disconnect" || mode === "late aggregate") context.application.disconnectLlmProvider("bailian");
          if (mode === "main key change") context.application.saveLlmConnection({
            provider: "minimax", model: "MiniMax-M3", apiKey: "different-synthetic-main-key"
          }, "2026-09-28T00:00:00Z");
          if (mode === "pause and resume") {
            context.application.pauseLlmProviders();
            context.application.activateLlmProvider("minimax", "2026-09-28T00:00:00Z");
          }
        };
        const fixture = auxiliaryRouteFixture("audio", mode === "late aggregate"
          ? { afterAggregate: invalidate } : { afterClip: invalidate });
        vi.spyOn(context.application, "openMediaSourceForAnalysis").mockResolvedValue(fixture.source);
        const harness = new AgentHarness(context.application, fixture);
        const pending = task === "screen" ? harness.screen(fixture.screening, controller.signal)
          : harness.analyze(syntheticAuxiliaryReport(fixture.source), controller.signal);
        await expect(pending).rejects.toMatchObject(mode === "cancel" ? { name: "AbortError" } : { code: "LLM_CONFIGURATION_CHANGED" });
        expect(fixture.calls).toHaveLength(mode === "late aggregate" ? 3 : 1);
        expect(fixture.closed).toHaveBeenCalledOnce();
        expect(context.application.getLlmSettings().providers.minimax?.capabilities?.inputModalities ?? []).not.toContain("audio");
      }
    );
  }

  it.each(["complete", "lock", "cancel"] as const)("opens the model-only media source lazily and destroys its stream on %s", async (mode) => {
    const context = createContext(); databases.push(context.database);
    const id = "00000000-0000-4000-8000-000000000023";
    context.session.assets.upsert({ id, sha256: "a".repeat(64), byteSize: 4, mimeType: "audio/wav",
      originalFileName: "synthetic.wav", vaultFormat: 2, integrityStatus: "verified", availabilityStatus: "available",
      createdAt: "2026-09-28T00:00:00Z" });
    const stream = Readable.from([Buffer.from("ab"), Buffer.from("cd")]);
    const open = vi.spyOn(context.session.vault, "open").mockResolvedValue(stream);
    const source = await context.application.openMediaSourceForAnalysis(id);
    const controller = new AbortController();
    const input = await source.open(controller.signal); expect(open).not.toHaveBeenCalled();
    const iterator = input[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: Buffer.from("ab"), done: false });
    expect(open).toHaveBeenCalledWith("a".repeat(64), context.session.key);
    if (mode === "lock") vi.spyOn(context.manager, "current").mockReturnValue(undefined);
    if (mode === "cancel") controller.abort(new AppError("SOURCE_UNAVAILABLE", "synthetic cancellation"));
    if (mode === "complete") {
      expect(await iterator.next()).toMatchObject({ value: Buffer.from("cd"), done: false });
      expect(await iterator.next()).toMatchObject({ done: true });
    } else await expect(iterator.next()).rejects.toMatchObject({ code: mode === "lock" ? "WORKSPACE_LOCKED" : "SOURCE_UNAVAILABLE" });
    expect(stream.destroyed).toBe(true);
  });

  it("stops reading a changed media file before loading an oversized replacement", async () => {
    const context = createContext();
    databases.push(context.database);
    context.application.saveLlmConnection({
      provider: "bailian", model: "qwen3.8-omni-flash", apiKey: "test-key", region: "cn-beijing"
    }, "2026-09-21T00:00:00.000Z");
    let modelCalls = 0;
    const adapter: AgentModelAdapterPort = {
      identity: "fake.never-called", version: 1,
      async run() { modelCalls += 1; return { model: "unexpected" }; }
    };
    const audioPath = join(tmpdir(), `grudge-vault-changed-${process.pid}-${Date.now()}.mp3`);
    await writeFile(audioPath, Buffer.alloc(8 * 1024 * 1024, 7));
    try {
      await expect(new AgentHarness(context.application, { modelAdapter: adapter }).screen({
        text: "", origin: "manual", sourceVersion: "v1",
        media: [{ id: "audio-1", path: audioPath, fileName: "call.mp3",
          mimeType: "audio/mpeg", byteSize: 3, kind: "audio",
          screenedSha256: createHash("sha256").update(Buffer.from([1, 2, 3])).digest("hex") }]
      })).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
      expect(modelCalls).toBe(0);
    } finally {
      await rm(audioPath, { force: true });
    }
  });

  it.each(["json", "sse"] as const)("ends valid %s screening after its single structured submission", async (format) => {
    const context = createContext(); databases.push(context.database);
    context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash", region: "cn-beijing",
      apiKey: "synthetic-key" }, "2026-10-01T00:00:00Z");
    const value = { decision: "skip", categories: [], reason: "普通日常", anchors: [], coverage: "complete", policyVersion: "screening-v1" };
    let calls = 0;
    const modelAdapter = new OpenAiCompatibleChatAdapter((async () => {
      calls += 1;
      const tool = { id: "synthetic-submission", type: "function", function: { name: "submit_screening", arguments: JSON.stringify(value) } };
      return format === "json" ? jsonResponse({ choices: [{ message: { role: "assistant", content: null, tool_calls: [tool] } }],
        usage: { prompt_tokens: 9, completion_tokens: 4 } }) : eventStreamResponse([
        { model: "synthetic-model", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...tool }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } }
      ]);
    }) as typeof globalThis.fetch);
    const usage: ModelUsageEvent[] = [];
    await expect(new AgentHarness(context.application, { modelAdapter }).screen({ text: "午饭后散步", media: [],
      origin: "manual", sourceVersion: "synthetic-source" }, undefined, undefined, (value) => usage.push(value)))
      .resolves.toMatchObject({ decision: "skip" });
    expect(calls).toBe(1);
    expect(usage).toEqual([{ kind: "request-started" }, { kind: "response-received", promptTokens: 9, completionTokens: 4 }]);
  });

  it.each(["parallel", "unknown"] as const)("rejects %s structured calls before executing any submission", async (mode) => {
    const tool = createDefaultAgentToolRegistry().definitions("retrieve").find(({ name }) => name === "search_events")!;
    const call = (name: string) => ({ id: "synthetic-call", type: "function", function: { name, arguments: "{}" } });
    const executeTool = vi.fn(async () => ({})); let requests = 0;
    const adapter = new OpenAiCompatibleChatAdapter((async () => {
      requests += 1;
      return jsonResponse({ choices: [{ message: { role: "assistant", content: null,
        tool_calls: mode === "parallel" ? [call(tool.name), call(tool.name)] : [call("unknown_tool")] } }] });
    }) as typeof globalThis.fetch);
    await expect(adapter.run({ baseUrl: "https://model.example/v1", model: "synthetic", system: "synthetic", user: "synthetic",
      tools: [tool], structuredOutputOnly: true, executeTool })).rejects.toMatchObject({ code: "AGENT_TOOL_FAILED" });
    expect(executeTool).not.toHaveBeenCalled(); expect(requests).toBe(1);
  });

  it.each([
    ["qwen3.8-omni-flash", true], ["qwen3.8-omni-flash", false], ["MiniMax-M3", true], ["MiniMax-M3", false]
  ] as const)("selects the named submission only for Qwen Omni structured mode (%s, %s)", async (model, structuredOutputOnly) => {
    const schema = z.object({ accepted: z.boolean() });
    const tool: RegisteredAgentTool = { name: "submit_synthetic", version: 1, description: "Synthetic submission", intents: ["record"],
      write: false, schema, jsonSchema: z.toJSONSchema(schema) };
    let body: Record<string, unknown> | undefined;
    const adapter = new OpenAiCompatibleChatAdapter((async (_url, options) => {
      body = JSON.parse(String(options?.body));
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "Synthetic response" } }] });
    }) as typeof globalThis.fetch);
    await adapter.run({ baseUrl: "https://model.example/v1", model, system: "Synthetic", user: "Synthetic",
      tools: [tool], structuredOutputOnly, executeTool: async () => ({}) });
    expect(body?.tool_choice).toEqual(model === "qwen3.8-omni-flash" && structuredOutputOnly
      ? { type: "function", function: { name: "submit_synthetic" } } : "auto");
  });

  it.each(["missing", "foreign-media", "foreign-source", "text-range", "reversed-interval"] as const)(
    "repairs %s screening evidence before accepting complete media coverage", async (mode) => {
      const context = createContext(); databases.push(context.database);
      context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash", region: "cn-beijing",
        apiKey: "synthetic-key" }, "2026-10-01T00:00:00Z");
      const anchor = { sourceVersion: "synthetic-v1", temporaryMediaRef: "synthetic-image" };
      let calls = 0;
      const modelAdapter: AgentModelAdapterPort = { identity: "synthetic.anchor-repair", version: 1, async run(input) {
        calls += 1;
        expect(input.system).toContain("mediaNumber");
        const invalid = mode === "missing" ? [] : mode === "foreign-media" ? [{ ...anchor, temporaryMediaRef: "outside-input" }]
          : mode === "foreign-source" ? [{ ...anchor, sourceVersion: "another-version" }]
            : mode === "text-range" ? [{ ...anchor, textRange: [0, 200] }] : [{ ...anchor, intervalMs: [500, 100] }];
        await input.executeTool("submit_screening", { decision: "include", categories: ["danger"], reason: "合成图片里的威胁",
          anchors: calls === 1 ? invalid : [anchor], coverage: "complete", policyVersion: "screening-v1" }, "synthetic-call");
        return { model: input.model };
      } };
      await expect(new AgentHarness(context.application, { modelAdapter }).screen({ text: "正常回家", origin: "manual", sourceVersion: "synthetic-v1",
        media: [{ id: "synthetic-image", kind: "image", fileName: "synthetic.png", mimeType: "image/png", byteSize: 1, bytes: Buffer.from([1]) }]
      })).resolves.toMatchObject({ coverage: "complete", anchors: [anchor] });
      expect(calls).toBe(2);
    });

  it("does not accept or verify media coverage still missing after one format repair", async () => {
    const context = createContext(); databases.push(context.database);
    context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash", region: "cn-beijing",
      apiKey: "synthetic-key" }, "2026-10-01T00:00:00Z");
    const verify = vi.spyOn(context.application, "markLlmModalityVerified"); let calls = 0;
    const modelAdapter: AgentModelAdapterPort = { identity: "synthetic.missing-coverage", version: 1, async run(input) {
      calls += 1;
      await input.executeTool("submit_screening", { decision: "include", categories: ["danger"], reason: "合成风险",
        anchors: [], coverage: "complete", policyVersion: "screening-v1" }, "synthetic-call");
      return { model: input.model };
    } };
    await expect(new AgentHarness(context.application, { modelAdapter }).screen({ text: "", origin: "manual", sourceVersion: "synthetic-v1",
      media: [{ id: "synthetic-image", kind: "image", fileName: "synthetic.png", mimeType: "image/png", byteSize: 1, bytes: Buffer.from([1]) }]
    })).rejects.toMatchObject({ code: "SCREENING_FAILED" });
    expect(calls).toBe(2); expect(verify).not.toHaveBeenCalled();
  });

  it("retains a partial review without inventing media anchors or verifying complete coverage", async () => {
    const context = createContext(); databases.push(context.database);
    context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash", region: "cn-beijing",
      apiKey: "synthetic-key" }, "2026-10-01T00:00:00Z");
    const verify = vi.spyOn(context.application, "markLlmModalityVerified");
    const modelAdapter: AgentModelAdapterPort = { identity: "synthetic.partial-review", version: 1, async run(input) {
      await input.executeTool("submit_screening", { decision: "review", categories: [], reason: "合成媒体无法完整检查",
        anchors: [], coverage: "partial", policyVersion: "screening-v1" }, "synthetic-call");
      return { model: input.model };
    } };
    await expect(new AgentHarness(context.application, { modelAdapter }).screen({ text: "", origin: "manual", sourceVersion: "synthetic-v1",
      media: [{ id: "synthetic-image", kind: "image", fileName: "synthetic.png", mimeType: "image/png", byteSize: 1, bytes: Buffer.from([1]) }]
    })).resolves.toMatchObject({ decision: "review", coverage: "partial", anchors: [] });
    expect(verify).not.toHaveBeenCalled();
  });

  it("binds numbered media anchors to local provenance without asking the model to copy long identifiers", async () => {
    const context = createContext(); databases.push(context.database);
    context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash", region: "cn-beijing",
      apiKey: "synthetic-key" }, "2026-10-01T00:00:00Z");
    const modelAdapter: AgentModelAdapterPort = { identity: "synthetic.numbered-anchors", version: 1, async run(input) {
      expect(input.user).toContain("mediaNumber=1,first-media"); expect(input.user).toContain("mediaNumber=2,second-media");
      const definition = input.tools[0]!.jsonSchema as { properties: { anchors: { items: { required?: string[] } } } };
      expect(definition.properties.anchors.items.required ?? []).not.toContain("sourceVersion");
      expect(definition.properties.anchors.items.required ?? []).not.toContain("temporaryMediaRef");
      await input.executeTool("submit_screening", { decision: "include", categories: ["danger"], reason: "合成风险",
        anchors: [{ mediaNumber: 2, intervalMs: [100, 200] }, { mediaNumber: 1 }], coverage: "complete", policyVersion: "screening-v1" }, "synthetic-call");
      return { model: input.model };
    } };
    await expect(new AgentHarness(context.application, { modelAdapter }).screen({ text: "", origin: "manual", sourceVersion: "synthetic-source-v1",
      media: ["first-media", "second-media"].map((id) => ({ id, kind: "audio" as const, fileName: "synthetic.wav", mimeType: "audio/wav",
        byteSize: 1, bytes: Buffer.from([1]) }))
    })).resolves.toMatchObject({ anchors: [{ sourceVersion: "synthetic-source-v1", temporaryMediaRef: "second-media", intervalMs: [100, 200] },
      { sourceVersion: "synthetic-source-v1", temporaryMediaRef: "first-media" }] });
  });

  it.each(["out-of-range", "conflicting-reference", "foreign-version"] as const)("rejects %s numbered media evidence without substituting another source", async (mode) => {
    const context = createContext(); databases.push(context.database);
    context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash", region: "cn-beijing",
      apiKey: "synthetic-key" }, "2026-10-01T00:00:00Z");
    let calls = 0;
    const modelAdapter: AgentModelAdapterPort = { identity: "synthetic.invalid-numbered-anchors", version: 1, async run(input) {
      calls += 1;
      const invalid = mode === "out-of-range" ? { mediaNumber: 3 }
        : mode === "conflicting-reference" ? { mediaNumber: 1, temporaryMediaRef: "second-media" }
          : { mediaNumber: 1, sourceVersion: "foreign-source-v1" };
      await input.executeTool("submit_screening", { decision: "include", categories: ["danger"], reason: "合成风险",
        anchors: [invalid, { mediaNumber: 2 }], coverage: "complete", policyVersion: "screening-v1" }, "synthetic-call");
      return { model: input.model };
    } };
    await expect(new AgentHarness(context.application, { modelAdapter }).screen({ text: "", origin: "manual", sourceVersion: "synthetic-source-v1",
      media: ["first-media", "second-media"].map((id) => ({ id, kind: "audio" as const, fileName: "synthetic.wav", mimeType: "audio/wav",
        byteSize: 1, bytes: Buffer.from([1]) }))
    })).rejects.toMatchObject({ code: "SCREENING_FAILED" });
    expect(calls).toBe(2);
  });

  it("keeps numbered provenance bound to the original invocation when the caller changes its draft", async () => {
    const context = createContext(); databases.push(context.database);
    context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash", region: "cn-beijing",
      apiKey: "synthetic-key" }, "2026-10-01T00:00:00Z");
    const draft = { text: "", origin: "manual" as const, sourceVersion: "original-synthetic-v1",
      media: [{ id: "original-synthetic-media", kind: "audio" as const, fileName: "synthetic.wav", mimeType: "audio/wav",
        byteSize: 1, bytes: Buffer.from([1]) }] };
    const modelAdapter: AgentModelAdapterPort = { identity: "synthetic.provenance-snapshot", version: 1, async run(input) {
      expect(input.user).toContain("sourceVersion=original-synthetic-v1");
      draft.sourceVersion = "another-synthetic-v2"; draft.media[0]!.id = "another-synthetic-media";
      draft.media.push({ ...draft.media[0]! });
      await input.executeTool("submit_screening", { decision: "include", categories: ["danger"], reason: "合成风险",
        anchors: [{ mediaNumber: 1 }], coverage: "complete", policyVersion: "screening-v1" }, "synthetic-call");
      return { model: input.model };
    } };
    await expect(new AgentHarness(context.application, { modelAdapter }).screen(draft)).resolves.toMatchObject({
      anchors: [{ sourceVersion: "original-synthetic-v1", temporaryMediaRef: "original-synthetic-media" }]
    });
  });

  it.each(["write", "multiple", "none"] as const)("rejects %s tool configuration before a single-submission request", async (mode) => {
    const tool = createDefaultAgentToolRegistry().definitions("retrieve").find(({ name }) => name === "search_events")!;
    const fetcher = vi.fn(async () => jsonResponse({}));
    await expect(new OpenAiCompatibleChatAdapter(fetcher as typeof globalThis.fetch).run({
      baseUrl: "https://model.example/v1", model: "synthetic", system: "synthetic", user: "synthetic",
      tools: mode === "none" ? [] : mode === "write" ? [{ ...tool, write: true }] : [tool, tool],
      structuredOutputOnly: true, executeTool: async () => ({})
    })).rejects.toMatchObject({ code: "AGENT_TOOL_FAILED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not accept a single submission cancelled during its validation", async () => {
    const tool = createDefaultAgentToolRegistry().definitions("retrieve").find(({ name }) => name === "search_events")!;
    const controller = new AbortController(), cancelled = new globalThis.DOMException("synthetic cancellation", "AbortError");
    const adapter = new OpenAiCompatibleChatAdapter((async () => jsonResponse({ choices: [{ message: { role: "assistant", content: null,
      tool_calls: [{ id: "synthetic-call", type: "function", function: { name: tool.name, arguments: "{}" } }] } }] })) as typeof globalThis.fetch);
    await expect(adapter.run({ baseUrl: "https://model.example/v1", model: "synthetic", system: "synthetic", user: "synthetic",
      tools: [tool], structuredOutputOnly: true, signal: controller.signal, executeTool: async () => { controller.abort(cancelled); return {}; }
    })).rejects.toBe(cancelled);
  });

  it.each(["image", "audio", "video"] as const)("retains source metadata in the actual %s screening message", async (kind) => {
    const context = createContext(); databases.push(context.database);
    context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash", region: "cn-beijing",
      apiKey: "synthetic-key" }, "2026-10-01T00:00:00Z");
    const bytes = Buffer.from("synthetic-bytes");
    const sourceVersion = `synthetic-${kind}-version`, id = `synthetic-${kind}-id`;
    let calls = 0;
    const modelAdapter = new OpenAiCompatibleChatAdapter((async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      if (calls === 1) {
        const content = body.messages[1].content as Array<{ type: string; text?: string }>;
        const text = content.filter(({ type }) => type === "text").map(({ text }) => text).join("\n");
        expect(text).toContain(`sourceVersion=${sourceVersion}`); expect(text).toContain("origin=zip");
        expect(text).toContain(`${id}:synthetic.${kind}`); expect(text).toContain("普通正文，风险只在媒体中");
        return jsonResponse({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{
          id: "synthetic-submit", type: "function", function: { name: "submit_screening", arguments: JSON.stringify({
            decision: "include", categories: ["danger"], reason: "媒体中风险", anchors: [{ sourceVersion, temporaryMediaRef: id }],
            coverage: "complete", policyVersion: "screening-v1"
          }) }
        }] } }] });
      }
      return jsonResponse({ choices: [{ message: { role: "assistant", content: null } }] });
    }) as typeof globalThis.fetch);
    await expect(new AgentHarness(context.application, { modelAdapter }).screen({ text: "普通正文，风险只在媒体中", origin: "zip", sourceVersion,
      media: [{ id, fileName: `synthetic.${kind}`, kind, byteSize: bytes.length, bytes,
        mimeType: kind === "image" ? "image/png" : kind === "audio" ? "audio/wav" : "video/mp4" }]
    })).resolves.toMatchObject({ decision: "include", anchors: [{ sourceVersion, temporaryMediaRef: id }] });
  });

  it("includes invalid structured attempts and every repaired tool round in volatile screening usage", async () => {
    const context = createContext(); databases.push(context.database);
    context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash", region: "cn-beijing",
      apiKey: "synthetic-usage-key" }, "2026-09-29T00:00:00Z");
    const result = (valid: boolean) => ({ decision: "skip", categories: valid ? [] : ["invalid"], reason: "合成普通日常",
      anchors: [], coverage: "complete", policyVersion: "screening-v1" });
    const response = (value: unknown, prompt_tokens: number, completion_tokens: number) => jsonResponse({
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "synthetic-usage-call", type: "function",
        function: { name: "submit_screening", arguments: JSON.stringify(value) } }] } }], usage: { prompt_tokens, completion_tokens }
    });
    const responses = [response(result(false), 10, 3), response(result(true), 4, 2)];
    const bodies: Array<Record<string, unknown>> = []; const events: ModelUsageEvent[] = [];
    const modelAdapter = new OpenAiCompatibleChatAdapter((async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body))); return responses.shift()!;
    }) as typeof globalThis.fetch);
    expect(await new AgentHarness(context.application, { modelAdapter }).screen({ text: "合成普通日常", media: [],
      origin: "zip", sourceVersion: "synthetic-usage" }, undefined, undefined, (event) => events.push(event))).toMatchObject({ decision: "skip" });
    expect(events).toEqual([{ kind: "request-started" }, { kind: "response-received", promptTokens: 10, completionTokens: 3 },
      { kind: "request-started" }, { kind: "response-received", promptTokens: 4, completionTokens: 2 }]);
    expect(bodies).toHaveLength(2); expect(bodies.every((body) => Boolean((body.stream_options as { include_usage?: boolean })?.include_usage))).toBe(true);
  });

  it.each(["audio", "video"] as const)("routes usage observers through every %s auxiliary segment and the main screening call", async (kind) => {
    const fixture = auxiliaryRouteFixture(kind); const context = createContext(); databases.push(context.database);
    configureSyntheticAuxiliary(context.application); const events: ModelUsageEvent[] = [];
    const observe = (event: ModelUsageEvent) => events.push(event); const requestedUsage: boolean[] = [];
    const modelAdapter: AgentModelAdapterPort = { identity: "synthetic.auxiliary-usage", version: 1, async run(input) {
      expect(input.onUsage).toBe(observe); requestedUsage.push(Boolean(input.includeUsage)); input.onUsage?.({ kind: "request-started" });
      const result = await fixture.modelAdapter.run(input);
      input.onUsage?.({ kind: "response-received", promptTokens: 10, completionTokens: 3 }); return result;
    } };
    expect(await new AgentHarness(context.application, { modelAdapter, nativeMediaSegments: fixture.nativeMediaSegments })
      .screen(fixture.screening, undefined, undefined, observe)).toMatchObject({ decision: "include" });
    expect(requestedUsage).toEqual([true, true, false]); expect(events.filter(({ kind }) => kind === "request-started")).toHaveLength(3);
    expect(events.filter(({ kind }) => kind === "response-received")).toHaveLength(3);
  });

  it("gives text-only screening exact Unicode bounds and actionable repair fields without relaxing provenance", async () => {
    const context = createContext(); databases.push(context.database);
    context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash", region: "cn-beijing",
      apiKey: "synthetic-key" }, "2026-10-01T00:00:00Z");
    const text = "公司拖欠😀奖金", length = Array.from(text).length;
    const systems: string[] = [];
    const modelAdapter: AgentModelAdapterPort = { identity: "synthetic.text-bounds", version: 1, async run(input) {
      systems.push(input.system);
      expect(input.system).toContain(`本次正文共 ${length} 个 Unicode 码点`);
      expect(input.system).toContain("可以返回 anchors=[]");
      expect(JSON.stringify(input.tools[0]!.jsonSchema)).toContain(`"maximum":${length}`);
      await input.executeTool("submit_screening", { decision: "include", categories: ["rights"], reason: "本人奖金未支付",
        anchors: systems.length === 1 ? [{ textRange: [0, 999] }] : [{ textRange: [0, length] }],
        coverage: "complete", policyVersion: "screening-v1" }, "synthetic-call");
      return { model: "synthetic-text-bounds" };
    } };
    const result = await new AgentHarness(context.application, { modelAdapter }).screen({ text, media: [], origin: "zip", sourceVersion: "synthetic-bound-source" });
    expect(systems).toHaveLength(2);
    expect(systems[1]).toContain("anchors.0.textRange.1（too_big）");
    expect(systems[1]).not.toContain("999");
    expect(result.anchors).toEqual([{ sourceVersion: "synthetic-bound-source", textRange: [0, length] }]);
  });

  it("allows exactly one schema-only repair for an invalid structured result", async () => {
    const context = createContext();
    databases.push(context.database);
    context.application.saveLlmConnection({
      provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-key"
    }, "2026-09-20T00:00:00.000Z");
    const systems: string[] = [];
    const adapter: AgentModelAdapterPort = {
      identity: "fake.structured-repair", version: 1,
      async run(input) {
        systems.push(input.system);
        await input.executeTool("submit_screening", systems.length === 1 ? {
          decision: "include", categories: ["not-a-category"], reason: "格式错误",
          anchors: [], coverage: "complete", policyVersion: "screening-v1"
        } : {
          decision: "include", categories: ["rights"], reason: "涉及奖金权益",
          anchors: [], coverage: "complete", policyVersion: "screening-v1"
        }, `repair-${systems.length}`);
        return { text: "submitted", model: input.model };
      }
    };
    const result = await new AgentHarness(context.application, { modelAdapter: adapter }).screen({
      text: "公司拖欠奖金", media: [], origin: "manual", sourceVersion: "repair-source"
    });
    expect(result).toMatchObject({ decision: "include", categories: ["rights"] });
    expect(systems).toHaveLength(2);
    expect(systems[1]).toContain("仅按工具 schema 修复格式");
  });

  it("rejects a late screening tool result after the input is cancelled", async () => {
    const context = createContext();
    databases.push(context.database);
    context.application.saveLlmConnection({
      provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-key"
    }, "2026-09-20T00:00:00.000Z");
    const controller = new AbortController();
    const cancelled = new globalThis.DOMException("screening cancelled", "AbortError");
    let modelStarted!: () => void;
    const started = new Promise<void>((resolve) => { modelStarted = resolve; });
    let releaseModel!: () => void;
    const hold = new Promise<void>((resolve) => { releaseModel = resolve; });
    let calls = 0;
    const adapter: AgentModelAdapterPort = {
      identity: "fake.cancelled-screening", version: 1,
      async run(input) {
        calls += 1;
        expect(input.signal).toBe(controller.signal);
        modelStarted();
        await hold;
        await expect(input.executeTool("submit_screening", {
          decision: "include", categories: ["rights"], reason: "迟到的模型结论",
          anchors: [], coverage: "complete", policyVersion: "screening-v1"
        }, "late-screening")).rejects.toBe(cancelled);
        return { model: input.model };
      }
    };
    const pending = new AgentHarness(context.application, { modelAdapter: adapter }).screen({
      text: "合成薪酬争议", media: [], origin: "manual", sourceVersion: "cancelled-screening"
    }, controller.signal);
    await started;
    controller.abort(cancelled);
    releaseModel();
    await expect(pending).rejects.toBe(cancelled);
    expect(calls).toBe(1);
  });

  it("stops after the single structured-result repair fails", async () => {
    const context = createContext();
    databases.push(context.database);
    context.application.saveLlmConnection({
      provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-key"
    }, "2026-09-20T00:00:00.000Z");
    let calls = 0;
    const adapter: AgentModelAdapterPort = {
      identity: "fake.invalid-structured", version: 1,
      async run(input) {
        calls += 1;
        await input.executeTool("submit_screening", { decision: "include" }, `invalid-${calls}`);
        return { text: "submitted", model: input.model };
      }
    };
    await expect(new AgentHarness(context.application, { modelAdapter: adapter }).screen({
      text: "公司拖欠奖金", media: [], origin: "manual", sourceVersion: "invalid-source"
    })).rejects.toMatchObject({ code: "SCREENING_FAILED", retryable: true });
    expect(calls).toBe(2);
  });

  it("loads complete provider catalogs and conservatively classifies NVIDIA models", async () => {
    const context = createContext();
    databases.push(context.database);
    const nvidiaCatalog = Array.from({ length: 40 }, (_, index) => ({ id: `vendor/chat-${index}` }));
    nvidiaCatalog.push({ id: "nvidia/llama-nv-embedqa-1b-v2" }, { id: "vendor/vision-vl-model" });
    const adapter: AgentModelAdapterPort = {
      identity: "fake.catalog", version: 1,
      async run(input) { return { model: input.model }; },
      async listModels() { return nvidiaCatalog; }
    };
    const models = await new AgentHarness(context.application, { modelAdapter: adapter })
      .listLlmModels({ provider: "nvidia", apiKey: "secret" });
    expect(models).toHaveLength(43);
    expect(models.find(({ id }) => id === "vendor/chat-39")).toMatchObject({
      inputModalities: ["unknown"], outputModalities: ["unknown"], compatibility: "unknown", modalitySource: "unknown"
    });
    expect(models.find(({ id }) => id === "vendor/vision-vl-model")).toMatchObject({
      inputModalities: ["text", "image"], outputModalities: ["text"], compatibility: "unknown"
    });
    expect(models.find(({ id }) => id === "nvidia/llama-nv-embedqa-1b-v2")).toMatchObject({
      outputModalities: ["embedding"], compatibility: "incompatible", compatibilityReason: "non_chat_model"
    });
  });

  it("parses OpenRouter architecture metadata without server filtering or local truncation", async () => {
    const requests: string[] = [];
    const catalog = Array.from({ length: 12 }, (_, index) => ({
      id: `provider/model-${index}`, name: `Model ${index}`,
      supported_parameters: index === 11 ? ["temperature"] : ["tools"],
      architecture: { input_modalities: index === 10 ? ["text", "image"] : ["text"], output_modalities: ["text"] }
    }));
    const adapter = new OpenAiCompatibleChatAdapter((async (input) => {
      requests.push(String(input)); return jsonResponse({ data: catalog });
    }) as typeof globalThis.fetch);
    const items = await adapter.listModels({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "secret" });
    expect(requests).toEqual(["https://openrouter.ai/api/v1/models"]);
    expect(items).toHaveLength(12);
    expect(items[10]).toMatchObject({ inputModalities: ["text", "image"], outputModalities: ["text"] });

    const context = createContext();
    databases.push(context.database);
    const models = await new AgentHarness(context.application, { modelAdapter: adapter })
      .listLlmModels({ provider: "openrouter", apiKey: "secret" });
    expect(models).toHaveLength(12);
    expect(models.find(({ id }) => id === "provider/model-10")).toMatchObject({
      compatibility: "compatible", inputModalities: ["text", "image"]
    });
    expect(models.find(({ id }) => id === "provider/model-11")).toMatchObject({
      compatibility: "incompatible", compatibilityReason: "no_tool_calling"
    });
  });

  it("builds regional Bailian catalog URLs and aggregates every page of official metadata", async () => {
    expect(resolveBailianCatalogEndpoint("ap-southeast-1")).toBe("https://dashscope-intl.aliyuncs.com/api/v1/models");
    expect(resolveBailianCatalogEndpoint("cn-hongkong")).toBe("https://cn-hongkong.dashscope.aliyuncs.com/api/v1/models");
    expect(resolveBailianCatalogEndpoint("cn-beijing")).toBeUndefined();
    expect(resolveBailianCatalogEndpoint("cn-beijing", "ws-123"))
      .toBe("https://ws-123.cn-beijing.maas.aliyuncs.com/api/v1/models");
    expect(resolveBailianCatalogEndpoint("us-east-1", "ws-456"))
      .toBe("https://ws-456.us-east-1.maas.aliyuncs.com/api/v1/models");

    const requests: string[] = [];
    const adapter = new OpenAiCompatibleChatAdapter((async (input) => {
      const url = String(input); requests.push(url);
      const page = new URL(url).searchParams.get("page_no");
      const models = page === "1" ? [
        { model: "qwen-a", name: "Qwen A", capabilities: ["text-generation"], features: ["function-calling"],
          inference_metadata: { request_modality: ["text"], response_modality: ["text"] } },
        { model: "embed-a", name: "Embed A", capabilities: ["text-embedding"], features: [],
          inference_metadata: { request_modality: ["text"], response_modality: ["embedding"] } }
      ] : [{ model: "qwen-vl", name: "Qwen VL", capabilities: ["text-generation"], features: ["function-calling"],
        inference_metadata: { request_modality: ["text", "image"], response_modality: ["text"] } }];
      return jsonResponse({ success: true, output: { total: 3, page_no: Number(page), page_size: 100, models } });
    }) as typeof globalThis.fetch);
    const items = await adapter.listModels({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "secret",
      catalogFormat: "bailian", catalogUrl: "https://ws-123.cn-beijing.maas.aliyuncs.com/api/v1/models"
    });
    expect(items).toHaveLength(3);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("page_size=100");
    expect(items[2]).toMatchObject({
      id: "qwen-vl", capabilities: ["text-generation"], features: ["function-calling"],
      inputModalities: ["text", "image"], outputModalities: ["text"]
    });
    const context = createContext();
    databases.push(context.database);
    const catalogAdapter: AgentModelAdapterPort = {
      identity: "fake.bailian-catalog", version: 1,
      async run(input) { return { model: input.model }; }, async listModels() { return items; }
    };
    const classified = await new AgentHarness(context.application, { modelAdapter: catalogAdapter }).listLlmModels({
      provider: "bailian", region: "ap-southeast-1", apiKey: "secret"
    });
    expect(classified.find(({ id }) => id === "qwen-vl")).toMatchObject({
      compatibility: "compatible", inputModalities: ["text", "image"], outputModalities: ["text"]
    });
    expect(classified.find(({ id }) => id === "embed-a")).toMatchObject({
      compatibility: "incompatible", compatibilityReason: "non_chat_model", outputModalities: ["embedding"]
    });
  });

  it.each(["bailian", "minimax"] as const)("lists built-in %s candidates without credentials or network requests", async (provider) => {
    const context = createContext();
    databases.push(context.database);
    const listModels = vi.fn(async () => []);
    const adapter: AgentModelAdapterPort = {
      identity: "fake.offline-recommendations", version: 1,
      async run(input) { return { model: input.model }; }, listModels
    };
    const harness = new AgentHarness(context.application, { modelAdapter: adapter });
    harness.saveLlm({
      provider, model: provider === "bailian" ? "qwen3.7-plus" : "MiniMax-M3", apiKey: "saved-secret",
      ...(provider === "bailian" ? { region: "cn-beijing", workspaceId: "ws-123" } : {})
    });
    const readCredential = vi.spyOn(context.application, "getLlmCredential");
    const readSettings = vi.spyOn(context.application, "getLlmSettings");
    const candidates = await harness.listLlmModels({
      provider, recommendationsOnly: true, apiKey: "new-secret",
      ...(provider === "bailian" ? { region: "ap-southeast-1", workspaceId: "ws-456" } : {})
    });
    expect(candidates[0]?.id).toBe(provider === "bailian" ? "qwen3.8-omni-flash" : "MiniMax-M3");
    expect(candidates.every(({ recommended, modalitySource }) => recommended && modalitySource === "conservative")).toBe(true);
    expect(readCredential).not.toHaveBeenCalled();
    expect(readSettings).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
    expect(JSON.stringify(candidates)).not.toContain("secret");
  });

  it("falls back to Bailian recommendations without a required workspace ID and persists one when supplied", async () => {
    const context = createContext();
    databases.push(context.database);
    const listModels = vi.fn(async () => []);
    const adapter: AgentModelAdapterPort = {
      identity: "fake.bailian", version: 1,
      async run(input) { return { model: input.model }; }, listModels
    };
    const harness = new AgentHarness(context.application, { modelAdapter: adapter });
    const fallback = await harness.listLlmModels({ provider: "bailian", region: "cn-beijing", apiKey: "secret" });
    expect(fallback.every(({ recommended }) => recommended)).toBe(true);
    expect(listModels).not.toHaveBeenCalled();
    const saved = harness.saveLlm({
      provider: "bailian", region: "cn-beijing", workspaceId: "ws-123", model: "qwen3.7-plus", apiKey: "secret"
    });
    expect(saved.providers.bailian?.workspaceId).toBe("ws-123");
    expect(harness.getLlmSettings().providers.bailian?.workspaceId).toBe("ws-123");
  });

  it("does not save a failed provider connection and productizes Bailian region failures", async () => {
    const context = createContext();
    databases.push(context.database);
    const adapter: AgentModelAdapterPort = {
      identity: "fake.failure", version: 1,
      async run(input) { return { model: input.model }; },
      async testConnection() { throw new AppError("LLM_AUTHENTICATION_FAILED", "rejected"); }
    };
    const harness = new AgentHarness(context.application, { modelAdapter: adapter });
    await expect(harness.connectLlm({
      provider: "bailian", region: "cn-beijing", model: "qwen3.7-plus", apiKey: "wrong-key"
    })).rejects.toMatchObject({ code: "LLM_REGION_MISMATCH" });
    expect(harness.getLlmSettings()).toEqual({ providers: {} });
    expect(context.database.prepare("SELECT count(*) FROM llm_provider_credentials").pluck().get()).toBe(0);
  });

  it("does not enable NVIDIA until a real inference succeeds", async () => {
    const context = createContext();
    databases.push(context.database);
    const adapter: AgentModelAdapterPort = {
      identity: "fake.nvidia-timeout", version: 1,
      async run(input) { return { model: input.model }; },
      async listModels() { return [{ id: "deepseek-ai/deepseek-v4-pro-0813" }]; },
      async testConnection() {
        throw new AppError("AGENT_MODEL_UNAVAILABLE", "The model service connection test timed out.", true);
      }
    };
    const harness = new AgentHarness(context.application, { modelAdapter: adapter });
    await expect(harness.connectLlm({
      provider: "nvidia", model: "deepseek-ai/deepseek-v4-pro-0813", apiKey: "nvidia-key"
    })).rejects.toMatchObject({ code: "AGENT_MODEL_UNAVAILABLE" });
    expect(harness.getLlmSettings()).toEqual({ providers: {} });
    expect(context.database.prepare("SELECT count(*) FROM llm_provider_credentials").pluck().get()).toBe(0);
  });

  it("migrates a recognized legacy enhanced endpoint without deleting legacy data", () => {
    const context = createContext();
    databases.push(context.database);
    context.application.updateAgentSettings({
      mode: "enhanced",
      enhancedEndpoint: { baseUrl: "https://openrouter.ai/api/v1", model: "legacy-model", apiKey: "legacy-key" }
    });
    const migrated = context.application.getLlmSettings();
    expect(migrated).toMatchObject({
      activeProvider: "openrouter",
      providers: { openrouter: { model: "legacy-model", credentialConfigured: true, status: "ready" } }
    });
    expect(context.application.getLlmCredential("openrouter")).toBe("legacy-key");
    expect(context.database.prepare("SELECT count(*) FROM agent_credentials").pluck().get()).toBe(1);
    expect(context.database.prepare("SELECT count(*) FROM llm_provider_credentials").pluck().get()).toBe(1);
  });

  it("keeps unknown legacy endpoints stored but never enables them", () => {
    const context = createContext();
    databases.push(context.database);
    context.application.updateAgentSettings({
      mode: "enhanced",
      enhancedEndpoint: { baseUrl: "https://model.example/v1", model: "legacy-custom", apiKey: "legacy-key" }
    });
    expect(context.application.getLlmSettings()).toEqual({ providers: {} });
    expect(context.database.prepare("SELECT count(*) FROM agent_credentials").pluck().get()).toBe(1);
    expect(context.database.prepare("SELECT count(*) FROM llm_provider_credentials").pluck().get()).toBe(0);
  });

  it("rejects invalid JSON, oversized responses, and model round overflow", async () => {
    const invalid = new OpenAiCompatibleChatAdapter((async () =>
      new globalThis.Response("not-json")) as typeof globalThis.fetch);
    const request = {
      baseUrl: "https://model.example/v1", model: "test", system: "system", user: "user",
      tools: createDefaultAgentToolRegistry().definitions("retrieve"), executeTool: async () => ({})
    };
    await expect(invalid.run(request)).rejects.toMatchObject({ code: "AGENT_MODEL_UNAVAILABLE" });

    const oversized = new OpenAiCompatibleChatAdapter((async () =>
      jsonResponse({}, { headers: { "content-length": String(2 * 1024 * 1024 + 1) } })) as typeof globalThis.fetch);
    await expect(oversized.run(request)).rejects.toMatchObject({ code: "AGENT_MODEL_UNAVAILABLE" });

    const rateLimited = new OpenAiCompatibleChatAdapter((async () =>
      new globalThis.Response("limited", { status: 429 })) as typeof globalThis.fetch);
    await expect(rateLimited.run(request)).rejects.toMatchObject({
      code: "LLM_RATE_LIMITED", retryable: true
    });

    const retired = new OpenAiCompatibleChatAdapter((async () =>
      new globalThis.Response("gone", { status: 410 })) as typeof globalThis.fetch);
    await expect(retired.run(request)).rejects.toMatchObject({
      code: "LLM_MODEL_NOT_FOUND", message: "The selected model is no longer available from this provider."
    });

    const timedOut = new OpenAiCompatibleChatAdapter((async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new globalThis.DOMException("aborted", "AbortError")));
    })) as typeof globalThis.fetch, 5);
    await expect(timedOut.run(request)).rejects.toMatchObject({ code: "AGENT_MODEL_UNAVAILABLE" });

    const controller = new AbortController();
    const cancelled = new globalThis.DOMException("user cancelled", "AbortError");
    let requestSignal: AbortSignal | undefined;
    const abortable = new OpenAiCompatibleChatAdapter((async (_input, init) => new Promise((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined;
      requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
    })) as typeof globalThis.fetch);
    const pending = abortable.run({ ...request, signal: controller.signal });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    controller.abort(cancelled);
    await expect(pending).rejects.toBe(cancelled);
    expect(requestSignal?.aborted).toBe(true);

    let rounds = 0;
    const looping = new OpenAiCompatibleChatAdapter((async () => {
      rounds += 1;
      return jsonResponse({ choices: [{ message: {
        role: "assistant", content: null,
        tool_calls: [{ id: `call-${rounds}`, type: "function", function: { name: "search_events", arguments: "{\"query\":\"x\"}" } }]
      } }] });
    }) as typeof globalThis.fetch);
    await expect(looping.run(request)).rejects.toMatchObject({ code: "AGENT_TOOL_FAILED" });
    expect(rounds).toBe(MAX_AGENT_MODEL_ROUNDS);
  });

  it("cancels a model response body that is still streaming", async () => {
    const controller = new AbortController();
    const cancelled = new globalThis.DOMException("screening cancelled", "AbortError");
    let startedReading!: () => void;
    const reading = new Promise<void>((resolve) => { startedReading = resolve; });
    let bodyCancelled = false;
    const body = new globalThis.ReadableStream<Uint8Array>({
      pull() { startedReading(); },
      cancel() { bodyCancelled = true; }
    }, { highWaterMark: 0 });
    const adapter = new OpenAiCompatibleChatAdapter((async () => new globalThis.Response(body, {
      headers: { "content-type": "text/event-stream" }
    })) as typeof globalThis.fetch);
    const pending = adapter.run({
      baseUrl: "https://model.example/v1", model: "test", system: "system", user: "user",
      tools: [], executeTool: async () => ({}), signal: controller.signal
    });
    await reading;
    controller.abort(cancelled);
    await expect(pending).rejects.toBe(cancelled);
    await vi.waitFor(() => expect(bodyCancelled).toBe(true));
  });

  it("times out when model headers arrive but the response body stalls", async () => {
    let bodyCancelled = false;
    const body = new globalThis.ReadableStream<Uint8Array>({
      pull() {},
      cancel() { bodyCancelled = true; }
    }, { highWaterMark: 0 });
    const adapter = new OpenAiCompatibleChatAdapter((async () => new globalThis.Response(body, {
      headers: { "content-type": "text/event-stream" }
    })) as typeof globalThis.fetch, 100);
    await expect(adapter.run({
      baseUrl: "https://model.example/v1", model: "test", system: "system", user: "user",
      tools: [], executeTool: async () => ({})
    })).rejects.toMatchObject({
      code: "AGENT_MODEL_UNAVAILABLE", retryable: true,
      message: "The configured model response timed out."
    });
    await vi.waitFor(() => expect(bodyCancelled).toBe(true));
  });

  it("times out a stalled connection-test response body", async () => {
    let bodyCancelled = false;
    const body = new globalThis.ReadableStream<Uint8Array>({
      pull() {},
      cancel() { bodyCancelled = true; }
    }, { highWaterMark: 0 });
    const adapter = new OpenAiCompatibleChatAdapter((async () => new globalThis.Response(body, {
      headers: { "content-type": "application/json" }
    })) as typeof globalThis.fetch, 100);
    await expect(adapter.testConnection({
      baseUrl: "https://model.example/v1", model: "test", apiKey: "synthetic-key"
    })).rejects.toMatchObject({
      code: "AGENT_MODEL_UNAVAILABLE", retryable: true,
      message: "The model service connection test timed out."
    });
    await vi.waitFor(() => expect(bodyCancelled).toBe(true));
  });

  it("preserves a record message and applies a proposed Event only after approval", async () => {
    const context = createContext();
    databases.push(context.database);
    const conversation = context.application.createConversation("Agent inbox");
    const harness = new AgentHarness(context.application);
    const result = await harness.send({ conversationId: conversation.id, content: "记录：2026-08-20 报告遗漏了我的署名。" });
    expect(result.run.status).toBe("succeeded");
    expect(result.run.actions[0]?.status).toBe("pending");
    expect(context.application.searchEvents({})).toEqual([]);
    const approved = harness.approveAction(result.run.actions[0]!.id);
    expect(approved.status).toBe("approved");
    const event = context.application.getEvent(approved.resultRefs[0]!).event;
    expect(event.status).toBe("confirmed");
    expect(event.sourceRefs).toContain(result.userMessage.sourceItemId);
    expect(context.application.listEventRevisions(event.id)[0]?.actor).toBe("agent");
    expect(context.application.listMessages(conversation.id)[0]?.content).toContain("报告遗漏");

    const second = await harness.send({ conversationId: conversation.id, content: "记录：另一条仅供确认的事件。" });
    expect(harness.rejectAction(second.run.actions[0]!.id).status).toBe("rejected");
    expect(context.application.searchEvents({})).toHaveLength(1);
  });

  it("marks a write proposal stale when its expected Event revision has changed", async () => {
    const context = createContext();
    databases.push(context.database);
    const conversation = context.application.createConversation("Revision guard");
    const recorded = await context.application.sendMessage({
      conversationId: conversation.id, content: "A report omitted my name", intent: "record"
    });
    const confirmed = recorded.event!;
    const adapter: AgentModelAdapterPort = {
      identity: "fake.writer", version: 1,
      async run(input) {
        await input.executeTool("update_event", {
          eventRef: "event_1", expectedRevision: confirmed.currentRevision,
          narrative: "Proposed Agent narrative"
        }, "write-1");
        return { text: "Prepared an update", model: input.model };
      }
    };
    configureTestLlm(context.application);
    const harness = new AgentHarness(context.application, { modelAdapter: adapter });
    const proposed = await harness.send({
      conversationId: conversation.id, content: "请澄清并更新这条报告事件"
    });
    const action = proposed.run.actions.find(({ toolName }) => toolName === "update_event")!;
    expect(action.status).toBe("pending");
    const current = context.application.getEvent(confirmed.id).event;
    context.application.updateEvent({
      eventId: current.id, expectedRevision: current.currentRevision, reason: "concurrent user edit",
      title: "User edited first", status: current.status, occurredAt: current.occurredAt,
      ...(current.narrative !== undefined ? { narrative: current.narrative } : {}),
      facts: current.facts, interpretations: current.interpretations, emotions: current.emotions,
      interests: current.interests, participants: current.participants,
      sourceRefs: current.sourceRefs, assetRefs: current.assetRefs
    });
    expect(harness.approveAction(action.id).status).toBe("stale");
    expect(context.application.getEvent(current.id).event.title).toBe("User edited first");
  });

  it("keeps Private offline by default and degrades model/tool failures without losing the message", async () => {
    const context = createContext();
    databases.push(context.database);
    const conversation = context.application.createConversation("Offline");
    const adapter: AgentModelAdapterPort = {
      identity: "test", version: 1,
      async run() { throw new Error("must not be called"); }
    };
    const harness = new AgentHarness(context.application, { modelAdapter: adapter });
    const offline = await harness.send({ conversationId: conversation.id, content: "查找一个不存在的事件" });
    expect(offline.run.status).toBe("succeeded");
    expect(offline.run.modelIdentity).toBeUndefined();

    configureTestLlm(context.application);
    const failed = await harness.send({ conversationId: conversation.id, content: "继续查找" });
    expect(failed.run.status).toBe("succeeded");
    expect(failed.run.errorCode).toBe("INTERNAL_ERROR");
    expect(context.application.listMessages(conversation.id).some(({ content }) => content === "继续查找")).toBe(true);
    expect(context.application.listAgentModelCallAudits(failed.run.id)[0]).toMatchObject({ status: "failed" });
  });

  it("merges only schema-valid legal research and minimizes identifying facts sent to the research port", async () => {
    const context = createContext();
    databases.push(context.database);
    context.application.saveLlmConnection({
      provider: "bailian", model: "qwen3.7-plus", apiKey: "test-bailian-key", region: "cn-beijing"
    }, "2026-08-30T00:00:00.000Z");
    let researchInput: LegalResearchInput | undefined;
    const legalResearch: LegalResearchPort = {
      async research(input) {
        researchInput = input;
        return {
          issues: ["需核对奖金约定是否属于劳动报酬组成部分。"],
          citations: [{
            id: "official-1", title: "官方规则页面", publisher: "人力资源和社会保障部",
            url: "https://www.mohrss.gov.cn/rule", retrievedAt: "2026-09-20T00:00:00.000Z",
            jurisdiction: "中国大陆", effectiveInfo: "需结合事发日期核对",
            supportingExcerpt: "支持该待核验问题的原文摘录。", claimId: "bonus-issue",
            verificationStatus: "verified",
            verificationEvidence: {
              officialSource: true, excerptSupportsClaim: true,
              jurisdictionMatches: true, effectiveAtOccurredAt: true
            }
          }, {
            id: "unverified-1", title: "待核对的官方规则", publisher: "司法部",
            url: "https://www.moj.gov.cn/rule", retrievedAt: "2026-09-20T00:00:00.000Z",
            jurisdiction: "中国大陆", effectiveInfo: "未核对事发时点",
            supportingExcerpt: "转载内容。", claimId: "bonus-issue", verificationStatus: "verified",
            verificationEvidence: {
              officialSource: false, excerptSupportsClaim: true,
              jurisdictionMatches: true, effectiveAtOccurredAt: false
            }
          }, {
            id: "spoofed-1", title: "伪造的官方站点", publisher: "人力资源和社会保障部",
            url: "https://www.mohrss.gov.cn.evil.example/rule", retrievedAt: "2026-09-20T00:00:00.000Z",
            jurisdiction: "中国大陆", effectiveInfo: "合成的生效信息", supportingExcerpt: "伪造的原文。", claimId: "bonus-issue",
            verificationStatus: "verified", verificationEvidence: {
              officialSource: true, excerptSupportsClaim: true,
              jurisdictionMatches: true, effectiveAtOccurredAt: true
            }
          }, {
            id: "publisher-spoofed", title: "发布机构错误", publisher: "伪造机构",
            url: "https://www.gov.cn/rule", retrievedAt: "2026-09-20T00:00:00.000Z",
            jurisdiction: "中国大陆", effectiveInfo: "合成的生效信息", supportingExcerpt: "待核对的原文。", claimId: "bonus-issue",
            verificationStatus: "verified", verificationEvidence: {
              officialSource: true, excerptSupportsClaim: true,
              jurisdictionMatches: true, effectiveAtOccurredAt: true
            }
          }],
          coverageNotes: []
        };
      }
    };
    const adapter: AgentModelAdapterPort = {
      identity: "test.report", version: 1,
      async run(input) {
        await input.executeTool("submit_report", {
          summary: "张三称公司尚未支付奖金。",
          time: { source: "source", prompt: "待补充时间" },
          location: { source: "source", prompt: "待补充地点" },
          people: [{ name: "张三", source: "source" }], chronology: [], unknowns: [], disputes: [],
          suggestions: ["整理付款约定。"], legalIssues: ["奖金是否属于应支付报酬？"], coverageNotes: [], state: "complete"
        }, "report-call");
        return { text: "submitted", model: input.model };
      }
    };
    const harness = new AgentHarness(context.application, { modelAdapter: adapter, legalResearch });
    const report = await harness.analyze({
      record: {
        id: "record-1", origin: "manual", categories: ["rights"], title: "奖金争议", summary: "",
        revision: 1, occurredAt: { kind: "date", value: "2025-03-01" },
        recordedAt: "2025-03-02T00:00:00.000Z", reportState: "queued", sourceUpdated: false,
        sourceReviewRequired: false,
        attachmentCount: 1, createdAt: "2025-03-02T00:00:00.000Z", updatedAt: "2025-03-02T00:00:00.000Z"
      },
      source: {
        id: "source-1", recordId: "record-1", origin: "manual", sourceVersion: "source-v1",
        contentHash: "a".repeat(64), text: "张三称公司尚未支付奖金。",
        recordedAt: "2025-03-02T00:00:00.000Z", createdAt: "2025-03-02T00:00:00.000Z"
      },
      attachments: [{
        id: "audio-1", sha256: "b".repeat(64), byteSize: 128, mimeType: "audio/mpeg",
        originalFileName: "call.mp3", vaultFormat: 2, integrityStatus: "verified",
        availabilityStatus: "available", createdAt: "2025-03-02T00:00:00.000Z"
      }],
      overrides: [{
        id: "override-1", recordId: "record-1", fieldKey: "jurisdiction", value: "中国大陆",
        actor: "user", revision: 2, createdAt: "2025-03-03T00:00:00.000Z", updatedAt: "2025-03-03T00:00:00.000Z"
      }]
    });
    expect(researchInput).toMatchObject({ jurisdiction: "中国大陆", sourceVersion: "source-v1" });
    expect(researchInput?.confirmedFacts).toEqual([]);
    expect(researchInput?.reportedFacts[0]).not.toContain("张三");
    expect(researchInput?.occurredAt).toEqual({ kind: "unknown" });
    expect(report.content.citations).toEqual([
      expect.objectContaining({ id: "official-1", verificationStatus: "pending" }),
      expect.objectContaining({ id: "unverified-1", verificationStatus: "pending" }),
      expect.objectContaining({ id: "publisher-spoofed", publisher: "中国政府网", verificationStatus: "pending" })
    ]);
    expect(report.content.coverageNotes.some((note) => note.includes("非官方或异常网址"))).toBe(true);
    expect(report.content.coverageNotes.some((note) => note.includes("已降级为待核验"))).toBe(true);
    expect(report.state).toBe("partial");
    expect(report.content.coverageNotes.some((note) => note.includes("超出当前模型报告分析能力或直传限制"))).toBe(true);
    expect(report.content.legalIssues).toContain("需核对奖金约定是否属于劳动报酬组成部分。");
  });

  it("researches the current report time without inheriting a previous AI date or confirming its summary", async () => {
    const context = createContext(); databases.push(context.database);
    context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash", apiKey: "synthetic-key", region: "cn-beijing" },
      "2026-09-29T00:00:00Z");
    let time: { source: "ai"; value?: { value: string; precision: "exact" | "unknown" } } = {
      source: "ai", value: { value: "2026年9月12日", precision: "exact" }
    };
    const inputs: LegalResearchInput[] = [];
    const modelAdapter: AgentModelAdapterPort = { identity: "test.current-legal-time", version: 1, async run(input) {
      await input.executeTool("submit_report", {
        summary: "合成人物甲称单位尚未支付奖金；仍需核对约定。", time,
        location: { source: "ai" }, people: [{ name: "合成人物甲", source: "source" }], chronology: [],
        unknowns: ["奖金约定尚未核实"], disputes: [], suggestions: ["整理奖金约定和付款凭证。"],
        legalIssues: ["奖金约定的适用规则待核对"], coverageNotes: [], state: "complete"
      }, "synthetic-legal-report");
      return { model: input.model };
    } };
    const legalResearch: LegalResearchPort = { async research(input) {
      inputs.push(input); return { issues: [], citations: [], coverageNotes: [] };
    } };
    const analysis = syntheticAuxiliaryReport({ mimeType: "audio/wav", sha256: "a".repeat(64), byteSize: 4 });
    analysis.attachments = []; analysis.record = { ...analysis.record, attachmentCount: 0,
      occurredAt: { kind: "date", value: "2025-01-01" }, occurredAtSource: "ai" };
    const harness = new AgentHarness(context.application, { modelAdapter, legalResearch });
    await harness.analyze(analysis);
    expect(inputs[0]).toMatchObject({ occurredAt: { kind: "date", value: "2026-09-12" },
      occurredAtSource: "ai", occurredAtPrecision: "exact", confirmedFacts: [],
      reportedFacts: ["Person-1称单位尚未支付奖金；仍需核对约定。"] });
    time = { source: "ai", value: { value: "2099-01-01", precision: "unknown" } };
    await harness.analyze(analysis);
    expect(inputs[1]).toMatchObject({ occurredAt: { kind: "unknown" }, occurredAtSource: "ai", occurredAtPrecision: "unknown" });
    expect(JSON.stringify(inputs[1])).not.toContain("2025-01-01");
    expect(JSON.stringify(inputs[1])).not.toContain("2099-01-01");
  });

  it.each(["current", "old-context", "mutated-input", "missing-effective-info", "outside-period", "unknown-claim", "duplicate-issues"] as const)(
    "retains a verified citation only with current complete research evidence (%s)", async (mode) => {
      const context = createContext(); databases.push(context.database);
      context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash", apiKey: "synthetic-key", region: "cn-beijing" },
        "2026-09-29T00:00:00Z");
      const modelAdapter: AgentModelAdapterPort = { identity: "test.legal-verification-currency", version: 1, async run(input) {
        await input.executeTool("submit_report", { summary: "合成当事人描述奖金约定，待核对凭证。",
          time: { source: "ai", value: { value: "2026-09-12", precision: "exact" } }, location: { source: "ai" },
          people: [], chronology: [], unknowns: [], disputes: [], suggestions: [],
          legalIssues: mode === "duplicate-issues" ? ["应核对奖金约定适用规则", "应核对奖金约定适用规则", "需核对当事人关系", " "]
            : ["应核对奖金约定适用规则"], coverageNotes: [], state: "complete" }, "synthetic-currency-report");
        return { model: input.model };
      } };
      const legalResearch: LegalResearchPort = { async research(input) {
        if (mode === "duplicate-issues") expect(input.issues).toEqual(["应核对奖金约定适用规则", "需核对当事人关系"]);
        if (mode === "mutated-input") input.occurredAt = { kind: "date", value: "2025-01-01" };
        const citation = { id: "synthetic-rule", title: "合成规则（非真实法律）", publisher: "中国政府网",
          url: "https://www.gov.cn/synthetic-test-rule", retrievedAt: "2026-09-29T00:00:00.000Z", jurisdiction: "中国大陆",
          effectiveInfo: "合成测试：2026-09-01 生效，2026-10-01 失效（非真实法律）", supportingExcerpt: "只用于验证代码分支的合成原文。",
          claimId: mode === "unknown-claim" || mode === "duplicate-issues" ? "issue-2" : "issue-1", verificationStatus: "verified" as const,
          verificationEvidence: { officialSource: true, excerptSupportsClaim: true, jurisdictionMatches: true,
            effectiveAtOccurredAt: true, factsSupportApplicability: true,
            contextFingerprint: legalContextFingerprint(mode === "old-context" ? { ...input, sourceVersion: "old-v1" } : input),
            effectivePeriod: { from: mode === "outside-period" ? "2026-09-20" : "2026-09-01", toExclusive: "2026-10-01" } } };
        if (mode === "missing-effective-info") delete (citation as Partial<typeof citation>).effectiveInfo;
        return { issues: [], citations: [citation], coverageNotes: [] };
      } };
      const analysis = syntheticAuxiliaryReport({ mimeType: "audio/wav", sha256: "a".repeat(64), byteSize: 4 });
      analysis.attachments = []; analysis.record = { ...analysis.record, attachmentCount: 0,
        occurredAt: { kind: "date", value: "2025-01-01" }, occurredAtSource: "ai" };
      const report = await new AgentHarness(context.application, { modelAdapter, legalResearch }).analyze(analysis);
      expect(report.content.time.value?.value).toBe("2026-09-12");
      expect(report.content.citations).toHaveLength(1);
      expect(report.content.citations[0]?.verificationStatus).toBe(mode === "current" || mode === "duplicate-issues" ? "verified" : "pending");
      if (mode === "duplicate-issues") expect(report.content.legalIssues).toEqual(["应核对奖金约定适用规则", "需核对当事人关系"]);
      expect(report.content.citations[0]?.effectiveInfo?.trim()).toBeTruthy();
      expect(report.state).toBe("complete");
    }
  );

  it("passes protected user dates, months, relative times and cleared values to legal research at their real precision", async () => {
    const context = createContext(); databases.push(context.database);
    context.application.saveLlmConnection({ provider: "bailian", model: "qwen3.8-omni-flash", apiKey: "synthetic-key", region: "cn-beijing" },
      "2026-09-29T00:00:00Z");
    const modelAdapter: AgentModelAdapterPort = { identity: "test.protected-legal-time", version: 1, async run(input) {
      await input.executeTool("submit_report", { summary: "合成陈述（未核实）", time: { source: "ai", value: { value: "2099-01-01", precision: "exact" } },
        location: { source: "ai" }, people: [], chronology: [], unknowns: [], disputes: [], suggestions: [],
        legalIssues: ["适用规则待核对"], coverageNotes: [], state: "complete" }, "synthetic-protected-legal-report");
      return { model: input.model };
    } };
    let captured: LegalResearchInput | undefined;
    const legalResearch: LegalResearchPort = { async research(input) { captured = input; return { issues: [], citations: [], coverageNotes: [] }; } };
    const harness = new AgentHarness(context.application, { modelAdapter, legalResearch });
    for (const [value, precision] of [[{ kind: "date", value: "2026-09-12" }, "exact"], [{ kind: "month", value: "2026-09" }, "exact"],
      [{ kind: "range", from: "2026-09-01", to: "2026-09-30" }, "range"], [{ kind: "range", to: "2026-09" }, "range"],
      [{ kind: "relative", text: "上周" }, "approximate"], [{ kind: "unknown" }, "unknown"]] as const) {
      const analysis = syntheticAuxiliaryReport({ mimeType: "audio/wav", sha256: "a".repeat(64), byteSize: 4 });
      analysis.attachments = []; analysis.record = { ...analysis.record, attachmentCount: 0,
        occurredAt: { kind: "date", value: "2025-01-01" }, occurredAtSource: "ai" };
      analysis.overrides = [{ id: "synthetic-time-override", recordId: analysis.record.id, fieldKey: "occurredAt", value, actor: "user",
        revision: 1, createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z" }];
      await harness.analyze(analysis);
      expect(captured).toMatchObject({ occurredAt: value, occurredAtSource: "user", occurredAtPrecision: precision, confirmedFacts: [] });
      expect(JSON.stringify(captured)).not.toContain("2099-01-01");
    }
  });

  it("requires category consent for Enhanced, redacts context, audits the call, and re-prompts for a new category", async () => {
    const context = createContext();
    databases.push(context.database);
    const conversation = context.application.createConversation("Review");
    context.application.createPerson("Alex");
    const recorded = await context.application.sendMessage({
      conversationId: conversation.id,
      content: "Alex omitted my name; mail alex@example.com; see /Users/me/private/report.pdf.", intent: "record"
    });
    let modelContext = "";
    const adapter: AgentModelAdapterPort = {
      identity: "fake.enhanced", version: 1,
      async run(input) { modelContext = input.user; return { text: "Model answer", model: input.model, promptTokens: 4 }; }
    };
    const harness = new AgentHarness(context.application, { modelAdapter: adapter });
    context.application.saveLlmConnection({
      provider: "openrouter", model: "fake", apiKey: "top-secret-key"
    }, "2026-08-30T00:00:00.000Z");
    const pending = await harness.send({ conversationId: conversation.id, content: "回顾 Alex 的报告问题" });
    expect(pending.run.status).toBe("awaiting_consent");
    expect(pending.run.disclosure?.categories).toEqual(expect.arrayContaining([
      "conversation_text", "event_fields", "source_excerpt"
    ]));
    expect(modelContext).toBe("");
    const completed = await harness.resume(pending.run.id, pending.run.disclosure!.id);
    expect(completed.run.responseText).toBe("Model answer");
    expect(completed.run.analysis?.interpretations).toContainEqual(expect.objectContaining({
      text: "Model answer", kind: "interpretation.agent", citationIds: []
    }));
    expect(modelContext).not.toContain("Alex");
    expect(modelContext).not.toContain("alex@example.com");
    expect(modelContext).not.toContain("report.pdf");
    expect(Buffer.byteLength(modelContext, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect((JSON.parse(modelContext) as { recentConversation: unknown[] }).recentConversation.length).toBeLessThanOrEqual(12);
    expect(context.application.listAgentModelCallAudits(completed.run.id)[0]).toMatchObject({
      endpointOrigin: "https://openrouter.ai", model: "fake", status: "succeeded", promptTokens: 4
    });
    const storedCredential = String(context.database.prepare(
      "SELECT envelope_json FROM llm_provider_credentials WHERE provider = 'openrouter'"
    ).pluck().get());
    expect(storedCredential).not.toContain("top-secret-key");
    expect(JSON.stringify(context.application.getLlmSettings())).not.toContain("top-secret-key");

    const current = context.application.getEvent(recorded.event!.id).event;
    context.session.assets.upsert({
      id: "asset-1", sha256: "a".repeat(64), byteSize: 4, mimeType: "text/plain",
      originalFileName: "secret.txt", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available",
      createdAt: "2026-08-24T00:00:00.000Z"
    });
    context.application.updateEvent({
      eventId: current.id, expectedRevision: current.currentRevision, reason: "link existing asset",
      title: current.title, status: current.status, occurredAt: current.occurredAt,
      ...(current.narrative !== undefined ? { narrative: current.narrative } : {}),
      facts: current.facts, interpretations: current.interpretations, emotions: current.emotions,
      interests: current.interests, participants: current.participants, sourceRefs: current.sourceRefs,
      assetRefs: ["asset-1"]
    });
    const categoryChange = await harness.send({ conversationId: conversation.id, content: "再次回顾报告问题" });
    expect(categoryChange.run.status).toBe("awaiting_consent");
    expect(categoryChange.run.disclosure?.categories).toContain("asset_metadata");
    expect(harness.disconnectLlm("openrouter").providers.openrouter).toBeUndefined();
  });

  it("accepts a plain direct reply only for the single clarification just displayed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    try {
      const context = createContext();
      databases.push(context.database);
      const conversation = context.application.createConversation("Clarify");
      const recorded = await context.application.sendMessage({
        conversationId: conversation.id, content: "Someone omitted my name from the report", intent: "record"
      });
      const harness = new AgentHarness(context.application);
      const review = await harness.send({ conversationId: conversation.id, content: "请回顾并列出待补全问题" });
      expect(review.run.analysis?.suggestedQuestions).toHaveLength(1);
      const answer = await harness.send({ conversationId: conversation.id, content: "大约在 2026 年 8 月" });
      expect(answer.run.intent).toBe("clarify");
      expect(answer.run.actions[0]?.status).toBe("approved");
      expect(context.application.listClarifications(recorded.event!.id)[0]?.status).toBe("answered");
      expect(context.application.listEventRevisions(recorded.event!.id)[0]?.actor).toBe("agent");
    } finally { vi.useRealTimers(); }
  });

  it("rejects guessed object ids from model tools and returns a deterministic fallback", async () => {
    const context = createContext();
    databases.push(context.database);
    const conversation = context.application.createConversation("Grounding");
    const adapter: AgentModelAdapterPort = {
      identity: "fake.bad-reference", version: 1,
      async run(input) {
        await input.executeTool("get_event", { eventRef: "a-guessed-real-id" }, "bad-call");
        return { text: "Invented fact", model: input.model };
      }
    };
    configureTestLlm(context.application);
    const result = await new AgentHarness(context.application, { modelAdapter: adapter })
      .send({ conversationId: conversation.id, content: "Find the event" });
    expect(result.run.status).toBe("succeeded");
    expect(result.run.errorCode).toBe("AGENT_TOOL_FAILED");
    expect(result.run.responseText).not.toBe("Invented fact");
    expect(result.run.analysis?.confirmedFacts).toEqual([]);
    expect(result.run.analysis?.interpretations).toEqual([]);
  });

  it("enforces loopback-only Private and HTTPS-only Enhanced settings", () => {
    const context = createContext();
    databases.push(context.database);
    expect(() => context.application.updateAgentSettings({
      mode: "private", privateEndpoint: { baseUrl: "https://model.example/v1", model: "x" }
    })).toThrowError(AppError);
    expect(() => context.application.updateAgentSettings({
      mode: "enhanced", enhancedEndpoint: { baseUrl: "http://model.example/v1", model: "x" }
    })).toThrowError(AppError);
    expect(() => context.application.updateAgentSettings({
      mode: "enhanced", enhancedEndpoint: { baseUrl: "https://user:pass@model.example/v1?x=1", model: "x" }
    })).toThrowError(AppError);
    expect(() => context.application.updateAgentSettings({
      mode: "enhanced", enhancedEndpoint: { baseUrl: "https://model.example/v1?", model: "x" }
    })).toThrowError(AppError);
  });
});
