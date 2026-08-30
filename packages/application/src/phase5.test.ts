import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  runMigrations, SqliteAgentRepository, SqliteAssetRepository, SqliteDayOneRepository,
  SqliteJobRepository, SqliteMemoryRepository, SqlitePhaseFiveRepository
} from "@grudge-vault/persistence-sqlite";
import { AppError } from "@grudge-vault/shared";
import { GrudgeVaultApplication, type ObjectVaultPort, type WorkspaceManagerPort, type WorkspaceSession } from "./index";

const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");

async function context() {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-phase5-"));
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  const objects = new Map<string, Buffer>();
  const vault: ObjectVaultPort = {
    async put() { throw new Error("unused"); },
    async putStream(input) {
      const chunks: Buffer[] = [];
      for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const bytes = Buffer.concat(chunks); const hash = sha256(bytes); objects.set(hash, bytes);
      return { sha256: hash, byteSize: bytes.length, vaultFormat: 2, deduplicated: false };
    },
    async open(hash) { const bytes = objects.get(hash); if (!bytes) throw new Error("missing"); return Readable.from(bytes); },
    async verify(hash, _key, _progress, expectedByteSize) {
      const bytes = objects.get(hash); return Boolean(bytes && sha256(bytes) === hash && (expectedByteSize === undefined || bytes.length === expectedByteSize));
    },
    async exists(hash) { return objects.has(hash); }, async remove(hash) { objects.delete(hash); }, async cleanupTempFiles() {}
  };
  const memory = new SqliteMemoryRepository(database);
  const assets = new SqliteAssetRepository(database);
  const phase5 = new SqlitePhaseFiveRepository(database, memory);
  const session: WorkspaceSession = {
    workspace: { id: randomUUID(), name: "Phase 5", rootPath: root, formatVersion: 2,
      createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" },
    key: Buffer.alloc(32, 9), assets, jobs: new SqliteJobRepository(database), memory,
    agents: new SqliteAgentRepository(database), phase5, dayOne: new SqliteDayOneRepository(database, memory), vault,
    async backupDatabase() {}, async close() { database.close(); }
  };
  const manager: WorkspaceManagerPort = {
    current: () => session, async create() { return session; }, async open() { return session; },
    async createBackup() { throw new Error("unused"); }, async restoreBackup() { return session; }, async close() {}
  };
  const application = new GrudgeVaultApplication(manager, undefined, undefined, undefined, {
    pdf: { async render() { return Buffer.from("%PDF-1.4\n% deterministic test adapter\n"); } }
  });
  return { root, database, objects, session, application };
}

describe("Phase 5 Evidence and Case application", () => {
  const cleanup: Array<Awaited<ReturnType<typeof context>>> = [];
  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      if (item.database.open) item.database.close();
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("revises Cases, keeps decimal money, marks legal checks stale, and exports an independently verifiable Binder", async () => {
    const test = await context(); cleanup.push(test);
    const original = Buffer.from("unaltered evidence bytes\n");
    const hash = sha256(original); test.objects.set(hash, original);
    const assetId = randomUUID();
    test.session.assets.upsert({ id: assetId, sha256: hash, byteSize: original.length, mimeType: "text/plain",
      originalFileName: "account 1234567890.txt", vaultFormat: 2, integrityStatus: "verified",
      availabilityStatus: "available", verifiedAt: "2026-08-25T00:00:00.000Z", createdAt: "2026-08-25T00:00:00.000Z" });
    const statementId = randomUUID();
    const event = test.application.createEvent({ title: "Signed agreement", status: "confirmed",
      occurredAt: { kind: "month", value: "2026-07" }, facts: [{ id: statementId, kind: "fact.confirmed", text: "The agreement was signed.", sourceRefs: [] }],
      interpretations: [], emotions: [], interests: [], participants: [], sourceRefs: [], assetRefs: [assetId], reason: "test" });
    const created = test.application.createCase({
      title: "Agreement Case", status: "active", summary: "Call +86 138 1234 5678", jurisdiction: "CN-SH", asOfDate: "2026-08-25",
      eventRefs: [event.id], personRefs: [], sourceRefs: [], assetRefs: [assetId],
      amounts: [{ id: randomUUID(), label: "Claim", currency: "CNY", amount: "12345678901234567890.01", precision: "exact", certainty: "documented", sourceRefs: [] }],
      disputePoints: [{ id: randomUUID(), text: "Payment date is disputed", sourceRefs: [] }],
      questions: [{ id: randomUUID(), question: "Was notice delivered?", reason: "No receipt", status: "open", sourceRefs: [] }],
      materialGaps: [{ id: randomUUID(), label: "Delivery receipt", reason: "Needed for chronology", priority: "important", status: "open" }],
      evidenceLinks: [{ id: randomUUID(), assetId, eventId: event.id, statementIds: [statementId], sourceRefs: [] }], reason: "created"
    });
    expect(created.amounts[0]?.amount).toBe("12345678901234567890.01");
    const legal = await test.application.runLegalCheck(created.id);
    expect(legal.status).toBe("needs_external_verification");
    const { id: _id, currentRevision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...createdFields } = created;
    void [_id, _revision, _createdAt, _updatedAt];
    const updated = test.application.updateCase({ ...createdFields, caseId: created.id, expectedRevision: 1,
      summary: "Updated summary", reason: "revision" });
    expect(updated.currentRevision).toBe(2);
    expect(test.application.getCase(created.id).legalVerification?.stale).toBe(true);
    expect(() => test.application.updateCase({ ...createdFields, caseId: created.id, expectedRevision: 1, reason: "stale" }))
      .toThrowError(AppError);

    const preview = test.application.previewCaseBinder(created.id, {
      caseRevision: 2, eventIds: [event.id], sourceItemIds: [], assetIds: [assetId], derivedArtifactIds: [],
      includeOriginals: true, includeDerivedArtifacts: false, locale: "en",
      redactions: { personIds: [], maskAmounts: true, maskContacts: true, maskAccounts: true, maskFileNames: true, omitSourceExcerpts: true }
    });
    expect(preview.warnings.join(" ")).toMatch(/unchanged/i);
    const destination = join(test.root, "binder");
    const exported = await test.application.exportCaseBinder(preview.id, destination);
    expect(exported.fileCount).toBeGreaterThan(7);
    const manifest = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8")) as { caseRevision: number; eventRevisions: unknown[] };
    expect(manifest).toMatchObject({ caseRevision: 2 });
    expect(manifest.eventRevisions).toHaveLength(1);
    const sums = (await readFile(join(destination, "sha256sums.txt"), "utf8")).trim().split("\n");
    for (const line of sums) {
      const [expected, path] = line.split("  ", 2) as [string, string];
      expect(sha256(await readFile(join(destination, path)))).toBe(expected);
    }
    const originalPath = preview.files.find(({ classification }) => classification === "original")!.path;
    expect(await readFile(join(destination, originalPath))).toEqual(original);
  });

  it("persists integrity results, deletion impact, tombstones, and non-rewriting supersession", async () => {
    const test = await context(); cleanup.push(test);
    const first = Buffer.from("first"); const second = Buffer.from("second");
    const firstHash = sha256(first); const secondHash = sha256(second); test.objects.set(firstHash, first); test.objects.set(secondHash, second);
    const firstId = randomUUID(); const secondId = randomUUID(); const now = "2026-08-25T00:00:00.000Z";
    test.session.assets.upsert({ id: firstId, sha256: firstHash, byteSize: first.length, mimeType: "text/plain", originalFileName: "first.txt",
      vaultFormat: 2, integrityStatus: "pending", availabilityStatus: "available", createdAt: now });
    test.session.assets.upsert({ id: secondId, sha256: secondHash, byteSize: second.length, mimeType: "text/plain", originalFileName: "second.txt",
      vaultFormat: 2, integrityStatus: "pending", availabilityStatus: "available", createdAt: now });
    const event = test.application.createEvent({ title: "Referenced", status: "confirmed", occurredAt: { kind: "unknown" }, facts: [],
      interpretations: [], emotions: [], interests: [], participants: [], sourceRefs: [], assetRefs: [firstId], reason: "test" });
    const caseItem = test.application.createCase({ title: "Evidence refs", status: "draft", jurisdiction: "unspecified", asOfDate: "2026-08-25",
      eventRefs: [event.id], personRefs: [], sourceRefs: [], assetRefs: [firstId], amounts: [], disputePoints: [], questions: [], materialGaps: [], evidenceLinks: [], reason: "test" });
    const scan = test.application.startIntegrityScan();
    await test.application.runIntegrityScan(scan.id, { signal: new AbortController().signal, reportProgress() {} });
    expect(test.application.listIntegrityScans()[0]).toMatchObject({ state: "succeeded", counts: { verified: 2, missing: 0 } });
    const superseded = test.application.supersedeOriginal(firstId, secondId);
    expect(superseded.availabilityStatus).toBe("superseded");
    expect(test.application.getCase(caseItem.id).case.assetRefs).toEqual([firstId]);
    await expect(test.application.deleteOriginal(firstId, false)).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
    const deleted = await test.application.deleteOriginal(firstId, true);
    expect(deleted.availabilityStatus).toBe("deleted");
    expect(deleted.impact).toMatchObject({ eventIds: [event.id], caseIds: [caseItem.id] });
    expect(test.objects.has(firstHash)).toBe(false);

    const standalone = Buffer.from("standalone"); const standaloneHash = sha256(standalone); test.objects.set(standaloneHash, standalone);
    const standaloneId = randomUUID();
    test.session.assets.upsert({ id: standaloneId, sha256: standaloneHash, byteSize: standalone.length, mimeType: "text/plain",
      originalFileName: "standalone.txt", vaultFormat: 2, integrityStatus: "verified", availabilityStatus: "available", createdAt: now });
    const purged = await test.application.deleteOriginal(standaloneId, false);
    expect(purged.availabilityStatus).toBe("deleted");
    expect(test.objects.has(standaloneHash)).toBe(false);
    expect(test.session.assets.findById(standaloneId)).toBeUndefined();
    expect(test.application.listEvidence().some(({ asset }) => asset.id === standaloneId)).toBe(false);

    const oldTombstone = Buffer.from("old tombstone"); const oldTombstoneHash = sha256(oldTombstone);
    const oldTombstoneId = randomUUID();
    test.session.assets.upsert({ id: oldTombstoneId, sha256: oldTombstoneHash, byteSize: oldTombstone.length, mimeType: "text/plain",
      originalFileName: "old-tombstone.txt", vaultFormat: 2, integrityStatus: "verified", availabilityStatus: "deleted",
      deletedAt: now, createdAt: now });
    const cleared = await test.application.deleteOriginal(oldTombstoneId, false);
    expect(cleared.availabilityStatus).toBe("deleted");
    expect(test.session.assets.findById(oldTombstoneId)).toBeUndefined();
  });
});
