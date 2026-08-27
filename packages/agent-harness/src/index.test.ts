import { Readable } from "node:stream";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GrudgeVaultApplication,
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
import {
  AGENT_TOOL_SCHEMA_VERSION,
  AgentHarness,
  MAX_AGENT_MODEL_ROUNDS,
  OpenAiCompatibleChatAdapter,
  createDefaultAgentToolRegistry,
  exportAgentToolSchemasV3,
  redactExternalText,
  routeAgentIntent,
  type AgentModelAdapterPort
} from "./index";

function createContext() {
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
  return { database, session, application: new GrudgeVaultApplication(manager) };
}

function jsonResponse(value: unknown, init: globalThis.ResponseInit = {}): globalThis.Response {
  return new globalThis.Response(JSON.stringify(value), {
    status: 200, headers: { "content-type": "application/json" }, ...init
  });
}

describe("Phase 4 Agent Harness", () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const database of databases.splice(0)) if (database.open) database.close();
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

  it("runs the standard Chat Completions tool loop without redirects or streaming", async () => {
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
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ stream: false, tool_choice: "auto" });
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
      code: "AGENT_MODEL_UNAVAILABLE", retryable: true
    });

    const timedOut = new OpenAiCompatibleChatAdapter((async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new globalThis.DOMException("aborted", "AbortError")));
    })) as typeof globalThis.fetch, 5);
    await expect(timedOut.run(request)).rejects.toMatchObject({ code: "AGENT_MODEL_UNAVAILABLE" });

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
    context.application.updateAgentSettings({
      mode: "private", privateEndpoint: { baseUrl: "http://127.0.0.1:9999/v1", model: "fake" }
    });
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

    context.application.updateAgentSettings({
      mode: "private", privateEndpoint: { baseUrl: "http://127.0.0.1:1234/v1", model: "fake" }
    });
    const failed = await harness.send({ conversationId: conversation.id, content: "继续查找" });
    expect(failed.run.status).toBe("succeeded");
    expect(failed.run.errorCode).toBe("INTERNAL_ERROR");
    expect(context.application.listMessages(conversation.id).some(({ content }) => content === "继续查找")).toBe(true);
    expect(context.application.listAgentModelCallAudits(failed.run.id)[0]).toMatchObject({ status: "failed" });
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
    context.application.updateAgentSettings({
      mode: "enhanced",
      enhancedEndpoint: { baseUrl: "https://model.example/v1", model: "fake", apiKey: "top-secret-key" }
    });
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
      endpointOrigin: "https://model.example", model: "fake", status: "succeeded", promptTokens: 4
    });
    const storedCredential = String(context.database.prepare(
      "SELECT envelope_json FROM agent_credentials WHERE mode = 'enhanced'"
    ).pluck().get());
    expect(storedCredential).not.toContain("top-secret-key");
    expect(JSON.stringify(context.application.getAgentSettings())).not.toContain("top-secret-key");

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
    expect(harness.clearCredential("enhanced").enhancedEndpoint?.credentialConfigured).toBe(false);
  });

  it("accepts a plain direct reply only for the single clarification just displayed", async () => {
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
    context.application.updateAgentSettings({
      mode: "private", privateEndpoint: { baseUrl: "http://localhost:8080/v1", model: "fake" }
    });
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
