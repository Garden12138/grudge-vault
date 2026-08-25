import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  runMigrations, SqliteAgentRepository, SqliteAssetRepository, SqliteDayOneRepository, SqliteJobRepository,
  SqliteMemoryRepository, SqlitePhaseFiveRepository, SqlitePhaseSixRepository
} from "@grudge-vault/persistence-sqlite";
import type { Asset, LocalProcessorStatus, MediaProcessingSettings } from "@grudge-vault/domain";
import {
  GrudgeVaultApplication, latestCompletedMonth, latestCompletedQuarter, isoWeekScheduleKey,
  type MediaPipelinePort, type ObjectVaultPort, type WorkspaceManagerPort, type WorkspaceSession
} from "./index";

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

class FakeMediaPipeline implements MediaPipelinePort {
  settings: MediaProcessingSettings = { autoProcessNew: true, ocrLanguages: ["eng"], resourceProfile: "balanced", whisperGpu: "auto" };
  fail = false;
  private config = digest(JSON.stringify(this.settings));

  status(): LocalProcessorStatus {
    return { settings: this.settings,
      ocr: { configured: true, available: true, identity: "fake-ocr", version: "1", displayNames: ["fake"], warnings: [] },
      asr: { configured: true, available: true, identity: "fake-asr", version: "1", displayNames: ["fake"], warnings: [] },
      eligibleHistoricalAssets: 0, pendingJobs: 0 };
  }
  getSettings() { return this.settings; }
  async updateSettings(settings: MediaProcessingSettings) { this.settings = settings; this.config = digest(JSON.stringify(settings)); return this.status(); }
  async getStatus() { return this.status(); }
  async probe() { return this.status(); }
  kindFor(asset: Asset) { return asset.mimeType === "image/png" ? "ocr" as const : undefined; }
  async fingerprint(asset: Asset) {
    return { kind: "ocr" as const, processorIdentity: "fake-ocr", processorVersion: 1,
      configHash: this.config, inputHash: digest(`${asset.sha256}:${this.config}`) };
  }
  async process(input: Parameters<MediaPipelinePort["process"]>[0]) {
    if (this.fail) throw new Error("injected failure");
    const fingerprint = await this.fingerprint(input.asset);
    input.reportProgress(1);
    return { ...fingerprint, payload: {
      formatVersion: 1 as const, kind: "ocr" as const, sourceAssetId: input.asset.id, sourceSha256: input.asset.sha256,
      language: this.settings.ocrLanguages.join("+"), processorIdentity: "fake-ocr", processorVersion: 1,
      engineVersions: { fake: "1" }, configHash: fingerprint.configHash,
      text: `recognized ${fingerprint.configHash}`, pages: [{ page: 1, text: "recognized", words: [] }],
      createdAt: "2026-08-25T00:00:00.000Z"
    } };
  }
}

async function makeContext() {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-phase6-"));
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  const objects = new Map<string, Buffer>();
  const vault: ObjectVaultPort = {
    async put() { throw new Error("unused"); },
    async putStream(input) {
      const chunks: Buffer[] = [];
      for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const bytes = Buffer.concat(chunks); const sha256 = digest(bytes); objects.set(sha256, bytes);
      return { sha256, byteSize: bytes.length, vaultFormat: 2, deduplicated: false };
    },
    async open(hash) { const bytes = objects.get(hash); if (!bytes) throw new Error("missing"); return Readable.from(bytes); },
    async verify(hash) { return objects.has(hash); }, async exists(hash) { return objects.has(hash); },
    async remove(hash) { objects.delete(hash); }, async cleanupTempFiles() {}
  };
  const memory = new SqliteMemoryRepository(database);
  const assets = new SqliteAssetRepository(database);
  const session: WorkspaceSession = {
    workspace: { id: randomUUID(), name: "Phase 6", rootPath: root, formatVersion: 2,
      createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" },
    key: Buffer.alloc(32, 6), assets, jobs: new SqliteJobRepository(database), memory,
    agents: new SqliteAgentRepository(database), dayOne: new SqliteDayOneRepository(database, memory),
    phase5: new SqlitePhaseFiveRepository(database, memory), phase6: new SqlitePhaseSixRepository(database, memory), vault,
    async backupDatabase() {}, async close() { database.close(); }
  };
  const manager: WorkspaceManagerPort = { current: () => session, async create() { return session; }, async open() { return session; },
    async createBackup() { throw new Error("unused"); }, async restoreBackup() { return session; }, async close() {} };
  const pipeline = new FakeMediaPipeline();
  return { root, database, objects, session, pipeline, application: new GrudgeVaultApplication(manager, undefined, undefined, undefined, {}, pipeline) };
}

describe("Phase 6 media and continuous memory", () => {
  const cleanup: Array<Awaited<ReturnType<typeof makeContext>>> = [];
  afterEach(async () => {
    for (const item of cleanup.splice(0)) { if (item.database.open) item.database.close(); await rm(item.root, { recursive: true, force: true }); }
  });

  it("activates a new OCR version only after successful processing", async () => {
    const test = await makeContext(); cleanup.push(test);
    const original = Buffer.from("fake image bytes"); const sha256 = digest(original); test.objects.set(sha256, original);
    const asset: Asset = { id: randomUUID(), sha256, byteSize: original.length, mimeType: "image/png", originalFileName: "scan.png",
      vaultFormat: 2, integrityStatus: "verified", availabilityStatus: "available", createdAt: "2026-08-25T00:00:00.000Z" };
    test.session.assets.upsert(asset);
    const first = await test.pipeline.fingerprint(asset);
    await test.application.runMediaProcessing(asset.id, first.inputHash, { signal: new AbortController().signal, reportProgress() {} });
    const firstArtifact = test.session.phase6!.getCurrentDerivedArtifact(asset.id, "ocr")!;
    expect((await test.application.getDerivedArtifactDetail(firstArtifact.id)).payload.text).toContain("recognized");

    await test.pipeline.updateSettings({ ...test.pipeline.settings, ocrLanguages: ["eng", "chi_sim"] });
    const second = await test.pipeline.fingerprint(asset);
    await test.application.runMediaProcessing(asset.id, second.inputHash, { signal: new AbortController().signal, reportProgress() {} });
    const secondArtifact = test.session.phase6!.getCurrentDerivedArtifact(asset.id, "ocr")!;
    expect(secondArtifact.id).not.toBe(firstArtifact.id);
    expect(test.session.phase6!.getDerivedArtifact(firstArtifact.id)?.current).toBe(false);

    test.pipeline.fail = true;
    await test.pipeline.updateSettings({ ...test.pipeline.settings, ocrLanguages: ["eng"] });
    const reused = await test.pipeline.fingerprint(asset);
    await test.application.runMediaProcessing(asset.id, reused.inputHash, {
      signal: new AbortController().signal, reportProgress() {}
    });
    expect(test.session.phase6!.getCurrentDerivedArtifact(asset.id, "ocr")?.id).toBe(firstArtifact.id);

    await test.pipeline.updateSettings({ ...test.pipeline.settings, ocrLanguages: ["deu"] });
    const failed = await test.pipeline.fingerprint(asset);
    await expect(test.application.runMediaProcessing(asset.id, failed.inputHash, {
      signal: new AbortController().signal, reportProgress() {}
    })).rejects.toThrow(/injected failure/);
    expect(test.session.phase6!.getCurrentDerivedArtifact(asset.id, "ocr")?.id).toBe(firstArtifact.id);
    expect(await readdir(join(test.root, "vault", "tmp"))).toEqual([]);
  });

  it("uses bounded stable schedule keys and creates each due review reminder once", async () => {
    const test = await makeContext(); cleanup.push(test);
    expect(latestCompletedMonth(new Date(2026, 0, 3))).toEqual({ key: "review:month:2025-12", from: "2025-12-01", to: "2025-12-31" });
    expect(latestCompletedQuarter(new Date(2026, 0, 3))).toEqual({ key: "review:quarter:2025-Q4", from: "2025-10-01", to: "2025-12-31" });
    expect(isoWeekScheduleKey(new Date(2026, 0, 1))).toBe("clarifications:week:2026-W01");
    test.application.createEvent({ title: "July event", status: "confirmed", occurredAt: { kind: "date", value: "2026-07-12" },
      facts: [], interpretations: [], emotions: [], interests: [], participants: [], sourceRefs: [], assetRefs: [], reason: "test" });
    const first = test.application.runReviewAutomation(new Date(2026, 7, 25, 9));
    expect(first.map(({ kind }) => kind)).toContain("monthly_review");
    expect(test.session.phase6!.getAutomationRun("clarifications:week:2026-W35")).toBeUndefined();
    expect(test.application.runReviewAutomation(new Date(2026, 7, 25, 10))).toEqual([]);
    expect(test.application.listReminders().filter(({ kind }) => kind === "monthly_review")).toHaveLength(1);
  });
});
