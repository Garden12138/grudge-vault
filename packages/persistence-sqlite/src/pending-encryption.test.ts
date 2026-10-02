import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceKeyRing } from "@grudge-vault/application";
import type { PendingReview } from "@grudge-vault/domain";
import { openDatabase, SqliteRecordRepository } from "./index";

const now = "2026-09-25T00:00:00.000Z";

async function expectNoMarker(directory: string, marker: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (!name.startsWith("workspace.sqlite3")) continue;
    expect((await readFile(join(directory, name))).includes(Buffer.from(marker)), `${name} contains plaintext`).toBe(false);
  }
}

describe("sealed pending reviews", () => {
  it("keeps excerpts and locators out of SQLite and survives reopen and key rotation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grudge-vault-sealed-pending-"));
    const path = join(directory, "workspace.sqlite3");
    const oldKeyId = randomUUID();
    const newKeyId = randomUUID();
    const oldKey = Buffer.alloc(32, 11);
    const newKey = Buffer.alloc(32, 12);
    let ring: WorkspaceKeyRing = {
      activeKeyId: oldKeyId, legacyKeyId: oldKeyId, keys: new Map([[oldKeyId, oldKey]])
    };
    const marker = `pending-private-${randomUUID()}`;
    const item: PendingReview = {
      id: randomUUID(), origin: "zip", originLocator: JSON.stringify({ entryId: marker }),
      sourceVersion: "a".repeat(64), excerpt: `待核对 ${marker}`, reason: `来源不完整 ${marker}`,
      categories: ["rights"], coverage: "partial", sessionAvailable: false, createdAt: now, updatedAt: now
    };
    try {
      const database = await openDatabase(path);
      const records = new SqliteRecordRepository(database, () => ring);
      expect(records.createPending(item, randomUUID())).toEqual(item);
      const stored = database.prepare(`
        SELECT origin_locator, excerpt, reason, categories_json, sealed_payload
        FROM redesign_pending_reviews WHERE id = ?
      `).get(item.id) as Record<string, unknown>;
      expect(stored).toMatchObject({ origin_locator: null, excerpt: "", reason: "", categories_json: "[]" });
      expect(String(stored.sealed_payload)).toMatch(/^v1:/);
      expect(JSON.stringify(stored)).not.toContain(marker);
      expect(records.getPending(item.id)).toMatchObject(item);
      ring = { activeKeyId: oldKeyId, legacyKeyId: oldKeyId, keys: new Map([[oldKeyId, Buffer.alloc(32, 99)]]) };
      expect(() => records.getPending(item.id)).toThrow();

      ring = { activeKeyId: newKeyId, legacyKeyId: oldKeyId, keys: new Map([[oldKeyId, oldKey], [newKeyId, newKey]]) };
      records.reencryptPending(newKeyId);
      ring = { activeKeyId: newKeyId, legacyKeyId: newKeyId, keys: new Map([[newKeyId, newKey]]) };
      expect(records.getPending(item.id)).toMatchObject(item);
      database.close();
      await expectNoMarker(directory, marker);

      const reopened = await openDatabase(path);
      try {
        const afterRestart = new SqliteRecordRepository(reopened, () => ring);
        expect(afterRestart.listPending()).toHaveLength(1);
        expect(afterRestart.getPending(item.id)).toMatchObject(item);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("seals pre-existing plaintext pending rows and removes their recoverable database bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grudge-vault-upgrade-pending-"));
    const path = join(directory, "workspace.sqlite3");
    const key = Buffer.alloc(32, 21);
    const marker = `old-pending-${randomUUID()}`;
    const id = randomUUID();
    try {
      const database = await openDatabase(path);
      database.prepare(`
        INSERT INTO redesign_pending_reviews(
          id, origin, origin_locator, source_version, excerpt, reason, categories_json,
          coverage, created_at, updated_at
        ) VALUES (?, 'migration', ?, ?, ?, ?, '["rights"]', 'partial', ?, ?)
      `).run(id, marker, "b".repeat(64), marker, marker, now, now);
      database.close();

      const reopened = await openDatabase(path);
      try {
        const records = new SqliteRecordRepository(reopened, () => key);
        records.sealExistingPending();
        expect(records.getPending(id)).toMatchObject({ originLocator: marker, excerpt: marker, reason: marker });
        expect(reopened.prepare("SELECT origin_locator, excerpt, reason FROM redesign_pending_reviews WHERE id = ?").get(id))
          .toEqual({ origin_locator: null, excerpt: "", reason: "" });
      } finally {
        reopened.close();
      }
      await expectNoMarker(directory, marker);

      const retry = await openDatabase(path);
      try {
        retry.prepare("UPDATE redesign_pending_seal_state SET cleanup_required = 1 WHERE id = 1").run();
        const records = new SqliteRecordRepository(retry, () => key);
        records.sealExistingPending();
        expect(retry.prepare("SELECT cleanup_required FROM redesign_pending_seal_state WHERE id = 1").get())
          .toEqual({ cleanup_required: 0 });
        expect(records.getPending(id)?.excerpt).toBe(marker);
      } finally {
        retry.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
