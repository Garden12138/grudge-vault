import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrudgeVaultApplication, type KeyProtectorPort, type NativeImageConversionPort, type RecordEmbeddingPort } from "@grudge-vault/application";
import { LocalWorkspaceManager } from "./workspace-manager";

// Synthetic protection avoids touching the user's keychain. The workspace still uses real encrypted storage.
const protector: KeyProtectorPort = {
  async assertAvailable() {},
  async protect(key) { return `synthetic:${key.toString("base64")}`; },
  async unprotect(envelope) {
    if (!envelope.startsWith("synthetic:")) throw new Error("Invalid synthetic envelope");
    return { key: Buffer.from(envelope.slice(10), "base64") };
  }
};

describe("index builds and queries use the live application configuration identity", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { vi.restoreAllMocks(); while (cleanups.length) await cleanups.pop()!(); });

  async function fixture(count = 1, nativeImage?: NativeImageConversionPort) {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-index-config-"));
    const manager = new LocalWorkspaceManager(protector, join(root, "state.json"));
    cleanups.push(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
    const embedding: RecordEmbeddingPort = {
      identity: "synthetic:no-network", version: 1, dimensions: 2, inputModalities: ["text", "image"], isConfigured: () => true,
      async embed(inputs) { return inputs.map(() => new Float32Array([1, 0])); }
    };
    const app = new GrudgeVaultApplication(manager, undefined, undefined, undefined, {}, undefined, embedding, undefined, nativeImage);
    await app.createWorkspace(join(root, "workspace"), "Synthetic index configuration");
    const connection = { provider: "bailian" as const, model: "synthetic:analysis-model", region: "cn-beijing" as const, apiKey: "synthetic-key-not-a-credential" };
    const testedAt = "2026-09-28T00:00:00.000Z";
    app.saveLlmConnection(connection, testedAt);
    for (let index = 0; index < count; index++) {
      const draft = await app.prepareIntake({ text: `合成工资争议，仅供配置生命周期测试 ${index}` });
      await app.screenAndSaveIntake(draft.sessionId, randomUUID(), { async screen() {
        return { decision: "include", categories: ["rights"], reason: "合成权益记录", anchors: [], coverage: "complete", policyVersion: "synthetic-v1" };
      } });
    }
    app.setRecordSearchIndexEnabled(true);
    const first = await app.rebuildRecordSearchIndex();
    const records = manager.current()!.records!;
    const writes = vi.spyOn(records, "putSearchEmbedding"), activates = vi.spyOn(records, "activateSearchGeneration");
    let begin!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    let failResponse = false;
    const embed = vi.spyOn(embedding, "embed").mockImplementationOnce(async (inputs) => {
      begin(); await released;
      if (failResponse) throw new Error("Synthetic remote failure");
      return inputs.map(() => new Float32Array([1, 0]));
    });
    const imagePath = join(root, "synthetic-query.png");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=", "base64"));
    return { app, manager, records, writes, activates, embedding, embed, started, release, connection, testedAt, imagePath, root, originalId: first.activeGenerationId,
      failResponse() { failResponse = true; } };
  }

  it.each(["pause-resume", "credential-rotation", "new-connection-test"] as const)(
    "rejects a late result after %s even when the embedding adapter still reports configured", async (action) => {
      const test = await fixture();
      const outcome = test.app.rebuildRecordSearchIndex().then(() => undefined, (error: unknown) => error);
      await test.started;
      const replacement = test.records.listSearchGenerations().find(({ state }) => state === "building")!;
      if (action === "pause-resume") { test.app.pauseLlmProviders(); test.app.activateLlmProvider("bailian", test.testedAt); }
      if (action === "credential-rotation") test.app.saveLlmConnection({ ...test.connection, apiKey: "synthetic-rotated-key" }, test.testedAt);
      if (action === "new-connection-test") test.app.beginLlmConfigurationTest("bailian");
      test.release();
      expect(await outcome).toMatchObject({ code: "LLM_CONFIGURATION_CHANGED" });
      expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
      expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
      expect(test.records.listSearchGenerations().find(({ id }) => id === replacement.id)).toMatchObject({ state: "failed", lastError: "LLM_CONFIGURATION_CHANGED" });
      expect((await test.app.rebuildRecordSearchIndex(replacement.id)).activeGenerationId).toBe(replacement.id);
    }
  );

  it("allows an unchanged build to finish when a concurrent operation verifies another modality", async () => {
    const test = await fixture();
    const pending = test.app.rebuildRecordSearchIndex(); await test.started;
    const config = test.app.getLlmSettings().providers.bailian!;
    test.app.markLlmModalityVerified("bailian", "image", test.testedAt, {
      workspaceId: test.manager.current()!.workspace.id, configuration: config,
      credentialHash: createHash("sha256").update(test.connection.apiKey).digest("hex"), activeProvider: "bailian"
    });
    expect(test.app.getLlmSettings().providers.bailian?.capabilities?.inputModalities).toContain("image");
    test.release(); const result = await pending;
    expect(result.activeGenerationId).not.toBe(test.originalId);
    expect(test.writes).toHaveBeenCalled(); expect(test.activates).toHaveBeenCalledTimes(1);
  });

  it.each((["text", "image"] as const).flatMap((modality) =>
    (["pause-resume", "credential-rotation", "new-connection-test"] as const).map((action) => ({ modality, action }))))(
    "discards an in-flight $modality query after $action without stale results or keyword fallback", async ({ modality, action }) => {
      const test = await fixture();
      const input = modality === "image" ? { paths: [test.imagePath] } : { text: "合成工资" };
      const query = await test.app.prepareRecordSearchQuery(input);
      const outcome = test.app.executeRecordSearchQuery(query.sessionId, { limit: 5 }).then(() => undefined, (error: unknown) => error);
      await test.started;
      if (action === "pause-resume") { test.app.pauseLlmProviders(); test.app.activateLlmProvider("bailian", test.testedAt); }
      if (action === "credential-rotation") test.app.saveLlmConnection({ ...test.connection, apiKey: "synthetic-query-rotated-key" }, test.testedAt);
      if (action === "new-connection-test") test.app.beginLlmConfigurationTest("bailian");
      test.release(); expect(await outcome).toMatchObject({ code: "LLM_CONFIGURATION_CHANGED" });
      expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
      expect(test.app.getRecordSearchIndexStatus().activeGenerationId).toBe(test.originalId);
      await expect(test.app.executeRecordSearchQuery(query.sessionId, { limit: 5 })).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
      const retry = await test.app.prepareRecordSearchQuery(input);
      expect((await test.app.executeRecordSearchQuery(retry.sessionId, { limit: 5 })).hits).toHaveLength(1);
    }
  );

  it.each(["pause-resume", "credential-rotation"] as const)("invalidates cached semantic pagination after %s", async (action) => {
    const test = await fixture(3), query = await test.app.prepareRecordSearchQuery({ text: "合成工资" });
    const pending = test.app.executeRecordSearchQuery(query.sessionId, { limit: 1 });
    await test.started; test.release(); const first = await pending;
    expect(first.hits).toHaveLength(1); expect(first.nextCursor).toBeDefined();
    if (action === "pause-resume") { test.app.pauseLlmProviders(); test.app.activateLlmProvider("bailian", test.testedAt); }
    else test.app.saveLlmConnection({ ...test.connection, apiKey: "synthetic-paging-rotated-key" }, test.testedAt);
    await expect(test.app.executeRecordSearchQuery(query.sessionId, { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "LLM_CONFIGURATION_CHANGED" });
    await expect(test.app.executeRecordSearchQuery(query.sessionId, { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(test.embed).toHaveBeenCalledTimes(1);
  });

  it("does not hide a configuration change behind keyword fallback when the old model request fails", async () => {
    const test = await fixture(), query = await test.app.prepareRecordSearchQuery({ text: "合成工资" });
    const outcome = test.app.executeRecordSearchQuery(query.sessionId, { limit: 5 }).then(() => undefined, (error: unknown) => error);
    await test.started; test.failResponse(); test.app.pauseLlmProviders(); test.release();
    expect(await outcome).toMatchObject({ code: "LLM_CONFIGURATION_CHANGED" });
    expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
  });

  it("allows an unchanged query to finish after another task verifies a modality", async () => {
    const test = await fixture(), query = await test.app.prepareRecordSearchQuery({ text: "合成工资" });
    const pending = test.app.executeRecordSearchQuery(query.sessionId, { limit: 5 }); await test.started;
    test.app.markLlmModalityVerified("bailian", "image", test.testedAt, {
      workspaceId: test.manager.current()!.workspace.id, configuration: test.app.getLlmSettings().providers.bailian!,
      credentialHash: createHash("sha256").update(test.connection.apiKey).digest("hex"), activeProvider: "bailian"
    });
    test.release(); expect((await pending).hits).toHaveLength(1);
    expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
  });

  it.each(["identity", "dimensions", "inputModalities"] as const)("rejects a query adapter %s change before using its late vector", async (field) => {
    const test = await fixture(), query = await test.app.prepareRecordSearchQuery({ text: "合成工资" });
    const outcome = test.app.executeRecordSearchQuery(query.sessionId, { limit: 5 }).then(() => undefined, (error: unknown) => error);
    await test.started;
    Object.defineProperty(test.embedding, field, { value: field === "identity" ? "synthetic:another-model" : field === "dimensions" ? 3 : ["text"], configurable: true });
    test.release(); expect(await outcome).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
    expect(test.app.getRecordSearchIndexStatus().activeGenerationId).toBeUndefined();
    expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
  });

  it("does not embed a raster converted after the query configuration changed", async () => {
    let begin!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const finished = new Promise<void>((resolve) => { release = resolve; });
    const converter: NativeImageConversionPort = { async convert() {
      begin(); await finished; return { bytes: Buffer.from("synthetic-private-raster"), mimeType: "image/png", width: 32, height: 32 };
    } };
    const test = await fixture(1, converter), path = join(test.root, "synthetic-query.heic");
    const original = Buffer.alloc(64); original.write("ftyp", 4); original.write("heic", 8); await writeFile(path, original);
    const query = await test.app.prepareRecordSearchQuery({ paths: [path] });
    const outcome = test.app.executeRecordSearchQuery(query.sessionId, { limit: 5 }).then(() => undefined, (error: unknown) => error);
    await started; test.app.pauseLlmProviders(); test.app.activateLlmProvider("bailian", test.testedAt); release();
    expect(await outcome).toMatchObject({ code: "LLM_CONFIGURATION_CHANGED" }); expect(test.embed).not.toHaveBeenCalled();
    expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
  });
});
