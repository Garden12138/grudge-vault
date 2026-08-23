import { Readable } from "node:stream";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GrudgeVaultApplication, parseConservativeTemporalValue,
  type EventDraftGeneratorPort, type ObjectVaultPort, type WorkspaceManagerPort, type WorkspaceSession
} from "./index";
import {
  runMigrations, SqliteAssetRepository, SqliteJobRepository, SqliteMemoryRepository
} from "@grudge-vault/persistence-sqlite";
import { AppError } from "@grudge-vault/shared";

function testContext(generator?: EventDraftGeneratorPort) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  const vault: ObjectVaultPort = {
    async put() { return { sha256: "a".repeat(64), byteSize: 4, vaultFormat: 1, deduplicated: false }; },
    async open() { return Readable.from(Buffer.from("test")); },
    async verify() { return true; },
    async cleanupTempFiles() {}
  };
  const session: WorkspaceSession = {
    workspace: {
      id: "00000000-0000-4000-8000-000000000001", name: "Test", rootPath: "/tmp/test",
      formatVersion: 1, createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z"
    },
    key: Buffer.alloc(32),
    assets: new SqliteAssetRepository(database), jobs: new SqliteJobRepository(database),
    memory: new SqliteMemoryRepository(database), vault,
    async backupDatabase() {}, async close() { database.close(); }
  };
  const manager: WorkspaceManagerPort = {
    current: () => session,
    async create() { return session; }, async open() { return session; },
    async createBackup() { throw new Error("unused"); }, async restoreBackup() { return session; },
    async close() {}
  };
  return { database, session, application: new GrudgeVaultApplication(manager, generator) };
}

describe("Phase 1 event recording application", () => {
  let contexts: Array<{ database: Database.Database }>;

  beforeEach(() => { contexts = []; });
  afterEach(() => {
    for (const { database } of contexts) if (database.open) database.close();
  });

  it("preserves fuzzy time instead of inventing a precise date", () => {
    expect(parseConservativeTemporalValue("事情大约 9 月发生")).toEqual({ kind: "relative", text: "大约 9 月" });
    expect(parseConservativeTemporalValue("发生于 2026年9月12日")).toEqual({ kind: "date", value: "2026-09-12" });
    expect(parseConservativeTemporalValue("没有时间信息")).toEqual({ kind: "unknown" });
  });

  it("keeps the raw message when draft generation fails", async () => {
    const failing: EventDraftGeneratorPort = {
      identity: "test.failure", version: 1,
      async generate() { throw new AppError("INTERNAL_ERROR", "generator unavailable", true); }
    };
    const context = testContext(failing);
    contexts.push(context);
    const conversation = context.application.createConversation("Inbox");
    const result = await context.application.sendMessage({
      conversationId: conversation.id, content: "A durable raw message", createDraft: true
    });
    expect(result.draft).toBeUndefined();
    expect(result.draftError?.code).toBe("INTERNAL_ERROR");
    expect(context.application.listMessages(conversation.id)[0]?.content).toBe("A durable raw message");
    expect(context.application.searchEvents({})).toEqual([]);
  });

  it("creates a sourced candidate and resolves its clarification with a revision", async () => {
    const context = testContext();
    contexts.push(context);
    const conversation = context.application.createConversation("Inbox");
    const result = await context.application.sendMessage({
      conversationId: conversation.id, content: "Someone removed my name from the report", createDraft: true
    });
    expect(result.draft?.status).toBe("candidate");
    expect(result.draft?.occurredAt).toEqual({ kind: "unknown" });
    expect(result.draft?.sourceRefs).toEqual([result.message.sourceItemId]);
    const clarification = context.application.listClarifications(result.draft!.id)[0]!;
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
    const recorded = await context.application.sendMessage({ conversationId: conversation.id, content: "Event text", createDraft: true });
    const event = recorded.draft!;
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
      originalFileName: "note.txt", vaultFormat: 1, integrityStatus: "verified", createdAt: now
    });
    expect(Buffer.from((await context.application.previewAsset("asset-text")).bytes).toString("utf8")).toBe("test");
    context.session.assets.upsert({
      id: "asset-html", sha256: "b".repeat(64), byteSize: 4, mimeType: "text/html",
      originalFileName: "unsafe.html", vaultFormat: 1, integrityStatus: "verified", createdAt: now
    });
    await expect(context.application.previewAsset("asset-html")).rejects.toMatchObject({
      code: "ASSET_PREVIEW_UNAVAILABLE"
    });
    context.session.assets.upsert({
      id: "asset-large", sha256: "c".repeat(64), byteSize: 64 * 1024 * 1024 + 1, mimeType: "video/mp4",
      originalFileName: "large.mp4", vaultFormat: 1, integrityStatus: "verified", createdAt: now
    });
    await expect(context.application.previewAsset("asset-large")).rejects.toMatchObject({
      code: "ASSET_PREVIEW_UNAVAILABLE"
    });
  });
});
