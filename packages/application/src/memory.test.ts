import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAYONE_IMPORT_RECEIPT_KEY, GrudgeVaultApplication, JobRunner, jobRetryDelayForError, jobRetryDelayMs, parseConservativeTemporalValue,
  resolveLlmProviderEndpoint,
  type EmbeddingAdapterPort, type EventDraftGeneratorPort, type NormalizedDayOneEntry, type ObjectVaultPort,
  type WorkspaceManagerPort, type WorkspaceSession
} from "./index";
import type { ImportRun } from "@grudge-vault/domain";
import {
  runMigrations, SqliteAgentRepository, SqliteAssetRepository, SqliteDayOneRepository, SqliteJobRepository, SqliteMemoryRepository
} from "@grudge-vault/persistence-sqlite";
import { AppError } from "@grudge-vault/shared";

describe("background retry policy", () => {
  it("uses a validated Bailian workspace endpoint when one is configured", () => {
    expect(resolveLlmProviderEndpoint("bailian", "cn-beijing", "ws-123"))
      .toBe("https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
    expect(resolveLlmProviderEndpoint("bailian", "cn-beijing"))
      .toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(() => resolveLlmProviderEndpoint("bailian", "cn-beijing", "unsafe.example/../../"))
      .toThrowError(AppError);
  });
  it("uses the specified 2, 8 and 30 second backoff for each four-attempt cycle", () => {
    expect([1, 2, 3, 4, 5].map(jobRetryDelayMs)).toEqual([2_000, 8_000, 30_000, undefined, 2_000]);
  });

  it("does not retry an error explicitly marked non-retryable", () => {
    expect(jobRetryDelayForError(new AppError("INVALID_INPUT", "invalid", false), 1)).toBeUndefined();
    expect(jobRetryDelayForError(new AppError("SCREENING_FAILED", "temporary", true), 1)).toBe(2_000);
    expect(jobRetryDelayForError(new Error("unknown transport failure"), 2)).toBe(8_000);
  });

  it("runs at the configured bounded concurrency without claiming a third job early", async () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    runMigrations(database);
    const jobs = new SqliteJobRepository(database);
    const now = new Date().toISOString();
    for (let index = 0; index < 3; index += 1) jobs.enqueue("test.parallel", { index }, now, 1);
    const releases: Array<() => void> = [];
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    const runner = new JobRunner(jobs, {
      "test.parallel": async (job) => {
        started.push(job.id); active += 1; peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      }
    }, { concurrency: 2, pollMs: 1_000 });
    try {
      runner.start();
      await vi.waitFor(() => expect(started).toHaveLength(2));
      expect(active).toBe(2);
      releases.shift()!();
      await vi.waitFor(() => expect(started).toHaveLength(3));
      expect(peak).toBe(2);
      for (const release of releases.splice(0)) release();
      await vi.waitFor(() => expect(jobs.list().every(({ state }) => state === "succeeded")).toBe(true));
    } finally {
      await runner.stopAndWait();
      database.close();
    }
  });

  it("does not claim a queued job without a handler in this app version", async () => {
    const database = new Database(":memory:");
    runMigrations(database);
    const jobs = new SqliteJobRepository(database);
    const now = new Date().toISOString();
    const legacy = jobs.enqueue("dayone.import", {}, now, 1);
    const current = jobs.enqueue("record.analyze", {}, now, 1);
    const runner = new JobRunner(jobs, { "record.analyze": async () => undefined }, { pollMs: 10 });
    try {
      runner.start();
      await vi.waitFor(() => expect(jobs.list().find(({ id }) => id === current.id)?.state).toBe("succeeded"));
      expect(jobs.list().find(({ id }) => id === legacy.id)).toMatchObject({ state: "queued", attempts: 0 });
    } finally {
      await runner.stopAndWait();
      database.close();
    }
  });

  it("stores only failure codes when a background handler includes private content in its error", async () => {
    const database = new Database(":memory:");
    runMigrations(database);
    const jobs = new SqliteJobRepository(database);
    const now = new Date().toISOString();
    const privateMarker = "private-diary-and-filename-job-error-marker";
    const known = jobs.enqueue("test.known-error", {}, now, 1);
    const unknown = jobs.enqueue("test.unknown-error", {}, now, 1);
    const runner = new JobRunner(jobs, {
      "test.known-error": async () => { throw new AppError("SCREENING_FAILED", privateMarker, false); },
      "test.unknown-error": async () => { throw new Error(privateMarker); }
    }, { pollMs: 10 });
    try {
      runner.start();
      await vi.waitFor(() => expect(jobs.list().filter(({ state }) => state === "failed")).toHaveLength(2));
      expect(jobs.list().find(({ id }) => id === known.id)?.lastError).toBe("SCREENING_FAILED");
      expect(jobs.list().find(({ id }) => id === unknown.id)?.lastError).toBe("INTERNAL_ERROR");
      expect(database.serialize().includes(Buffer.from(privateMarker))).toBe(false);
    } finally {
      await runner.stopAndWait();
      database.close();
    }
  });
});

function testContext(generator?: EventDraftGeneratorPort, embeddingAdapter?: EmbeddingAdapterPort, databasePath = ":memory:") {
  const database = new Database(databasePath);
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
    key: Buffer.alloc(32),
    assets: new SqliteAssetRepository(database), jobs: new SqliteJobRepository(database),
    memory, agents: new SqliteAgentRepository(database), dayOne: new SqliteDayOneRepository(database, memory), vault,
    async backupDatabase() {}, async close() { database.close(); }
  };
  const manager: WorkspaceManagerPort = {
    current: () => session,
    async create() { return session; }, async open() { return session; },
    async createBackup() { throw new Error("unused"); }, async restoreBackup() { return session; },
    async close() {}
  };
  return { database, session, manager, application: new GrudgeVaultApplication(manager, generator, undefined, embeddingAdapter) };
}

describe("workspace terminal import receipts", () => {
  const databases: Database.Database[] = [];
  afterEach(() => { vi.restoreAllMocks(); for (const database of databases.splice(0)) if (database.open) database.close(); });
  const receipt = { finishedAt: "2026-09-29T08:30:00.000Z", outcome: "completed", totalEntries: 3,
    included: 0, skipped: 3, review: 0, failed: 0, issueCount: 0, mediaEntries: 0, missingMedia: 0 };
  it("stores only one projected aggregate without ordinary-entry records or source identifiers", () => {
    const context = testContext(); databases.push(context.database);
    expect(context.application.getLastDayOneImportReceipt()).toBeNull();
    context.application.saveDayOneImportReceipt(context.session, { ...receipt,
      body: "synthetic-private-receipt-marker", sourceId: "synthetic-private-source", filename: "synthetic-private.zip" });
    expect(context.application.getLastDayOneImportReceipt()).toEqual(receipt);
    const stored = context.database.prepare("SELECT value_json, updated_at FROM workspace_settings WHERE key = ?")
      .get(DAYONE_IMPORT_RECEIPT_KEY) as { value_json: string; updated_at: string };
    expect(JSON.parse(stored.value_json)).toEqual(receipt); expect(stored.updated_at).toBe(receipt.finishedAt);
    expect(context.database.serialize().includes(Buffer.from("synthetic-private"))).toBe(false);
    for (const table of ["source_items", "journal_entries", "assets", "redesign_records", "redesign_pending_reviews"])
      expect(context.database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
  });
  it("survives a real database close and reopen, replacing only the latest batch", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-receipt-test-"));
    try {
      const first = testContext(undefined, undefined, join(root, "synthetic.sqlite3")); databases.push(first.database);
      first.application.saveDayOneImportReceipt(first.session, receipt);
      const latest = { ...receipt, outcome: "cancelled", skipped: 1, finishedAt: "2026-09-29T08:35:00.000Z" };
      first.application.saveDayOneImportReceipt(first.session, latest); first.database.close();
      const reopened = testContext(undefined, undefined, join(root, "synthetic.sqlite3")); databases.push(reopened.database);
      expect(reopened.application.getLastDayOneImportReceipt()).toEqual(latest);
      expect(reopened.database.prepare("SELECT count(*) FROM workspace_settings WHERE key = ?").pluck().get(DAYONE_IMPORT_RECEIPT_KEY)).toBe(1);
      reopened.database.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects a closed or replacement session even with the same workspace id", () => {
    const context = testContext(); databases.push(context.database);
    const current = vi.spyOn(context.manager, "current");
    current.mockReturnValue(undefined);
    expect(() => context.application.saveDayOneImportReceipt(context.session, receipt)).toThrowError(AppError);
    current.mockReturnValue({ ...context.session });
    expect(() => context.application.saveDayOneImportReceipt(context.session, receipt)).toThrowError(AppError);
    current.mockRestore(); expect(context.application.getLastDayOneImportReceipt()).toBeNull();
  });
  it("rolls back a post-write failure without deleting the preceding summary or leaking the SQL error", () => {
    const context = testContext(); databases.push(context.database);
    context.application.saveDayOneImportReceipt(context.session, receipt);
    context.database.exec(`CREATE TEMP TRIGGER reject_receipt AFTER UPDATE ON workspace_settings
      WHEN NEW.key = 'redesign.last-dayone-import-v1'
      BEGIN SELECT RAISE(FAIL, 'synthetic-private-receipt-write-error'); END;`);
    expect(() => context.application.saveDayOneImportReceipt(context.session, { ...receipt, skipped: 2 }))
      .toThrow("未能保存导入摘要；已处理的记录不受影响。");
    expect(context.application.getLastDayOneImportReceipt()).toEqual(receipt);
  });
  it("reports corrupt metadata as unavailable rather than absent and never echoes stored content", () => {
    const context = testContext(); databases.push(context.database);
    context.database.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES (?, ?, ?)")
      .run(DAYONE_IMPORT_RECEIPT_KEY, "synthetic-private-invalid-json", receipt.finishedAt);
    expect(() => context.application.getLastDayOneImportReceipt()).toThrow("暂时无法读取上次导入摘要；不会重新开始导入。");
    context.session.memory.setSetting(DAYONE_IMPORT_RECEIPT_KEY, { ...receipt, privateBody: "synthetic-private" }, receipt.finishedAt);
    expect(context.application.getLastDayOneImportReceipt()).toEqual(receipt);
    context.session.memory.setSetting(DAYONE_IMPORT_RECEIPT_KEY, null, receipt.finishedAt);
    expect(() => context.application.getLastDayOneImportReceipt()).toThrowError(AppError);
  });
});

describe("model configuration storage transactions", () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const database of databases.splice(0)) if (database.open) database.close();
  });
  const testedAt = "2026-09-28T00:00:00.000Z";
  const nextTestedAt = "2026-09-28T00:01:00.000Z";
  const newInput = {
    provider: "bailian" as const, model: "qwen-new", region: "cn-beijing" as const,
    workspaceId: "ws-new", apiKey: "synthetic-new-key"
  };
  const snapshot = (database: Database.Database) => ({
    settings: database.prepare("SELECT * FROM llm_settings ORDER BY singleton").all(),
    providers: database.prepare("SELECT * FROM llm_provider_settings ORDER BY provider").all(),
    credentials: database.prepare("SELECT * FROM llm_provider_credentials ORDER BY provider").all(),
    legacySettings: database.prepare("SELECT * FROM agent_model_settings ORDER BY singleton").all(),
    legacyCredentials: database.prepare("SELECT * FROM agent_credentials ORDER BY mode").all()
  });
  const rejectWrite = (database: Database.Database, table: string, action: "INSERT" | "UPDATE" | "DELETE") => {
    // FAIL deliberately leaves a completed row change in its statement, so only the
    // surrounding transaction can restore the entire configuration.
    database.exec(`CREATE TEMP TRIGGER reject_llm_write AFTER ${action} ON ${table}
      BEGIN SELECT RAISE(FAIL, 'synthetic-model-write-failure'); END;`);
  };
  const change = (application: GrudgeVaultApplication, operation: string) => {
    if (operation === "connect") return application.saveLlmConnection(newInput, nextTestedAt);
    if (operation === "save") return application.saveLlmProvider(newInput);
    if (operation === "activate") return application.activateLlmProvider("minimax", nextTestedAt);
    if (operation === "disconnect") return application.disconnectLlmProvider("bailian");
    if (operation === "pause") return application.pauseLlmProviders();
    return application.markLlmProviderNeedsAttention("bailian");
  };
  const seededCases = [
    ["connect", "llm_provider_credentials", "UPDATE"],
    ["connect", "llm_provider_settings", "UPDATE"],
    ["connect", "llm_settings", "UPDATE"],
    ["save", "llm_provider_credentials", "UPDATE"],
    ["save", "llm_provider_settings", "UPDATE"],
    ["save", "llm_settings", "UPDATE"],
    ["activate", "llm_provider_settings", "UPDATE"],
    ["activate", "llm_settings", "UPDATE"],
    ["disconnect", "llm_provider_credentials", "DELETE"],
    ["disconnect", "llm_provider_settings", "DELETE"],
    ["disconnect", "llm_settings", "UPDATE"],
    ["pause", "llm_settings", "UPDATE"],
    ["attention", "llm_provider_settings", "UPDATE"]
  ] as const;

  it.each(seededCases)("rolls back %s when %s %s fails after writing", (operation, table, action) => {
    const { database, application } = testContext();
    databases.push(database);
    application.saveLlmConnection({ provider: "minimax", model: "MiniMax-M3", apiKey: "synthetic-minimax-key" }, testedAt);
    application.saveLlmConnection({
      provider: "bailian", model: "qwen-old", region: "cn-beijing", workspaceId: "ws-old", apiKey: "synthetic-old-key"
    }, testedAt, {
      inputModalities: ["text", "image"], outputModalities: ["text"], structuredOutput: true,
      verifiedTasks: ["connection", "structured_output", "screening"], lastVerifiedAt: testedAt
    });
    const before = snapshot(database);
    const assertCurrent = application.beginLlmConfigurationTest("bailian");
    rejectWrite(database, table, action);
    expect(() => change(application, operation)).toThrow("synthetic-model-write-failure");
    expect(snapshot(database)).toEqual(before);
    expect(() => assertCurrent()).not.toThrow();
    expect(application.getLlmCredential("bailian")).toBe("synthetic-old-key");
    expect(application.getLlmCredential("minimax")).toBe("synthetic-minimax-key");

    database.exec("DROP TRIGGER reject_llm_write");
    const result = change(application, operation);
    expect(() => assertCurrent()).toThrowError(AppError);
    if (operation === "connect" || operation === "save") {
      expect(result.providers.bailian).toMatchObject({
        model: "qwen-new", workspaceId: "ws-new", credentialConfigured: true,
        status: operation === "connect" ? "ready" : "needs_attention"
      });
      expect(application.getLlmCredential("bailian")).toBe("synthetic-new-key");
      expect(result.activeProvider).toBe(operation === "connect" ? "bailian" : undefined);
    } else if (operation === "activate") {
      expect(result.activeProvider).toBe("minimax");
      expect(result.providers.minimax?.lastTestedAt).toBe(nextTestedAt);
    } else if (operation === "disconnect") {
      expect(result.providers.bailian).toBeUndefined();
      expect(application.getLlmCredential("bailian")).toBeUndefined();
      expect(result.activeProvider).toBeUndefined();
    } else if (operation === "pause") expect(result.activeProvider).toBeUndefined();
    else expect(result.providers.bailian?.status).toBe("needs_attention");
  });

  const firstWriteCases = (["connect", "save"] as const).flatMap((operation) => [
    [operation, "llm_provider_credentials", "INSERT"], [operation, "llm_provider_settings", "INSERT"],
    [operation, "llm_settings", "INSERT"], [operation, "llm_settings", "UPDATE"]
  ] as const);
  it.each(firstWriteCases)("leaves no first-time configuration after %s fails at %s %s", (operation, table, action) => {
    const { database, application } = testContext();
    databases.push(database);
    const before = snapshot(database);
    rejectWrite(database, table, action);
    expect(() => change(application, operation)).toThrow("synthetic-model-write-failure");
    expect(snapshot(database)).toEqual(before);
    database.exec("DROP TRIGGER reject_llm_write");
    expect(change(application, operation).providers.bailian?.model).toBe("qwen-new");
    expect(application.getLlmCredential("bailian")).toBe("synthetic-new-key");
  });

  it.each(["llm_provider_credentials", "llm_provider_settings", "llm_settings"])(
    "rolls back legacy configuration migration when %s fails and permits retry", (table) => {
      const { database, application } = testContext();
      databases.push(database);
      application.updateAgentSettings({
        mode: "enhanced", enhancedEndpoint: {
          baseUrl: "https://openrouter.ai/api/v1", model: "synthetic-legacy-model", apiKey: "synthetic-legacy-key"
        }
      });
      const before = snapshot(database);
      rejectWrite(database, table, "INSERT");
      expect(() => application.getLlmSettings()).toThrow("synthetic-model-write-failure");
      expect(snapshot(database)).toEqual(before);
      database.exec("DROP TRIGGER reject_llm_write");
      expect(application.getLlmSettings()).toMatchObject({
        activeProvider: "openrouter", providers: { openrouter: { model: "synthetic-legacy-model", status: "ready" } }
      });
      expect(application.getLlmCredential("openrouter")).toBe("synthetic-legacy-key");
      expect(snapshot(database).legacySettings).toEqual(before.legacySettings);
      expect(snapshot(database).legacyCredentials).toEqual(before.legacyCredentials);
    }
  );

  it("leaves no initialized settings marker when its write fails", () => {
    const { database, application } = testContext();
    databases.push(database);
    const before = snapshot(database);
    rejectWrite(database, "llm_settings", "INSERT");
    expect(() => application.getLlmSettings()).toThrow("synthetic-model-write-failure");
    expect(snapshot(database)).toEqual(before);
    database.exec("DROP TRIGGER reject_llm_write");
    expect(application.getLlmSettings()).toEqual({ providers: {} });
  });

  it.each(["connect", "save"])("keeps the explicit %s choice when legacy settings initialize in the same call", (operation) => {
    const { database, application } = testContext();
    databases.push(database);
    application.updateAgentSettings({
      mode: "enhanced", enhancedEndpoint: {
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "synthetic-legacy-model", apiKey: "synthetic-legacy-key"
      }
    });
    const legacy = snapshot(database);
    const result = change(application, operation);
    expect(result.providers.bailian).toMatchObject({
      model: "qwen-new", workspaceId: "ws-new", status: operation === "connect" ? "ready" : "needs_attention"
    });
    expect(result.activeProvider).toBe(operation === "connect" ? "bailian" : undefined);
    expect(application.getLlmCredential("bailian")).toBe("synthetic-new-key");
    expect(snapshot(database).legacySettings).toEqual(legacy.legacySettings);
    expect(snapshot(database).legacyCredentials).toEqual(legacy.legacyCredentials);
  });

  it("does not recreate a disconnected provider while initializing legacy settings", () => {
    const { database, application } = testContext();
    databases.push(database);
    application.updateAgentSettings({
      mode: "enhanced", enhancedEndpoint: {
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "synthetic-legacy-model", apiKey: "synthetic-legacy-key"
      }
    });
    const legacy = snapshot(database);
    expect(application.disconnectLlmProvider("bailian")).toEqual({ providers: {} });
    expect(application.getLlmCredential("bailian")).toBeUndefined();
    expect(snapshot(database).legacySettings).toEqual(legacy.legacySettings);
    expect(snapshot(database).legacyCredentials).toEqual(legacy.legacyCredentials);
  });

  it.each(["connect", "save"])("rolls back nested legacy initialization when the outer %s update fails", (operation) => {
    const { database, application } = testContext();
    databases.push(database);
    application.updateAgentSettings({
      mode: "enhanced", enhancedEndpoint: {
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "synthetic-legacy-model", apiKey: "synthetic-legacy-key"
      }
    });
    const before = snapshot(database);
    rejectWrite(database, "llm_provider_settings", "UPDATE");
    expect(() => change(application, operation)).toThrow("synthetic-model-write-failure");
    expect(snapshot(database)).toEqual(before);
    database.exec("DROP TRIGGER reject_llm_write");
    expect(change(application, operation).providers.bailian?.model).toBe("qwen-new");
    expect(application.getLlmCredential("bailian")).toBe("synthetic-new-key");
  });

  it.each(["connect", "disconnect"])("keeps a failed %s unchanged after closing and reopening a WAL database", async (operation) => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-model-transaction-"));
    const databasePath = join(root, "synthetic-model.sqlite3");
    const context = testContext(undefined, undefined, databasePath);
    databases.push(context.database);
    try {
      context.database.pragma("journal_mode = WAL");
      context.application.saveLlmConnection({
        provider: "bailian", model: "qwen-old", region: "cn-beijing", apiKey: "synthetic-old-key"
      }, testedAt);
      const before = snapshot(context.database);
      rejectWrite(context.database, "llm_settings", "UPDATE");
      expect(() => change(context.application, operation)).toThrow("synthetic-model-write-failure");
      context.database.close();

      const reopened = testContext(undefined, undefined, databasePath);
      databases.push(reopened.database);
      expect(snapshot(reopened.database)).toEqual(before);
      expect(reopened.application.getLlmCredential("bailian")).toBe("synthetic-old-key");
      const committed = change(reopened.application, operation);
      reopened.database.close();

      const verified = testContext(undefined, undefined, databasePath);
      databases.push(verified.database);
      expect(verified.application.getLlmSettings()).toEqual(committed);
      expect(verified.application.getLlmCredential("bailian"))
        .toBe(operation === "connect" ? "synthetic-new-key" : undefined);
      verified.database.close();
    } finally {
      for (const database of databases) if (database.open) database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Phase 1 event recording application", () => {
  let contexts: Array<{ database: Database.Database }>;

  beforeEach(() => { contexts = []; });
  afterEach(() => {
    for (const { database } of contexts) if (database.open) database.close();
  });

  it("preserves fuzzy time instead of inventing a precise date", () => {
    expect(parseConservativeTemporalValue("事情大约 9 月发生")).toEqual({ kind: "relative", text: "大约 9 月" });
    expect(parseConservativeTemporalValue("发生于 2026年9月12日")).toEqual({ kind: "date", value: "2026-09-12" });
    expect(parseConservativeTemporalValue("错误日期 2026年99月99日")).toEqual({ kind: "unknown" });
    expect(parseConservativeTemporalValue("没有时间信息")).toEqual({ kind: "unknown" });
  });

  it("persists a real workspace default legal jurisdiction", () => {
    const context = testContext();
    contexts.push(context);
    expect(context.application.getDefaultLegalJurisdiction()).toBe("中国大陆");
    expect(context.application.setDefaultLegalJurisdiction(" 新加坡 ")).toBe("新加坡");
    expect(context.application.getDefaultLegalJurisdiction()).toBe("新加坡");
    expect(() => context.application.setDefaultLegalJurisdiction("\u0000invalid"))
      .toThrowError(AppError);
  });

  it("keeps the raw message when record generation fails", async () => {
    const failing: EventDraftGeneratorPort = {
      identity: "test.failure", version: 1,
      async generate() { throw new AppError("INTERNAL_ERROR", "generator unavailable", true); }
    };
    const context = testContext(failing);
    contexts.push(context);
    const conversation = context.application.createConversation("Inbox");
    const result = await context.application.sendMessage({
      conversationId: conversation.id, content: "A durable raw message", intent: "record"
    });
    expect(result.event).toBeUndefined();
    expect(result.eventError?.code).toBe("INTERNAL_ERROR");
    expect(context.application.listMessages(conversation.id)[0]?.content).toBe("A durable raw message");
    expect(context.application.searchEvents({})).toEqual([]);
  });

  it("saves source intent without creating an event", async () => {
    const context = testContext();
    contexts.push(context);
    const conversation = context.application.createConversation("Inbox");
    const result = await context.application.sendMessage({
      conversationId: conversation.id, content: "Keep this original text", intent: "source"
    });
    expect(result.event).toBeUndefined();
    expect(result.eventError).toBeUndefined();
    expect(context.application.listMessages(conversation.id)[0]?.content).toBe("Keep this original text");
    expect(context.application.searchEvents({})).toEqual([]);
  });

  it("creates a sourced confirmed record and resolves its clarification with a revision", async () => {
    const context = testContext();
    contexts.push(context);
    const conversation = context.application.createConversation("Inbox");
    const result = await context.application.sendMessage({
      conversationId: conversation.id, content: "Someone removed my name from the report", intent: "record"
    });
    expect(result.event?.status).toBe("confirmed");
    expect(result.event?.occurredAt).toEqual({ kind: "unknown" });
    expect(result.event?.sourceRefs).toEqual([result.message.sourceItemId]);
    const clarification = context.application.listClarifications(result.event!.id)[0]!;
    const updated = context.application.answerClarification({
      clarificationId: clarification.id, answer: "Around September", expectedRevision: 1
    });
    expect(updated.currentRevision).toBe(2);
    expect(updated.completeness.openClarificationCount).toBe(0);
    expect(context.application.listEventRevisions(updated.id)).toHaveLength(2);
    expect(context.database.prepare("SELECT content FROM source_items WHERE id = ?").get(updated.sourceRefs.at(-1))).toEqual({
      content: "Around September"
    });
  });

  it("rejects stale edits without overwriting the current projection", async () => {
    const context = testContext();
    contexts.push(context);
    const conversation = context.application.createConversation("Inbox");
    const recorded = await context.application.sendMessage({ conversationId: conversation.id, content: "Event text", intent: "record" });
    const event = recorded.event!;
    const fields = {
      title: "Edited once", status: event.status, occurredAt: event.occurredAt,
      facts: event.facts, interpretations: event.interpretations, emotions: event.emotions,
      interests: event.interests, participants: event.participants,
      sourceRefs: event.sourceRefs, assetRefs: event.assetRefs
    };
    context.application.updateEvent({ eventId: event.id, expectedRevision: 1, reason: "first edit", ...fields });
    expect(() => context.application.updateEvent({
      eventId: event.id, expectedRevision: 1, reason: "stale edit", ...fields, title: "Stale"
    })).toThrow(/changed/);
    expect(context.application.getEvent(event.id).event.title).toBe("Edited once");
  });

  it("previews only allowlisted assets within the memory limit", async () => {
    const context = testContext();
    contexts.push(context);
    const now = "2026-08-24T00:00:00.000Z";
    context.session.assets.upsert({
      id: "asset-text", sha256: "a".repeat(64), byteSize: 4, mimeType: "text/plain",
      originalFileName: "note.txt", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    expect(Buffer.from((await context.application.previewAsset("asset-text")).bytes).toString("utf8")).toBe("test");
    context.session.assets.upsert({
      id: "asset-html", sha256: "b".repeat(64), byteSize: 4, mimeType: "text/html",
      originalFileName: "unsafe.html", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    await expect(context.application.previewAsset("asset-html")).rejects.toMatchObject({
      code: "ASSET_PREVIEW_UNAVAILABLE"
    });
    context.session.assets.upsert({
      id: "asset-large", sha256: "c".repeat(64), byteSize: 64 * 1024 * 1024 + 1, mimeType: "video/mp4",
      originalFileName: "large.mp4", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    await expect(context.application.previewAsset("asset-large")).rejects.toMatchObject({
      code: "ASSET_PREVIEW_UNAVAILABLE"
    });
  });
});

describe("Phase 2 historical backfill application", () => {
  function importedEntry(
    content: string,
    modifiedDate = "2026-01-02T00:00:00.000Z",
    id = "DAYONE-ENTRY-1",
    tags = ["work"]
  ): NormalizedDayOneEntry {
    return {
      externalId: `uuid:${id.toLocaleLowerCase("en-US")}`, entryUuid: id, fingerprint: "f".repeat(64),
      creationDate: "2026-01-01T00:00:00.000Z", journalDate: "2026-01-01", modifiedDate, timeZone: "Asia/Shanghai",
      text: content, tags, media: [], contentHash: Buffer.from(`${content}:${modifiedDate}`).toString("hex").padEnd(64, "0").slice(0, 64),
      raw: { uuid: id, creationDate: "2026-01-01T00:00:00.000Z", modifiedDate, text: content, tags }
    };
  }

  it("keeps repeated imports idempotent and appends a source version for changes", () => {
    const context = testContext();
    const now = "2026-08-24T00:00:00.000Z";
    context.session.assets.upsert({
      id: "archive-asset", sha256: "d".repeat(64), byteSize: 10, mimeType: "application/zip",
      originalFileName: "DayOne.zip", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    const run: ImportRun = {
      id: "import-run-1", archiveAssetId: "archive-asset", archiveFileName: "DayOne.zip", state: "succeeded", progress: 1,
      counts: { totalEntries: 1, newEntries: 1, updatedEntries: 0, skippedEntries: 0, mediaImported: 0, mediaMissing: 0, errorCount: 0 },
      createdAt: now, updatedAt: now, finishedAt: now
    };
    context.session.dayOne.createImportRun(run);
    const first = context.session.dayOne.upsertEntry(run.id, importedEntry("First version"), now);
    const repeated = context.session.dayOne.upsertEntry(run.id, importedEntry("First version"), now);
    const updated = context.session.dayOne.upsertEntry(run.id, importedEntry("Changed version", "2026-01-03T00:00:00.000Z"), now);
    expect(first.outcome).toBe("new");
    expect(repeated.outcome).toBe("skipped");
    expect(updated.outcome).toBe("updated");
    expect(updated.sourceVersion.version).toBe(2);
    expect(context.database.prepare("SELECT count(*) AS count FROM source_versions").get()).toEqual({ count: 2 });
    expect(context.database.prepare("SELECT count(*) AS count FROM source_search_documents").get()).toEqual({ count: 1 });
    expect(context.database.prepare("SELECT content FROM source_search_documents").get()).toEqual({ content: "Changed version" });

    const repeatedRun = { ...run, id: "import-run-1-repeat", counts: { ...run.counts, newEntries: 0, skippedEntries: 1 } };
    context.session.dayOne.createImportRun(repeatedRun);
    expect(context.session.dayOne.upsertEntry(
      repeatedRun.id, importedEntry("Changed version", "2026-01-03T00:00:00.000Z"), now
    ).outcome).toBe("skipped");
    const scoped = context.application.startBackfill({ importRunId: repeatedRun.id, tags: [], batchSize: 25 });
    expect(scoped.totalItems).toBe(1);
    context.database.close();
  });

  it("creates a traceable candidate, preserves relative time, and supports review and merge", async () => {
    const context = testContext();
    const now = "2026-08-24T00:00:00.000Z";
    context.session.assets.upsert({
      id: "archive-asset", sha256: "e".repeat(64), byteSize: 10, mimeType: "application/zip",
      originalFileName: "DayOne.zip", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    const run: ImportRun = {
      id: "import-run-2", archiveAssetId: "archive-asset", archiveFileName: "DayOne.zip", state: "succeeded", progress: 1,
      counts: { totalEntries: 3, newEntries: 3, updatedEntries: 0, skippedEntries: 0, mediaImported: 0, mediaMissing: 0, errorCount: 0 },
      createdAt: now, updatedAt: now, finishedAt: now
    };
    context.session.dayOne.createImportRun(run);
    context.session.dayOne.upsertEntry(run.id, importedEntry("上次那件事让我很在意"), now);
    context.session.dayOne.upsertEntry(run.id, importedEntry(
      "2026年1月2日明确发生的记录", "2026-01-03T00:00:00.000Z", "DAYONE-ENTRY-CONFIRM"
    ), now);
    context.session.dayOne.upsertEntry(run.id, importedEntry(
      "Ordinary journal record", "2026-01-04T00:00:00.000Z", "DAYONE-ENTRY-IGNORE"
    ), now);
    const backfill = context.application.startBackfill({ importRunId: run.id, tags: ["work"], batchSize: 25 });
    await context.application.runBackfill(backfill.id, { signal: new AbortController().signal, reportProgress() {} });
    const allCandidates = context.application.listCandidates();
    const candidate = allCandidates.find(({ event }) => event.title.includes("上次"))!;
    expect(candidate.event.occurredAt).toEqual({ kind: "relative", text: "上次" });
    expect(candidate.extraction.temporalBasis).toBe("relative");
    expect(candidate.event.facts).toEqual([]);
    expect(context.application.getCandidate(candidate.event.id).excerpt).toContain("那件事");
    expect(context.application.getEvent(candidate.event.id).clarifications).toHaveLength(1);

    const confirmable = allCandidates.find(({ event }) => event.title.includes("明确发生"))!;
    expect(confirmable.event.occurredAt).toEqual({ kind: "date", value: "2026-01-02" });
    expect(confirmable.extraction.temporalBasis).toBe("source-text");
    expect(() => context.application.updateEvent({
      eventId: confirmable.event.id, expectedRevision: 1, reason: "bypass review",
      title: confirmable.event.title, status: "confirmed", occurredAt: confirmable.event.occurredAt,
      ...(confirmable.event.narrative ? { narrative: confirmable.event.narrative } : {}),
      facts: [], interpretations: [], emotions: [], interests: [],
      participants: [], sourceRefs: confirmable.event.sourceRefs, assetRefs: []
    })).toThrowError(expect.objectContaining({ code: "CANDIDATE_STATE_CONFLICT" }));
    expect(context.application.confirmCandidate(confirmable.event.id, 1).status).toBe("confirmed");
    expect(context.application.getCandidate(confirmable.event.id).extraction.reviewState).toBe("confirmed");
    expect(() => context.application.confirmCandidate(confirmable.event.id, 2)).toThrowError(
      expect.objectContaining({ code: "CANDIDATE_STATE_CONFLICT" })
    );

    const ignorable = allCandidates.find(({ event }) => event.title.includes("Ordinary"))!;
    expect(ignorable.extraction.temporalBasis).toBe("journal-date");
    expect(context.application.ignoreCandidate(ignorable.event.id, 1).status).toBe("archived");
    expect(context.application.getCandidate(ignorable.event.id).extraction.reviewState).toBe("ignored");
    expect(() => context.application.confirmEvent(ignorable.event.id, 2)).toThrowError(
      expect.objectContaining({ code: "CANDIDATE_STATE_CONFLICT" })
    );

    const target = context.application.createEvent({
      title: "Existing event", status: "confirmed", occurredAt: { kind: "date", value: "2026-01-01" },
      facts: [], interpretations: [], emotions: [], interests: [], participants: [], sourceRefs: [], assetRefs: [], reason: "test"
    });
    const merged = context.application.mergeCandidate({
      candidateEventId: candidate.event.id, candidateExpectedRevision: 1,
      targetEventId: target.id, targetExpectedRevision: 1
    });
    expect(merged.candidate.status).toBe("archived");
    expect(merged.target.sourceRefs).toContain(candidate.journalEntry.sourceItemId);
    expect(context.application.listCandidates()).toEqual([]);
    context.database.close();
  });

  it("does not create a candidate for an entry containing only media placeholders", async () => {
    const context = testContext();
    const now = "2026-08-24T00:00:00.000Z";
    context.session.assets.upsert({
      id: "archive-placeholders", sha256: "3".repeat(64), byteSize: 10, mimeType: "application/zip",
      originalFileName: "DayOne.zip", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    const run: ImportRun = {
      id: "import-placeholders", archiveAssetId: "archive-placeholders", archiveFileName: "DayOne.zip", state: "succeeded", progress: 1,
      counts: { totalEntries: 1, newEntries: 1, updatedEntries: 0, skippedEntries: 0, mediaImported: 0, mediaMissing: 0, errorCount: 0 },
      createdAt: now, updatedAt: now, finishedAt: now
    };
    context.session.dayOne.createImportRun(run);
    context.session.dayOne.upsertEntry(run.id, importedEntry(
      "![](dayone-moment://PHOTO-1)\n{% photo PHOTO-1 %}\n[{attachment}]", undefined, "PLACEHOLDERS"
    ), now);
    const backfill = context.application.startBackfill({ importRunId: run.id, tags: [], batchSize: 25 });
    await context.application.runBackfill(backfill.id, { signal: new AbortController().signal, reportProgress() {} });
    expect(context.session.dayOne.getBackfillRun(backfill.id)).toMatchObject({ state: "completed", candidateCount: 0 });
    expect(context.application.listCandidates()).toEqual([]);
    context.database.close();
  });

  it("supersedes an unreviewed candidate when a newer source version arrives", async () => {
    const context = testContext();
    const now = "2026-08-24T00:00:00.000Z";
    context.session.assets.upsert({
      id: "archive-supersede", sha256: "1".repeat(64), byteSize: 10, mimeType: "application/zip",
      originalFileName: "DayOne.zip", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    const run: ImportRun = {
      id: "import-supersede", archiveAssetId: "archive-supersede", archiveFileName: "DayOne.zip", state: "succeeded", progress: 1,
      counts: { totalEntries: 1, newEntries: 1, updatedEntries: 0, skippedEntries: 0, mediaImported: 0, mediaMissing: 0, errorCount: 0 },
      createdAt: now, updatedAt: now, finishedAt: now
    };
    context.session.dayOne.createImportRun(run);
    context.session.dayOne.upsertEntry(run.id, importedEntry("Original candidate"), now);
    const backfill = context.application.startBackfill({ importRunId: run.id, tags: [], batchSize: 25 });
    await context.application.runBackfill(backfill.id, { signal: new AbortController().signal, reportProgress() {} });
    const candidate = context.application.listCandidates()[0]!;

    context.session.dayOne.upsertEntry(
      run.id, importedEntry("Revised candidate", "2026-01-03T00:00:00.000Z"), "2026-08-24T01:00:00.000Z"
    );
    expect(context.application.listCandidates()).toEqual([]);
    expect(context.application.getEvent(candidate.event.id).event.status).toBe("archived");
    expect(context.application.getCandidate(candidate.event.id).extraction.reviewState).toBe("superseded");
    expect(context.application.listEventRevisions(candidate.event.id)).toHaveLength(2);
    context.database.close();
  });

  it("processes bounded batches and pauses after the current item before resuming from its cursor", async () => {
    const context = testContext();
    const now = "2026-08-24T00:00:00.000Z";
    context.session.assets.upsert({
      id: "archive-batches", sha256: "2".repeat(64), byteSize: 10, mimeType: "application/zip",
      originalFileName: "DayOne.zip", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    const run: ImportRun = {
      id: "import-batches", archiveAssetId: "archive-batches", archiveFileName: "DayOne.zip", state: "succeeded", progress: 1,
      counts: { totalEntries: 26, newEntries: 26, updatedEntries: 0, skippedEntries: 0, mediaImported: 0, mediaMissing: 0, errorCount: 0 },
      createdAt: now, updatedAt: now, finishedAt: now
    };
    context.session.dayOne.createImportRun(run);
    for (let index = 0; index < 26; index += 1) {
      context.session.dayOne.upsertEntry(run.id, importedEntry(`Entry ${index}`, undefined, `ENTRY-${index}`), now);
    }
    const backfill = context.application.startBackfill({ importRunId: run.id, tags: [], batchSize: 25 });
    await context.application.runBackfill(backfill.id, { signal: new AbortController().signal, reportProgress() {} });
    expect(context.session.dayOne.getBackfillRun(backfill.id)).toMatchObject({ state: "queued", processedItems: 25 });
    await context.application.runBackfill(backfill.id, { signal: new AbortController().signal, reportProgress() {} });
    expect(context.session.dayOne.getBackfillRun(backfill.id)).toMatchObject({ state: "completed", processedItems: 26 });
    expect(context.application.listCandidates()).toHaveLength(26);

    const paused = context.application.startBackfill({ importRunId: run.id, tags: [], batchSize: 25 });
    let requestedPause = false;
    await context.application.runBackfill(paused.id, {
      signal: new AbortController().signal,
      reportProgress() {
        if (!requestedPause) {
          requestedPause = true;
          context.application.pauseBackfill(paused.id);
        }
      }
    });
    expect(context.session.dayOne.getBackfillRun(paused.id)).toMatchObject({ state: "paused", processedItems: 1 });
    context.application.resumeBackfill(paused.id);
    await context.application.runBackfill(paused.id, { signal: new AbortController().signal, reportProgress() {} });
    expect(context.session.dayOne.getBackfillRun(paused.id)).toMatchObject({ state: "completed", processedItems: 26 });
    expect(context.application.listCandidates()).toHaveLength(26);
    context.database.close();
  });
});

describe("Phase 3 relations, retrieval, and review application", () => {
  it("merges duplicate identities without rewriting events and can revert the merge", () => {
    const context = testContext();
    const first = context.application.createPerson("Alexander Zhang");
    const second = context.application.createPerson("Alex");
    const alias = context.application.addPersonAlias({ personId: first.id, value: "Alex" });
    const event = context.application.createEvent({
      title: "Attribution conversation", status: "confirmed", occurredAt: { kind: "date", value: "2026-01-04" },
      narrative: "Alex discussed attribution.", facts: [], interpretations: [], emotions: [], interests: [],
      participants: [{ personId: first.id }], sourceRefs: [], assetRefs: [], reason: "test"
    });
    const suggestion = context.application.listPersonMergeSuggestions().find(({ status }) => status === "pending")!;
    expect(suggestion.basis.join(" ")).toContain("Alex");
    const merge = context.application.mergePeople({
      sourcePersonId: first.id, targetPersonId: second.id, suggestionId: suggestion.id
    });
    const identity = context.application.getPersonIdentity(second.id);
    expect(identity.identities.map(({ id }) => id).sort()).toEqual([first.id, second.id].sort());
    expect(identity.events.map(({ id }) => id)).toContain(event.id);
    expect(context.application.getEvent(event.id).event.participants).toEqual([{ personId: first.id }]);
    expect(() => context.application.mergePeople({ sourcePersonId: second.id, targetPersonId: first.id }))
      .toThrow(/already resolve/);
    context.application.revertPersonMerge(merge.id);
    expect(context.application.getPersonIdentity(first.id).identities).toHaveLength(1);
    expect(context.application.getPersonIdentity(first.id).aliases.find(({ id }) => id === alias.id)?.status).toBe("active");
    context.database.close();
  });

  it("preserves rejected relation decisions and grounds reviews in event revisions and sources", () => {
    const context = testContext();
    const person = context.application.createPerson("Alex");
    const create = (title: string, date: string) => context.application.createEvent({
      title, status: "confirmed", occurredAt: { kind: "date", value: date }, narrative: `${title} about report attribution`,
      facts: [], interpretations: [], emotions: [],
      interests: [{ id: `interest-${date}`, label: "Attribution", sourceRefs: [] }],
      participants: [{ personId: person.id }], sourceRefs: [], assetRefs: [], reason: "test"
    });
    const first = create("First report issue", "2026-01-04");
    const second = create("Second report issue", "2026-01-20");
    const suggestions = context.application.refreshRelationSuggestions();
    const similar = suggestions.find(({ kind }) => kind === "similar")!;
    context.application.rejectEventRelation(similar.id);
    context.application.updateEvent({
      eventId: first.id, expectedRevision: first.currentRevision, title: `${first.title} updated`, status: first.status,
      occurredAt: first.occurredAt, ...(first.narrative ? { narrative: first.narrative } : {}), facts: first.facts,
      interpretations: first.interpretations, emotions: first.emotions, interests: first.interests,
      participants: first.participants, sourceRefs: first.sourceRefs, assetRefs: first.assetRefs, reason: "reorder events"
    });
    context.application.refreshRelationSuggestions();
    expect(context.session.memory.getEventRelation(similar.id)?.status).toBe("rejected");
    expect(context.session.memory.listEventRelations(undefined, true).filter(({ kind }) => kind === "similar")).toHaveLength(1);

    const review = context.application.generateReview({ from: "2026-01-01", to: "2026-01-31" });
    expect(review.patterns.some(({ kind }) => kind === "person")).toBe(true);
    expect(review.patterns.every(({ eventRevisionRefs, sourceRefs }) => eventRevisionRefs.length >= 2 && sourceRefs.length >= 2)).toBe(true);
    expect(review.eventIds.sort()).toEqual([first.id, second.id].sort());
    expect(review.patterns.some(({ kind, title }) => kind === "relation" && title.includes("similar"))).toBe(false);
    const timeline = context.application.queryTimeline({ personId: person.id, from: "2026-01-01", to: "2026-01-31" });
    expect(timeline.total).toBe(2);
    expect(timeline.groups[0]?.key).toBe("2026-01");
    context.database.close();
  });

  it("sorts and updates the global clarification inbox by explicit priority", async () => {
    const context = testContext();
    const conversation = context.application.createConversation("Clarifications");
    const first = await context.application.sendMessage({ conversationId: conversation.id, content: "First unknown event", intent: "record" });
    const second = await context.application.sendMessage({ conversationId: conversation.id, content: "Second unknown event", intent: "record" });
    const firstClarification = context.application.listClarifications(first.event!.id)[0]!;
    const secondClarification = context.application.listClarifications(second.event!.id)[0]!;
    context.application.setClarificationPriority(firstClarification.id, "important");
    context.application.setClarificationPriority(secondClarification.id, "rights_related");
    expect(context.application.listClarifications().slice(0, 2).map(({ id }) => id))
      .toEqual([secondClarification.id, firstClarification.id]);
    context.database.close();
  });

  it("unifies Event and current Day One source search with traceable source details", async () => {
    const context = testContext();
    const event = context.application.createEvent({
      title: "Unique event memory", status: "confirmed", occurredAt: { kind: "date", value: "2026-01-01" },
      narrative: "A uniquely searchable event.", facts: [], interpretations: [], emotions: [], interests: [],
      participants: [], sourceRefs: [], assetRefs: [], reason: "test"
    });
    const now = "2026-08-24T00:00:00.000Z";
    context.session.assets.upsert({
      id: "phase3-archive", sha256: "3".repeat(64), byteSize: 10, mimeType: "application/zip",
      originalFileName: "DayOne.zip", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    const run: ImportRun = {
      id: "phase3-import", archiveAssetId: "phase3-archive", archiveFileName: "DayOne.zip", state: "succeeded", progress: 1,
      counts: { totalEntries: 1, newEntries: 1, updatedEntries: 0, skippedEntries: 0, mediaImported: 0, mediaMissing: 0, errorCount: 0 },
      createdAt: now, updatedAt: now, finishedAt: now
    };
    context.session.dayOne.createImportRun(run);
    const imported = context.session.dayOne.upsertEntry(run.id, {
      externalId: "uuid:phase3", entryUuid: "PHASE3", fingerprint: "4".repeat(64),
      creationDate: "2026-01-02T00:00:00.000Z", journalDate: "2026-01-02", tags: [], media: [],
      text: "Historical unique journal memory", contentHash: "5".repeat(64), raw: { text: "Historical unique journal memory" }
    }, now);
    const hits = await context.application.unifiedSearch({ text: "unique", semantic: false });
    expect(hits.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["event", "journal_entry"]));
    expect(hits.find(({ eventId }) => eventId === event.id)).toBeDefined();
    const source = context.application.getSourceReference(imported.sourceVersion.sourceItemId);
    expect(source).toMatchObject({ kind: "journal_entry", sourceVersion: 1, contentHash: "5".repeat(64) });
    expect(source.excerpt).toContain("Historical unique");
    context.database.close();
  });

  it("builds embedding generations atomically and keeps the active generation after a failed rebuild", async () => {
    let fail = false;
    const adapter: EmbeddingAdapterPort = {
      identity: "test.embedding", version: 1, dimensions: 3,
      async embed(texts) {
        if (fail) throw new Error("adapter failed");
        return texts.map((text) => new Float32Array([
          text.toLocaleLowerCase().includes("unique") ? 1 : 0,
          text.toLocaleLowerCase().includes("other") ? 1 : 0,
          0.25
        ]));
      }
    };
    const context = testContext(undefined, adapter);
    for (let index = 0; index < 205; index += 1) {
      context.application.createEvent({
        title: `Other semantic memory ${index}`, status: "confirmed",
        occurredAt: { kind: "date", value: "2026-01-01" }, narrative: "An other semantic document",
        facts: [], interpretations: [], emotions: [], interests: [], participants: [], sourceRefs: [], assetRefs: [], reason: "test"
      });
    }
    const event = context.application.createEvent({
      title: "Unique semantic memory", status: "confirmed", occurredAt: { kind: "date", value: "2026-01-01" },
      narrative: "A semantic document", facts: [], interpretations: [], emotions: [], interests: [],
      participants: [], sourceRefs: [], assetRefs: [], reason: "test"
    });
    expect(context.application.getEmbeddingStatus()).toMatchObject({ available: true, enabled: true, state: "empty" });
    const [firstJob] = context.application.ensureAutomaticFeatures();
    expect(firstJob).toBeDefined();
    if (!firstJob) throw new Error("Automatic embedding rebuild was not scheduled");
    const firstGenerationId = (firstJob.payload as { generationId: string }).generationId;
    await context.application.runEmbeddingRebuild(firstGenerationId, {
      signal: new AbortController().signal, reportProgress() {}
    });
    expect(context.application.getEmbeddingStatus()).toMatchObject({ state: "ready", activeGenerationId: firstGenerationId });
    const hits = await context.application.unifiedSearch({ text: "unique", semantic: true });
    expect(hits[0]?.eventId).toBe(event.id);

    fail = true;
    const secondJob = context.application.rebuildEmbeddings();
    await expect(context.application.runEmbeddingRebuild(
      (secondJob.payload as { generationId: string }).generationId,
      { signal: new AbortController().signal, reportProgress() {} }
    )).rejects.toThrow("adapter failed");
    expect(context.application.getEmbeddingStatus()).toMatchObject({ state: "ready", activeGenerationId: firstGenerationId });
    context.database.close();
  });
});
