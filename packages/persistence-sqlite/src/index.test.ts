import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS, SqliteJobRepository, openDatabase, runMigrations } from "./index";

describe("SQLite foundation", () => {
  it("applies migrations repeatedly and configures durable pragmas", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-db-"));
    try {
      const database = await openDatabase(join(root, "db", "test.sqlite3"));
      runMigrations(database);
      expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 1 });
      database.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a changed migration checksum", () => {
    const database = new Database(":memory:");
    runMigrations(database);
    const changed = [{ ...DEFAULT_MIGRATIONS[0]!, sql: `${DEFAULT_MIGRATIONS[0]!.sql}\n-- changed` }];
    expect(() => runMigrations(database, changed)).toThrow(/checksum/);
    database.close();
  });

  it("recovers expired leases and preserves attempt history", () => {
    const database = new Database(":memory:");
    runMigrations(database);
    const jobs = new SqliteJobRepository(database);
    const queued = jobs.enqueue("asset.verify", { assetId: "asset-1" }, "2026-01-01T00:00:00.000Z");
    const first = jobs.claimNext("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:30.000Z");
    expect(first?.id).toBe(queued.id);
    expect(first?.attempts).toBe(1);

    const recovered = jobs.claimNext("2026-01-01T00:00:31.000Z", "2026-01-01T00:01:01.000Z");
    expect(recovered?.attempts).toBe(2);
    const attempts = database.prepare("SELECT outcome FROM job_attempts ORDER BY attempt_number").all();
    expect(attempts).toEqual([{ outcome: "abandoned" }, { outcome: null }]);
    database.close();
  });

  it("allows a failed job to start a new manual retry cycle without reusing attempt numbers", () => {
    const database = new Database(":memory:");
    runMigrations(database);
    const jobs = new SqliteJobRepository(database);
    const queued = jobs.enqueue("asset.verify", {}, "2026-01-01T00:00:00.000Z", 1);
    jobs.claimNext("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:30.000Z");
    jobs.fail(queued.id, "failed", "2026-01-01T00:00:01.000Z");
    const retried = jobs.retry(queued.id, "2026-01-01T00:00:02.000Z");
    expect(retried.attempts).toBe(1);
    expect(retried.maxAttempts).toBe(4);
    expect(jobs.claimNext("2026-01-01T00:00:02.000Z", "2026-01-01T00:00:32.000Z")?.attempts).toBe(2);
    database.close();
  });
});
