import { openDisclosure, settingsGroup } from "./ui-helpers";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import Database from "better-sqlite3";
import { ZipFile } from "yazl";
import { SqliteJobRepository } from "../../packages/persistence-sqlite/src/index";
import { GrudgeVaultApplication, type LegalResearchInput } from "../../packages/application/src/index";
import { LocalWorkspaceManager } from "../../apps/desktop/src/main/workspace-manager";
import { DEFAULT_LOCAL_INTELLIGENCE_CONFIGURATION, SafeProcessRunner } from "../../packages/media-pipeline/src/index";
import type { LlmSettings } from "@grudge-vault/domain";
import type { IpcResult } from "@grudge-vault/shared";
import { syntheticSilentMp3 } from "../fixtures/native-media/silent-mp3";

async function pasteSyntheticPng(editor: Locator): Promise<void> {
  await editor.getByLabel("发生了什么？").evaluate((textarea) => {
    const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=";
    const bytes = Uint8Array.from(globalThis.atob(encoded), (character) => character.charCodeAt(0));
    const clipboard = new globalThis.DataTransfer();
    clipboard.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    textarea.dispatchEvent(new globalThis.ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await expect(editor.locator(".file-list")).toContainText("pasted.png");
}

async function writeSyntheticWav(path: string, seconds = 1, rate = 8_000, channels = 1): Promise<void> {
  const samples = seconds * rate;
  const bytes = Buffer.alloc(44 + samples * channels * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples * channels * 2, 40);
  for (let index = 0; index < samples; index++) for (let channel = 0; channel < channels; channel++) {
    bytes.writeInt16LE(Math.round(Math.sin(index * 0.017) * 10_000), 44 + (index * channels + channel) * 2);
  }
  await writeFile(path, bytes);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex");
}

test("shows the locked recovery screen after a failed workspace handoff and clears stale input", async () => {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-workspace-failclosed-e2e-"));
  const workspace = join(root, "workspace"), candidate = join(root, "candidate"), userData = join(root, "user-data");
  const seed = new LocalWorkspaceManager({
    async assertAvailable() {},
    async protect(key) { return `e2e:${key.toString("base64")}`; },
    async unprotect(envelope) { return { key: Buffer.from(envelope.slice(4), "base64") }; }
  }, join(root, "synthetic-seed-state.json"));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const original = (await seed.create(workspace, "合成故障恢复工作区")).workspace;
    await seed.create(candidate, "合成候选工作区"); await seed.close();
    await mkdir(userData, { recursive: true });
    const inheritedEnvironment = Object.fromEntries(Object.entries(process.env)
      .filter((item): item is [string, string] => item[1] !== undefined));
    application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
      env: { ...inheritedEnvironment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NO_NETWORK: "1",
        GRUDGE_VAULT_E2E_WORKSPACE_CLOSE_FAILURE: "1" } });
    const page = await application.firstWindow();
    await page.locator(".new-record-button").click();
    await page.getByLabel("API 密钥").fill("synthetic-lock-key");
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "测试连接并保存" }).click();
    await page.getByLabel("发生了什么？").fill("仅用于验证锁定后不恢复旧输入的合成文字");
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      (globalThis as typeof globalThis & { __gvE2eFailWorkspaceClose?: boolean }).__gvE2eFailWorkspaceClose = true;
    }, candidate);
    expect(await page.evaluate(() => window.grudgeVault.workspace.open())).toMatchObject({
      ok: false, error: { code: "CLEANUP_FAILED", message: "无法安全关闭原工作区；已锁定，请重新打开。" }
    });
    await expect(page.getByRole("button", { name: "暂时打开账本", exact: true })).toBeVisible();
    await expect(page.locator(".workspace-summary")).toContainText("合成故障恢复工作区");
    expect(await page.evaluate(() => window.grudgeVault.workspace.status())).toMatchObject({
      ok: true, data: { status: "locked", workspaceId: original.id }
    });
    expect(JSON.parse(await readFile(join(userData, "state.json"), "utf8"))).toEqual({ recentWorkspacePath: workspace });
    // A locked screen must not queue a hidden editor/search shortcut to replay after unlock.
    await page.keyboard.press("Meta+n"); await page.keyboard.press("Meta+k");
    await expect(page.locator(".app-shell")).toHaveCount(0);
    await page.getByRole("button", { name: "暂时打开账本", exact: true }).click();
    await expect(page.locator(".new-record-button")).toBeVisible();
    await expect(page.getByLabel("发生了什么？")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "时间线", exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.workspace.status())).toMatchObject({
      ok: true, data: { status: "open", workspace: { id: original.id } }
    });
    expect(await page.evaluate(() => window.grudgeVault.records.timeline({}))).toMatchObject({ ok: true });
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally {
    if (application) await application.close();
    await seed.close(); await rm(root, { recursive: true, force: true });
  }
});

test("keeps old import-folder settings dormant after a redesigned workspace opens", async () => {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-no-folder-watch-e2e-"));
  const workspace = join(root, "workspace"), userData = join(root, "user-data");
  const seed = new LocalWorkspaceManager({
    async assertAvailable() {},
    async protect(key) { return `e2e:${key.toString("base64")}`; },
    async unprotect(envelope) {
      if (!envelope.startsWith("e2e:")) throw new Error("Invalid synthetic key envelope.");
      return { key: Buffer.from(envelope.slice(4), "base64") };
    }
  }, join(root, "synthetic-seed-state.json"));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const workspaceId = (await seed.create(workspace, "合成旧监视设置工作区")).workspace.id;
    await seed.close();
    await mkdir(userData, { recursive: true });
    const legacyStatePath = join(userData, "local-intelligence.json");
    const oldState = JSON.stringify({ formatVersion: 1, media: DEFAULT_LOCAL_INTELLIGENCE_CONFIGURATION,
      importFolders: { [`${workspaceId}:${resolve(workspace)}`]: { path: join(root, "old-scheduled-folder"), enabled: true } }
    });
    await writeFile(legacyStatePath, oldState);
    const inheritedEnvironment = Object.fromEntries(Object.entries(process.env)
      .filter((item): item is [string, string] => item[1] !== undefined));
    application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
      env: { ...inheritedEnvironment, GRUDGE_VAULT_E2E_WORKSPACE: workspace } });
    const page = await application.firstWindow();
    await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.importFolder.status())).toMatchObject({
      ok: true, data: { configured: false, enabled: false, watching: false, importedCount: 0, failedCount: 0 }
    });
    expect(await page.evaluate(() => window.grudgeVault.importFolder.scanNow())).toMatchObject({
      ok: false, error: { code: "VALIDATION_FAILED" }
    });
    expect(await readFile(legacyStatePath, "utf8")).toBe(oldState);
  } finally {
    if (application) await application.close();
    await seed.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("exposes the workspace idle-lock policy without silently changing it during import", async () => {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-auto-lock-e2e-"));
  const workspace = join(root, "workspace"), userData = join(root, "user-data");
  const seed = new LocalWorkspaceManager({
    async assertAvailable() {},
    async protect(key) { return `e2e:${key.toString("base64")}`; },
    async unprotect(envelope) {
      if (!envelope.startsWith("e2e:")) throw new Error("Invalid synthetic key envelope.");
      return { key: Buffer.from(envelope.slice(4), "base64") };
    }
  }, join(root, "synthetic-seed-state.json"));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await seed.create(workspace, "合成自动锁定工作区"); await seed.close();
    await mkdir(userData, { recursive: true });
    const inheritedEnvironment = Object.fromEntries(Object.entries(process.env)
      .filter((item): item is [string, string] => item[1] !== undefined));
    application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
      env: { ...inheritedEnvironment, GRUDGE_VAULT_E2E_WORKSPACE: workspace } });
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsGroup(page, "隐私与安全");
    const selector = page.getByLabel("Mac 空闲多久后锁定");
    await expect(selector).toHaveValue("15");
    await settingsGroup(page, "隐私与安全");
    await expect(page.getByText("工作区锁定、Mac 锁屏或休眠、退出应用都会停止正在进行的 Day One 导入。", { exact: false })).toBeVisible();
    await selector.selectOption("30");
    expect(await page.evaluate(() => window.grudgeVault.workspace.getSecuritySettings()))
      .toMatchObject({ ok: true, data: { autoLockMinutes: 15, integrityScanIntervalDays: 30 } });
    await settingsGroup(page, "隐私与安全");
    await page.getByRole("button", { name: "保存自动锁定设置" }).click();
    await expect(page.getByText("自动锁定设置已保存。")).toBeVisible();
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsGroup(page, "隐私与安全");
    await expect(page.getByLabel("Mac 空闲多久后锁定")).toHaveValue("30");
    await settingsGroup(page, "隐私与安全");
    await page.getByLabel("Mac 空闲多久后锁定").selectOption("0");
    page.once("dialog", (dialog) => dialog.dismiss());
    await settingsGroup(page, "隐私与安全");
    await page.getByRole("button", { name: "保存自动锁定设置" }).click();
    expect(await page.evaluate(() => window.grudgeVault.workspace.getSecuritySettings()))
      .toMatchObject({ ok: true, data: { autoLockMinutes: 30, integrityScanIntervalDays: 30 } });
    page.once("dialog", (dialog) => dialog.accept());
    await settingsGroup(page, "隐私与安全");
    await page.getByRole("button", { name: "保存自动锁定设置" }).click();
    await expect(page.getByText("自动锁定设置已保存。")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.workspace.getSecuritySettings()))
      .toMatchObject({ ok: true, data: { autoLockMinutes: 0, integrityScanIntervalDays: 30 } });
    expect(JSON.parse(await readFile(join(workspace, "workspace.json"), "utf8"))).toMatchObject({
      security: { autoLockMinutes: 0, integrityScanIntervalDays: 30 }
    });
  } finally {
    if (application) await application.close();
    await seed.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runs the screened record, review, report and search flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-redesign-e2e-"));
  const workspace = join(root, "workspace");
  const userData = join(root, "user-data");
  const dayOneZip = join(root, "synthetic-dayone.zip");
  const dayOneUpdatedZip = join(root, "synthetic-dayone-updated.zip");
  const paginationZip = join(root, "synthetic-pagination.zip");
  const reviewZip = join(root, "synthetic-review.zip");
  const legacyWorkspace = join(root, "synthetic-legacy-workspace");
  const legacyCancelWorkspace = join(root, "synthetic-cancel-legacy-workspace");
  const keyboardPng = join(root, "keyboard.png");
  const anchorWav = join(root, "anchor.wav");
  await writeFile(keyboardPng, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=", "base64"
  ));
  await writeSyntheticWav(anchorWav);
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ entries: [
    { uuid: "E2E-RELEVANT", creationDate: "2026-09-20T10:00:00Z", text: "Day One 项目奖金未结清" },
    { uuid: "E2E-ORDINARY", creationDate: "2026-09-21T10:00:00Z", text: "午饭后散步，下午工作顺利" },
    { uuid: "E2E-INVALID", text: "synthetic-invalid-private-body" }
  ] })), "Journal.json");
  zip.end();
  await pipeline(zip.outputStream as Readable, createWriteStream(dayOneZip));
  const updatedZip = new ZipFile();
  updatedZip.addBuffer(Buffer.from(JSON.stringify({ entries: [
    { uuid: "E2E-RELEVANT", creationDate: "2026-09-20T10:00:00Z", text: "午饭后散步，后来吃了苹果" }
  ] })), "Journal.json");
  updatedZip.end();
  await pipeline(updatedZip.outputStream as Readable, createWriteStream(dayOneUpdatedZip));
  const pagedZip = new ZipFile();
  pagedZip.addBuffer(Buffer.from(JSON.stringify({ entries: Array.from({ length: 65 }, (_, index) => ({
    uuid: `E2E-PAGED-${index}`, creationDate: "2026-09-22T10:00:00Z", text: `分页薪酬凭证 ${index}`
  })) })), "Journal.json");
  pagedZip.end();
  await pipeline(pagedZip.outputStream as Readable, createWriteStream(paginationZip));
  const reviewedZip = new ZipFile();
  reviewedZip.addBuffer(Buffer.from(JSON.stringify({ entries: [
    { uuid: "E2E-REVIEW", creationDate: "2026-09-23T10:00:00Z", text: "Day One 里他又这样说了，我有些不安" }
  ] })), "Journal.json");
  reviewedZip.end();
  await pipeline(reviewedZip.outputStream as Readable, createWriteStream(reviewZip));
  const legacyManager = new LocalWorkspaceManager({
    async assertAvailable() {},
    async protect(key) { return `e2e:${key.toString("base64")}`; },
    async unprotect(envelope) {
      if (!envelope.startsWith("e2e:")) throw new Error("Invalid synthetic key envelope.");
      return { key: Buffer.from(envelope.slice(4), "base64") };
    }
  }, join(root, "synthetic-legacy-state.json"));
  try {
    const legacyApplication = new GrudgeVaultApplication(legacyManager);
    await legacyApplication.createWorkspace(legacyWorkspace, "合成旧工作区");
    legacyApplication.createEvent({
      title: "旧工作区复核记录", status: "confirmed", occurredAt: { kind: "unknown" },
      narrative: "旧记录里他又这样说了，我有些不安", facts: [], interpretations: [], emotions: [],
      interests: [], participants: [], sourceRefs: [], assetRefs: [], reason: "synthetic e2e fixture"
    });
  } finally {
    await legacyManager.close();
  }
  const legacyConfigPath = join(legacyWorkspace, "workspace.json");
  const legacyConfig = JSON.parse(await readFile(legacyConfigPath, "utf8")) as Record<string, unknown>;
  legacyConfig.formatVersion = 2;
  await writeFile(legacyConfigPath, `${JSON.stringify(legacyConfig, null, 2)}\n`);
  const cancelManager = new LocalWorkspaceManager({
    async assertAvailable() {},
    async protect(key) { return `e2e:${key.toString("base64")}`; },
    async unprotect(envelope) {
      if (!envelope.startsWith("e2e:")) throw new Error("Invalid synthetic key envelope.");
      return { key: Buffer.from(envelope.slice(4), "base64") };
    }
  }, join(root, "synthetic-cancel-legacy-state.json"));
  try {
    const cancelApplication = new GrudgeVaultApplication(cancelManager);
    await cancelApplication.createWorkspace(legacyCancelWorkspace, "合成待取消旧工作区");
    cancelApplication.createEvent({
      title: "E2E迁移取消的旧奖金记录", status: "confirmed", occurredAt: { kind: "unknown" },
      narrative: "E2E迁移取消的旧奖金记录", facts: [], interpretations: [], emotions: [],
      interests: [], participants: [], sourceRefs: [], assetRefs: [], reason: "synthetic cancellation fixture"
    });
  } finally {
    await cancelManager.close();
  }
  const cancelConfigPath = join(legacyCancelWorkspace, "workspace.json");
  const cancelConfig = JSON.parse(await readFile(cancelConfigPath, "utf8")) as Record<string, unknown>;
  cancelConfig.formatVersion = 2;
  await writeFile(cancelConfigPath, `${JSON.stringify(cancelConfig, null, 2)}\n`);
  const entry = resolve("apps/desktop/out-e2e/main/main.js");
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined)
  );
  const application = await electron.launch({
    args: [entry, `--user-data-dir=${userData}`],
    env: { ...inheritedEnvironment, GRUDGE_VAULT_E2E_WORKSPACE: workspace }
  });
  try {
    const page = await application.firstWindow();
    const startupDatabase = new Database(join(workspace, "db", "grudge-vault.sqlite3"), { readonly: true });
    try {
      expect(startupDatabase.prepare("SELECT count(*) FROM automation_runs").pluck().get()).toBe(0);
    } finally {
      startupDatabase.close();
    }
    const legacyJobDatabase = new Database(join(workspace, "db", "grudge-vault.sqlite3"));
    const legacyJob = new SqliteJobRepository(legacyJobDatabase).enqueue(
      "dayone.import", { importRunId: "synthetic-legacy-job" }, new Date().toISOString(), 1
    );
    legacyJobDatabase.close();
    await page.waitForTimeout(1_250);
    const legacyJobActions = await page.evaluate(async (jobId) => Promise.all([
      window.grudgeVault.jobs.retry(jobId), window.grudgeVault.jobs.cancel(jobId)
    ]), legacyJob.id);
    for (const result of legacyJobActions) {
      expect(result).toMatchObject({ ok: false, error: { code: "JOB_STATE_CONFLICT" } });
    }
    const preservedJobDatabase = new Database(join(workspace, "db", "grudge-vault.sqlite3"), { readonly: true });
    try {
      expect(preservedJobDatabase.prepare("SELECT state, attempts FROM jobs WHERE id = ?").get(legacyJob.id))
        .toEqual({ state: "queued", attempts: 0 });
    } finally {
      preservedJobDatabase.close();
    }
    const bypassAttempts = await page.evaluate(async () => Promise.all([
      window.grudgeVault.assets.chooseAndImport(),
      window.grudgeVault.assets.verify(globalThis.crypto.randomUUID()),
      window.grudgeVault.evidence.deleteOriginal({ assetId: globalThis.crypto.randomUUID(), confirmReferencedDeletion: true }),
      window.grudgeVault.evidence.supersede({
        oldAssetId: globalThis.crypto.randomUUID(), newAssetId: globalThis.crypto.randomUUID()
      }),
      window.grudgeVault.imports.chooseDayOneZip(),
      window.grudgeVault.importFolder.setEnabled(true),
      window.grudgeVault.localIntelligence.choosePath("ffmpeg"),
      window.grudgeVault.localIntelligence.updateSettings({
        autoProcessNew: true, ocrLanguages: ["eng"], resourceProfile: "balanced", whisperGpu: "cpu"
      }),
      window.grudgeVault.localIntelligence.processHistorical(),
      window.grudgeVault.reminders.updateSettings({
        monthly: true, quarterly: true, clarificationWeekly: true, systemNotifications: true
      }),
      window.grudgeVault.reminders.getSettings(),
      window.grudgeVault.reminders.requestSystemNotifications("zh-CN"),
      window.grudgeVault.llm.connect({ provider: "nvidia", model: "legacy-model", apiKey: "synthetic-key" }),
      window.grudgeVault.llm.save({ provider: "openrouter", model: "legacy-model", apiKey: "synthetic-key" }),
      window.grudgeVault.llm.listModels({ provider: "nvidia", apiKey: "synthetic-key" }),
      window.grudgeVault.llm.activate("openrouter"),
      window.grudgeVault.llm.disconnect("nvidia")
    ]));
    for (const result of bypassAttempts) {
      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    }
    await expect(page.getByRole("heading", { name: "时间线" })).toBeVisible();
    await expect(page.getByText("还没有正式记录")).toBeVisible();
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 800 }, { width: 840, height: 760 }, { width: 390, height: 760 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    }
    await expect(page.locator(".new-record-button svg")).toBeVisible();
    expect(await page.locator(".new-record-button svg").evaluate(icon => globalThis.getComputedStyle(icon).stroke)).toBe("rgb(255, 255, 255)");
    await expect(page.getByRole("button", { name: "锁定", exact: true })).toBeVisible();
    await page.locator(".new-record-button").click();
    await expect(page.getByRole("dialog", { name: "新建记录" })).toBeVisible();
    await page.getByRole("dialog", { name: "新建记录" }).getByRole("button", { name: "关闭" }).click();
    await page.keyboard.press("ControlOrMeta+N");
    await expect(page.getByRole("dialog", { name: "新建记录" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "新建记录" })).toBeHidden();
    await page.keyboard.press("ControlOrMeta+K");
    await expect(page.getByRole("heading", { name: "搜索" })).toBeVisible();
    await expect(page.getByPlaceholder("描述你记得的内容…")).toBeFocused();

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await expect(page.getByLabel("推荐模型", { exact: true })).toHaveValue("qwen3.8-omni-flash");
    const modelCard = page.locator(".settings-card").filter({ hasText: "模型服务" });
    await expect(modelCard.getByText(/^文字 · /)).toHaveClass("pending");
    await page.getByRole("button", { name: "MiniMax", exact: true }).click();
    await expect(page.getByLabel("推荐模型", { exact: true })).toHaveValue("MiniMax-M3");
    await expect(page.getByLabel("模型 ID")).toHaveValue("MiniMax-M3");
    await page.getByRole("button", { name: "百炼", exact: true }).click();
    await page.getByLabel("推荐模型", { exact: true }).selectOption("qwen3.7-plus");
    await expect(page.getByLabel("模型 ID")).toHaveValue("qwen3.7-plus");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.getByLabel("API 密钥").fill("e2e-secret");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "测试连接并保存" }).click();
    await expect(page.getByText("连接测试通过，已保存配置。")).toBeVisible();
    const textCapability = modelCard.getByText(/^文字 · /);
    await expect(textCapability).toHaveClass("ready");
    await page.getByLabel("推荐模型", { exact: true }).selectOption("qwen3.8-omni-flash");
    await expect(textCapability).toHaveClass("pending");
    await expect(modelCard.getByText("已保存配置启用中", { exact: true })).toBeVisible();
    await page.getByLabel("推荐模型", { exact: true }).selectOption("qwen3.7-plus");
    await expect(textCapability).toHaveClass("ready");
    await openDisclosure(page, "高级设置");
    await page.getByLabel("地域", { exact: true }).selectOption("ap-southeast-1");
    await expect(textCapability).toHaveClass("pending");
    await openDisclosure(page, "高级设置");
    await page.getByLabel("地域", { exact: true }).selectOption("cn-beijing");
    await expect(textCapability).toHaveClass("ready");
    await openDisclosure(page, "高级设置");
    await page.getByLabel("业务空间（按需）").fill("ws-unsaved");
    await expect(textCapability).toHaveClass("pending");
    await openDisclosure(page, "高级设置");
    await page.getByLabel("业务空间（按需）").fill("");
    await expect(textCapability).toHaveClass("ready");
    await page.getByLabel("API 密钥").fill("unverified-e2e-key");
    await expect(textCapability).toHaveClass("pending");
    await page.getByLabel("API 密钥").fill("");
    await expect(textCapability).toHaveClass("ready");
    expect(await application.evaluate(() =>
      (globalThis as typeof globalThis & { __gvE2eCatalogRequests?: number }).__gvE2eCatalogRequests ?? 0
    )).toBe(0);
    await page.getByRole("button", { name: "暂停全部模型外发" }).click();
    await expect(page.getByText(/已暂停模型外发/)).toBeVisible();
    await expect(page.locator(".settings-card").filter({ hasText: "模型服务" }).getByText("已暂停", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重新测试并启用" }).click();
    await expect(page.getByText("连接测试通过，已保存配置。")).toBeVisible();
    await settingsGroup(page, "隐私与安全");
    await page.getByLabel("默认地域").fill("新加坡");
    await settingsGroup(page, "隐私与安全");
    await page.getByRole("button", { name: "保存默认地域" }).click();
    await expect(page.getByText(/默认法律地域已保存/)).toBeVisible();

    await page.locator(".new-record-button").click();
    await page.getByLabel("发生了什么？").fill("午饭后散步，下午工作顺利");
    await page.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(page.getByText(/不属于收录范围/)).toBeVisible();
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("无法恢复");
      await dialog.dismiss();
    });
    await page.getByRole("dialog", { name: "新建记录" }).getByRole("button", { name: "关闭" }).click();
    await expect(page.getByRole("dialog", { name: "新建记录" }).getByLabel("发生了什么？"))
      .toHaveValue("午饭后散步，下午工作顺利");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "关闭" }).click();
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await expect(page.getByText("还没有正式记录")).toBeVisible();

    await page.locator(".new-record-button").click();
    await page.getByLabel("发生了什么？").fill("E2E延迟筛选的具体冲突");
    await page.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(page.getByText("正在判断是否收录…")).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("dialog", { name: "新建记录" }).getByRole("button", { name: "关闭" }).click();
    await expect(page.getByRole("dialog", { name: "新建记录" })).toBeHidden();
    await expect.poll(() => application.evaluate(() => Boolean(
      (globalThis as typeof globalThis & { __gvE2eDelayedScreeningFinished?: boolean }).__gvE2eDelayedScreeningFinished
    ))).toBe(true);
    await expect(page.getByText("还没有正式记录")).toBeVisible();
    expect(await page.evaluate(async () => window.grudgeVault.records.search({ text: "E2E延迟筛选" })))
      .toMatchObject({ ok: true, data: { hits: [] } });

    await page.locator(".new-record-button").click();
    await page.getByLabel("发生了什么？").fill("他又这样说了，我有些不安");
    await page.getByRole("button", { name: "判断并收录", exact: true }).click();
    const currentReview = page.getByLabel("当前记录待确认");
    await expect(currentReview).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    page.once("dialog", dialog => dialog.dismiss());
    await page.getByRole("dialog", { name: "新建记录" }).getByRole("button", { name: "关闭" }).click();
    await expect(page.getByLabel("发生了什么？")).toHaveValue("他又这样说了，我有些不安");
    await currentReview.getByRole("button", { name: "不收录并清空" }).click();
    await expect(page.getByLabel("发生了什么？")).toHaveValue("");
    expect(await page.evaluate(() => window.grudgeVault.pending.list())).toMatchObject({ ok: true, data: [] });
    await page.getByRole("dialog", { name: "新建记录" }).getByRole("button", { name: "关闭" }).click();

    await page.locator(".new-record-button").click();
    await page.getByLabel("发生了什么？").fill("项目奖金迟迟未结清，公司仍未支付");
    await page.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(page.getByText("项目奖金迟迟未结清，公司仍未支付", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByText("项目奖金迟迟未结清，公司仍未支付", { exact: true }).click();
    await expect(page.getByText("项目奖金尚未结清，需要核对约定与付款记录。")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "待核对推测" })).toBeVisible();
    await expect(page.getByText("公司可能故意拖欠，但目前没有证据。", { exact: true })).toBeVisible();
    const firstReportId = await page.evaluate(async () => {
      const search = await window.grudgeVault.records.search({ text: "项目奖金迟迟未结清" });
      if (!search.ok || !search.data.hits[0]) throw new Error("Synthetic record was not found.");
      const detail = await window.grudgeVault.records.get(search.data.hits[0].record.id);
      if (!detail.ok || !detail.data.report) throw new Error("Initial report was not found.");
      return detail.data.report.id;
    });
    await page.getByRole("button", { name: "重新分析", exact: true }).click();
    await expect.poll(async () => page.evaluate(async () => {
      const search = await window.grudgeVault.records.search({ text: "项目奖金迟迟未结清" });
      if (!search.ok || !search.data.hits[0]) return undefined;
      const detail = await window.grudgeVault.records.get(search.data.hits[0].record.id);
      return detail.ok ? detail.data.report?.id : undefined;
    }), { timeout: 15_000 }).not.toBe(firstReportId);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await openDisclosure(page, "法律视角");
    await expect(page.getByText(/法域：新加坡/)).toBeVisible();
    await openDisclosure(page, "法律视角");
    await expect(page.getByText("依据待核验", { exact: true })).toBeVisible();
    await openDisclosure(page, "法律视角");
    await page.getByRole("button", { name: "修改法域" }).click();
    await page.getByPlaceholder("输入适用法域").fill("日本");
    await page.locator(".supplement").getByRole("button", { name: "保存", exact: true }).click();
    await openDisclosure(page, "法律视角");
    await expect(page.getByText(/旧报告的法律问题与依据暂不展示/)).toBeVisible();
    await openDisclosure(page, "法律视角");
    await expect(page.getByText("奖金是否构成约定的劳动报酬需要结合材料核验。")).toHaveCount(0);
    await page.getByRole("button", { name: "重新分析", exact: true }).click();
    await expect.poll(async () => page.evaluate(async () => {
      const search = await window.grudgeVault.records.search({ text: "项目奖金迟迟未结清" });
      if (!search.ok || !search.data.hits[0]) return false;
      const refreshed = await window.grudgeVault.records.get(search.data.hits[0].record.id);
      return refreshed.ok && refreshed.data.report?.recordRevision === refreshed.data.record.revision &&
        refreshed.data.record.reportState === "complete";
    }), { timeout: 15_000 }).toBe(true);
    await openDisclosure(page, "法律视角");
    await expect(page.getByText(/法域：日本/)).toBeVisible();
    await openDisclosure(page, "法律视角");
    await expect(page.getByText("奖金是否构成约定的劳动报酬需要结合材料核验。")).toBeVisible();
    await page.getByRole("button", { name: "补充地点" }).click();
    await page.getByPlaceholder("输入明确地点").fill("上海办公室");
    await page.locator(".supplement").getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("上海办公室")).toBeVisible();
    await page.locator(".split-sections li").filter({ hasText: "奖金约定的具体金额和支付日期尚待补充。" })
      .getByRole("button", { name: "补充此项" }).click();
    await page.getByRole("textbox", { name: /针对“奖金约定的具体金额和支付日期尚待补充。”的补充说明/ })
      .fill("我记得约定金额是五千元，仍需核对合同。");
    await page.getByRole("button", { name: "保存补充" }).click();
    await expect(page.getByText(/你已补充（用户陈述，待核对）：我记得约定金额是五千元/)).toBeVisible();
    await page.getByRole("button", { name: "重新分析", exact: true }).click();
    await expect.poll(async () => page.evaluate(async () => {
      const search = await window.grudgeVault.records.search({ text: "项目奖金迟迟未结清" });
      if (!search.ok || !search.data.hits[0]) return undefined;
      const detail = await window.grudgeVault.records.get(search.data.hits[0].record.id);
      return detail.ok ? detail.data.record.reportState : undefined;
    }), { timeout: 15_000 }).toBe("complete");
    await expect(page.getByText("此前补充的问题")).toBeVisible();
    await expect(page.getByText("合同原件是否载明奖金金额？")).toBeVisible();
    await expect(page.getByText(/你已补充（用户陈述，待核对）：我记得约定金额是五千元/)).toBeVisible();

    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByPlaceholder("描述你记得的内容…").fill("奖金");
    await page.getByLabel("使用百炼语义检索").uncheck();
    await page.locator(".search-input").getByRole("button", { name: "搜索" }).click();
    await expect(page.getByText("找到 1 条记录")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await expect(page.getByText(/原文中包含“奖金”/)).toBeVisible();
    await page.getByRole("button", { name: /原文中包含“奖金”/ }).click();
    await expect(page.getByRole("heading", { name: "原始文字" })).toBeVisible();
    await page.getByRole("button", { name: /返回搜索结果/ }).click();
    await expect(page.getByText("找到 1 条记录")).toBeVisible();

    await expect(page.getByLabel("使用百炼语义检索")).not.toBeChecked();
    await expect(page.locator(".search-mode")).toContainText("本地关键词检索");
    await page.getByPlaceholder("描述你记得的内容…").fill("完全不匹配的合成查询");
    await page.locator(".search-input").getByRole("button", { name: "搜索" }).click();
    await expect(page.getByRole("heading", { name: "没有找到相关正式记录" })).toBeVisible();

    await page.getByPlaceholder("描述你记得的内容…").fill("");
    await page.getByLabel("选择搜索图片、音频或视频").setInputFiles(keyboardPng);
    await expect(page.locator(".query-files li")).toContainText("keyboard.png");
    await page.locator(".search-input").getByRole("button", { name: "搜索" }).click();
    await expect(page.getByRole("alert")).toContainText("媒体语义检索尚未建立可用索引");
    await expect(page.locator(".query-files li")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "没有找到相关正式记录" })).toHaveCount(0);
    await page.getByLabel("选择搜索图片、音频或视频").setInputFiles(keyboardPng);
    await expect(page.locator(".query-files li")).toContainText("keyboard.png");

    await application.evaluate(({ dialog }, selectedZip) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedZip] });
      const testState = globalThis as typeof globalThis & {
        __gvZipConfirmResponse?: number;
        __gvZipDialogDetails?: string[];
      };
      testState.__gvZipConfirmResponse = 0;
      testState.__gvZipDialogDetails = [];
      const originalShowMessageBox = dialog.showMessageBox.bind(dialog) as (...args: unknown[]) => Promise<{
        response: number; checkboxChecked: boolean;
      }>;
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { detail?: string; message?: string };
        if (options.message?.startsWith("包内 ") !== true) return originalShowMessageBox(...args);
        testState.__gvZipDialogDetails!.push(`${options.message}\n${options.detail}`);
        return { response: testState.__gvZipConfirmResponse ?? 0, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    }, dayOneZip);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "选择 Day One 导出 ZIP" }).click();
    await settingsGroup(page, "导入");
    await expect(page.getByRole("button", { name: "选择 Day One 导出 ZIP" })).toBeEnabled();
    expect(await application.evaluate(() => (globalThis as typeof globalThis & {
      __gvZipDialogDetails?: string[];
    }).__gvZipDialogDetails)).toEqual([expect.stringContaining("包内 3 条日记，2 条可筛选")]);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & {
      __gvZipDialogDetails?: string[];
    }).__gvZipDialogDetails?.[0])).toContain("媒体引用 0 个");
    expect(await application.evaluate(() => (globalThis as typeof globalThis & {
      __gvZipDialogDetails?: string[];
    }).__gvZipDialogDetails?.[0])).toContain("Mac 空闲 15 分钟后会自动锁定");
    expect(await application.evaluate(() => (globalThis as typeof globalThis & {
      __gvZipDialogDetails?: string[];
    }).__gvZipDialogDetails?.[0])).toContain("重新选择 ZIP 不是断点继续");
    const cancelledZipDatabase = new Database(join(workspace, "db", "grudge-vault.sqlite3"), { readonly: true });
    try {
      expect(cancelledZipDatabase.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(1);
    } finally {
      cancelledZipDatabase.close();
    }
    await application.evaluate(() => {
      (globalThis as typeof globalThis & { __gvZipConfirmResponse?: number }).__gvZipConfirmResponse = 1;
    });
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "选择 Day One 导出 ZIP" }).click();
    await expect(page.getByText(/已检查 3 条：收录 1，跳过 1，待确认 0，失败 1/)).toBeVisible();
    await expect(page.getByText(/失败条目未计入跳过；请检查导出包和模型配置后重新选择 ZIP/)).toBeVisible();
    await expect.poll(async () => {
      const result = await page.evaluate(() => window.grudgeVault.intake.dayOneImportProgress());
      return result.ok ? result.data : null;
    }).toMatchObject({ phase: "completed", totalEntries: 3, included: 1, skipped: 1, failed: 1, review: 0, issueCount: 1,
      summary: { totalEntries: 3, included: 1, skipped: 1, failed: 1, review: 0, issueCount: 1, mediaEntries: 0, missingMedia: 0 } });
    expect(await readdir(join(userData, ".grudge-vault-redesign-transient-v1")))
      .toEqual([".owned-by-grudge-vault"]);
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await expect(page.getByText("Day One 项目奖金未结清")).toBeVisible();
    await expect(page.locator(".record-card")).toHaveCount(2);
    await expect(page.getByText("午饭后散步，下午工作顺利")).toHaveCount(0);
    const invalidZipDatabase = new Database(join(workspace, "db", "grudge-vault.sqlite3"), { readonly: true });
    try {
      expect(invalidZipDatabase.serialize().includes(Buffer.from("synthetic-invalid-private-body"))).toBe(false);
    } finally {
      invalidZipDatabase.close();
    }

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsGroup(page, "导入");
    await expect(page.getByRole("status", { name: "Day One 导入进度" })).toContainText("已检查 3 条：收录 1，跳过 1，待确认 0，失败 1");
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "选择 Day One 导出 ZIP" }).click();
    await expect(page.getByText(/已检查 3 条：收录 1，跳过 1，待确认 0，失败 1/)).toBeVisible();
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await expect(page.locator(".record-card")).toHaveCount(2);

    await application.evaluate(({ dialog }, selectedZip) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedZip] });
    }, dayOneUpdatedZip);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "选择 Day One 导出 ZIP" }).click();
    await expect(page.getByText(/已检查 1 条：收录 0，跳过 1，待确认 0，失败 0/)).toBeVisible();
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await expect(page.locator(".record-card")).toHaveCount(2);
    await page.getByText("Day One 项目奖金未结清").click();
    await expect(page.getByText("来源待核对")).toBeVisible();
    await expect(page.getByText(/当前原文和报告仍对应已收录的旧版本/)).toBeVisible();

    await application.evaluate(({ dialog }, selectedZip) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedZip] });
    }, paginationZip);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "选择 Day One 导出 ZIP" }).click();
    await expect(page.getByText(/已检查 65 条：收录 65，跳过 0，待确认 0，失败 0/)).toBeVisible({ timeout: 25_000 });
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByPlaceholder("描述你记得的内容…").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator(".search-input").getByRole("button", { name: "搜索" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("选择搜索图片、音频或视频")).toBeFocused();
    expect(await page.locator(".file-button").evaluate((element) => globalThis.getComputedStyle(element).outlineStyle)).toBe("solid");
    await page.getByLabel("使用百炼语义检索").uncheck();
    await page.getByPlaceholder("描述你记得的内容…").fill("分页薪酬凭证");
    await page.locator(".search-input").getByRole("button", { name: "搜索" }).click();
    await expect(page.getByText("找到 30 条记录")).toBeVisible();
    await page.getByPlaceholder("描述你记得的内容…").fill("未提交的新关键词");
    await openDisclosure(page, "筛选");
    await page.locator(".search-filters").getByLabel("来源").selectOption("manual");
    await page.getByRole("button", { name: "载入更多" }).click();
    await expect(page.getByText("找到 60 条记录")).toBeVisible();
    await page.getByRole("button", { name: "载入更多" }).click();
    await expect(page.getByText("找到 65 条记录")).toBeVisible();
    await expect(page.locator(".search-results article")).toHaveCount(65);

    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await expect(page.locator(".record-card")).toHaveCount(60);
    await page.getByRole("button", { name: "载入更多" }).click();
    await expect(page.locator(".record-card")).toHaveCount(67);
    await page.locator(".record-card").last().scrollIntoViewIfNeeded();
    const timelineScroll = await page.evaluate(() => globalThis.scrollY);
    await page.locator(".record-card").last().click();
    await page.getByRole("button", { name: "重新分析", exact: true }).click();
    await page.getByRole("button", { name: /返回时间线/ }).click();
    await expect(page.locator(".record-card")).toHaveCount(67);
    await expect.poll(() => page.evaluate((before) => Math.abs(globalThis.scrollY - before) <= 5 ? "restored" : JSON.stringify({ position: globalThis.scrollY, expected: before, maximum: document.documentElement.scrollHeight - globalThis.innerHeight }), timelineScroll))
      .toBe("restored");
    await page.locator(".new-record-button").click();
    const unsupportedEditor = page.getByRole("dialog", { name: "新建记录" });
    await unsupportedEditor.getByLabel("发生了什么？").fill("合成图片中的工资凭证需要核对");
    await page.keyboard.press("Tab");
    await expect(unsupportedEditor.getByLabel("添加图片、音频或视频")).toBeFocused();
    expect(await unsupportedEditor.locator(".file-drop").evaluate((element) => globalThis.getComputedStyle(element).outlineStyle)).toBe("solid");
    const [keyboardChooser] = await Promise.all([
      page.waitForEvent("filechooser"), page.keyboard.press("Enter")
    ]);
    await keyboardChooser.setFiles(keyboardPng);
    await expect(unsupportedEditor.locator(".file-list")).toContainText("keyboard.png");
    await unsupportedEditor.getByRole("button", { name: "移除 keyboard.png" }).click();
    await unsupportedEditor.locator(".file-drop").evaluate((element) => {
      const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=";
      const bytes = Uint8Array.from(globalThis.atob(encoded), (character) => character.charCodeAt(0));
      const transfer = new globalThis.DataTransfer();
      transfer.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
      element.dispatchEvent(new globalThis.DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await expect(unsupportedEditor.locator(".file-list")).toContainText("dropped.png");
    await unsupportedEditor.getByRole("button", { name: "移除 dropped.png" }).click();
    await unsupportedEditor.locator(".file-drop").evaluate((element) => {
      const transfer = new globalThis.DataTransfer();
      transfer.items.add(new File([new Uint8Array(7_000_001)], "long.mp3", { type: "audio/mpeg" }));
      element.dispatchEvent(new globalThis.DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await expect(unsupportedEditor.getByText(/Mac 本机分段/)).toBeVisible();
    await unsupportedEditor.getByRole("button", { name: "移除 long.mp3" }).click();
    await pasteSyntheticPng(unsupportedEditor);
    await unsupportedEditor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(unsupportedEditor.getByRole("alert")).toContainText("当前模型无法完整处理所选媒体");
    await expect(unsupportedEditor.getByLabel("发生了什么？")).toHaveValue("合成图片中的工资凭证需要核对");
    await expect(unsupportedEditor.locator(".file-list")).toContainText("pasted.png");
    await expect(page.locator(".record-card")).toHaveCount(67);
    await Promise.all([
      page.waitForEvent("dialog").then((confirmation) => confirmation.accept()),
      unsupportedEditor.getByRole("button", { name: "关闭" }).click()
    ]);

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await openDisclosure(page, "高级设置");
    await page.getByLabel("模型 ID").fill("qwen3.8-omni-flash");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "测试连接并保存" }).click();
    await expect(page.getByText("连接测试通过，已保存配置。")).toBeVisible();
    await expect.poll(async () => page.evaluate(async () => {
      const result = await window.grudgeVault.llm.getSettings();
      return result.ok ? { provider: result.data.activeProvider, model: result.data.providers.bailian?.model } : null;
    })).toEqual({ provider: "bailian", model: "qwen3.8-omni-flash" });
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await page.locator(".new-record-button").click();
    const editor = page.getByRole("dialog", { name: "新建记录" });
    await editor.getByLabel("发生了什么？").fill("合成图片中的工资凭证需要核对");
    await pasteSyntheticPng(editor);
    await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(editor).toBeHidden({ timeout: 15_000 });
    await expect(page.locator(".detail-panel").getByRole("heading", { name: "合成图片中的工资凭证需要核对", exact: true, level: 2 }))
      .toBeVisible({ timeout: 15_000 });
    const pastedResult = await page.evaluate(async () => {
      const timeline = await window.grudgeVault.records.timeline({ limit: 60 });
      if (!timeline.ok) return timeline;
      const record = timeline.data.records.find(({ title }) => title === "合成图片中的工资凭证需要核对");
      return record ? window.grudgeVault.records.get(record.id) : timeline;
    });
    expect(pastedResult).toMatchObject({ ok: true, data: { attachments: [{ originalFileName: "pasted.png" }] } });

    await application.evaluate(({ dialog }, selectedZip) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedZip] });
    }, reviewZip);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "选择 Day One 导出 ZIP" }).click();
    await expect(page.getByText(/已检查 1 条：收录 0，跳过 0，待确认 1，失败 0/)).toBeVisible();
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await page.locator(".page-header").getByRole("button", { name: /待确认/ }).click();
    const pendingDrawer = page.getByLabel("待确认", { exact: true });
    await expect(pendingDrawer.getByText("Day One 里他又这样说了，我有些不安")).toBeVisible();
    await expect(pendingDrawer.getByRole("button", { name: "选择原 ZIP" })).toBeHidden();
    await pendingDrawer.getByRole("button", { name: "补充", exact: true }).click();
    await expect(pendingDrawer).toBeHidden();
    const zipSupplement = page.getByRole("dialog", { name: "补充待确认内容" });
    await expect(zipSupplement.getByLabel("待核对内容")).toContainText("待核对点");
    await expect(zipSupplement.getByLabel("补充需核对的内容")).toHaveValue("");
    await zipSupplement.getByLabel("补充需核对的内容").fill("ZIP补充核对：公司拖欠我的奖金，我保留了付款邮件");
    await zipSupplement.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(zipSupplement).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText("ZIP补充核对：公司拖欠我的奖金，我保留了付款邮件", { exact: true })).toBeVisible();
    const pendingAfterReview = await page.evaluate(() => window.grudgeVault.pending.list());
    expect(pendingAfterReview).toMatchObject({ ok: true, data: [] });

    await page.getByRole("button", { name: /返回时间线/ }).click();
    await page.locator(".new-record-button").click();
    const originalManualEditor = page.getByRole("dialog", { name: "新建记录" });
    await originalManualEditor.getByLabel("发生了什么？").fill("他又这样说了，我有些不安（第二次）");
    await originalManualEditor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(originalManualEditor.getByLabel("当前记录待确认")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    page.once("dialog", (dialog) => dialog.accept());
    await originalManualEditor.getByRole("button", { name: "关闭" }).click();
    await page.locator(".page-header").getByRole("button", { name: /待确认/ }).click();
    await page.getByLabel("待确认", { exact: true }).getByRole("button", { name: "补充", exact: true }).click();
    const replacementEditor = page.getByRole("dialog", { name: "补充待确认内容" });
    await expect(replacementEditor.getByLabel("补充需核对的内容")).toHaveValue("");
    await replacementEditor.getByLabel("补充需核对的内容").fill("公司拖欠我的项目奖金，我保留了付款邮件");
    await replacementEditor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(replacementEditor).toBeHidden({ timeout: 15_000 });
    expect(await page.evaluate(() => window.grudgeVault.pending.list())).toMatchObject({ ok: true, data: [] });
    await expect(page.getByText("公司拖欠我的项目奖金，我保留了付款邮件", { exact: true })).toBeVisible();

    await application.evaluate(({ dialog }, selectedWorkspace) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedWorkspace] });
    }, legacyWorkspace);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "选择旧工作区并开始筛选迁移" }).click();
    await expect(page.getByText(/已检查 1 条旧记录：收录 0，跳过 0，待确认 1，失败 0/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await page.locator(".page-header").getByRole("button", { name: /待确认/ }).click();
    const legacyPending = page.getByLabel("待确认", { exact: true });
    await expect(legacyPending.getByText(/旧工作区复核记录/)).toBeVisible();
    await expect(legacyPending.getByRole("button", { name: "补充", exact: true })).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await settingsGroup(page, "导入");
    await openDisclosure(page, "从原件恢复");
    await legacyPending.getByRole("button", { name: "选择旧工作区", exact: true }).click();
    await expect(legacyPending).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText("旧工作区复核记录", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.pending.list())).toMatchObject({ ok: true, data: [] });

    await application.evaluate(({ dialog }, selectedWorkspace) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedWorkspace] });
    }, legacyCancelWorkspace);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "选择旧工作区并开始筛选迁移" }).click();
    await page.getByRole("button", { name: "停止本次迁移" }).click();
    await expect(page.getByText(/已停止本次旧工作区迁移/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "停止本次迁移" })).toHaveCount(0);
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await expect(page.getByText("E2E迁移取消的旧奖金记录", { exact: true })).toHaveCount(0);

    await page.locator(".new-record-button").click();
    await page.getByRole("dialog", { name: "新建记录" }).getByLabel("发生了什么？")
      .fill("E2E延迟报告：公司仍未结清项目奖金");
    await page.getByRole("dialog", { name: "新建记录" }).getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(page.getByText("E2E延迟报告：公司仍未结清项目奖金", { exact: true }).first()).toBeVisible();
    const delayedReportRecordId = await page.evaluate(async () => {
      const result = await window.grudgeVault.records.search({ text: "E2E延迟报告" });
      return result.ok ? result.data.hits[0]?.record.id : undefined;
    });
    expect(delayedReportRecordId).toBeTruthy();
    if (!delayedReportRecordId) throw new Error("expected delayed report record");
    await expect.poll(() => application.evaluate(() =>
      (globalThis as typeof globalThis & { __gvE2eDelayedReportAttempts?: number }).__gvE2eDelayedReportAttempts ?? 0
    )).toBe(1);
    await page.getByRole("button", { name: "锁定", exact: true }).click();
    await expect(page.getByText("你的记录已收好")).toBeVisible();
    await expect(page.getByText("公司拖欠我的项目奖金，我保留了付款邮件", { exact: true })).toHaveCount(0);
    const lockedDatabase = new Database(join(workspace, "db", "grudge-vault.sqlite3"), { readonly: true });
    try {
      expect(lockedDatabase.prepare("SELECT count(*) FROM redesign_reports WHERE record_id = ?")
        .pluck().get(delayedReportRecordId)).toBe(0);
      expect(lockedDatabase.prepare("SELECT report_state FROM redesign_records WHERE id = ?")
        .pluck().get(delayedReportRecordId)).toBe("running");
      expect(lockedDatabase.prepare(`SELECT state FROM jobs WHERE type = 'record.analyze'
        AND json_extract(payload_json, '$.recordId') = ?`).pluck().get(delayedReportRecordId)).toBe("queued");
    } finally {
      lockedDatabase.close();
    }
    await page.getByRole("button", { name: "暂时打开账本" }).click();
    await expect(page.getByRole("heading", { name: "时间线" })).toBeVisible();
    await expect.poll(() => page.evaluate(async (recordId) => {
      const result = await window.grudgeVault.records.get(recordId);
      return result.ok ? result.data.record.reportState : undefined;
    }, delayedReportRecordId), { timeout: 20_000 }).toBe("complete");
    await expect.poll(() => application.evaluate(() =>
      (globalThis as typeof globalThis & { __gvE2eDelayedReportAttempts?: number }).__gvE2eDelayedReportAttempts ?? 0
    )).toBe(2);

    await page.locator(".new-record-button").click();
    const refreshingReportText = "E2E搜索报告刷新：公司拒绝按约定支付奖金";
    await page.getByRole("dialog", { name: "新建记录" }).getByLabel("发生了什么？").fill(refreshingReportText);
    await page.getByRole("dialog", { name: "新建记录" }).getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect.poll(() => application.evaluate(() => typeof (
      globalThis as typeof globalThis & { __gvE2eReleaseReportRefresh?: () => void }
    ).__gvE2eReleaseReportRefresh === "function")).toBe(true);
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByPlaceholder("描述你记得的内容…").fill("E2E搜索报告刷新");
    await page.getByLabel("使用百炼语义检索").uncheck();
    await page.locator(".search-box").getByRole("button", { name: "搜索", exact: true }).click();
    await page.locator(".search-results").getByRole("button", { name: new RegExp(refreshingReportText) }).click();
    await page.getByRole("button", { name: "事件报告", exact: true }).click();
    await expect(page.locator(".report-placeholder").getByRole("heading", { name: "已保存，正在分析" })).toBeVisible();
    const refreshingRecordId = await page.evaluate(async () => {
      const result = await window.grudgeVault.records.search({ text: "E2E搜索报告刷新" });
      return result.ok ? result.data.hits[0]?.record.id : undefined;
    });
    if (!refreshingRecordId) throw new Error("expected refreshing report record");
    await application.evaluate(() => {
      const release = (globalThis as typeof globalThis & { __gvE2eReleaseReportRefresh?: () => void }).__gvE2eReleaseReportRefresh;
      if (!release) throw new Error("Expected a live synthetic report request.");
      release();
    });
    await expect.poll(() => page.evaluate(async (id) => {
      const result = await window.grudgeVault.records.get(id);
      return result.ok ? result.data.record.reportState : undefined;
    }, refreshingRecordId)).toBe("complete");
    await expect(page.locator(".report-summary")).toHaveText("搜索详情后台报告第 1 版已完成。");
    await expect(page.locator(".report-placeholder")).toHaveCount(0);
    await page.getByRole("button", { name: "重新分析", exact: true }).click();
    await expect.poll(() => application.evaluate(() => typeof (
      globalThis as typeof globalThis & { __gvE2eReleaseReportRefresh?: () => void }
    ).__gvE2eReleaseReportRefresh === "function")).toBe(true);
    await expect(page.getByText(/当前展示上一版报告，新报告完成后会自动切换/)).toBeVisible();
    await expect(page.locator(".report-summary")).toHaveText("搜索详情后台报告第 1 版已完成。");
    await page.getByRole("button", { name: "补充地点", exact: true }).click();
    await page.getByPlaceholder("输入明确地点").fill("尚未提交的本地地点");
    await page.getByRole("button", { name: "原始内容", exact: true }).click();
    await application.evaluate(() => {
      const release = (globalThis as typeof globalThis & { __gvE2eReleaseReportRefresh?: () => void }).__gvE2eReleaseReportRefresh;
      if (!release) throw new Error("Expected the second live synthetic report request.");
      release();
    });
    await expect.poll(() => page.evaluate(async (id) => {
      const result = await window.grudgeVault.records.get(id);
      return result.ok ? result.data.record.reportState : undefined;
    }, refreshingRecordId)).toBe("complete");
    await expect(page.getByRole("heading", { name: "原始文字", exact: true })).toBeVisible();
    await expect(page.locator(".report-summary")).toHaveCount(0);
    await page.getByRole("button", { name: "事件报告", exact: true }).click();
    await expect(page.locator(".report-summary")).toHaveText("搜索详情后台报告第 2 版已完成。");
    await expect(page.getByPlaceholder("输入明确地点")).toHaveValue("尚未提交的本地地点");
    await page.locator(".inline-editor.supplement").getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: /返回搜索结果/ }).click();
    await expect(page.getByRole("heading", { name: "搜索", exact: true })).toBeVisible();
    await expect(page.locator(".search-results article")).toHaveCount(1);
    await page.getByRole("button", { name: "时间线", exact: true }).click();

    await page.locator(".new-record-button").click();
    await page.getByRole("dialog", { name: "新建记录" }).getByLabel("发生了什么？")
      .fill("E2E取消报告：公司拒绝支付工资");
    await page.getByRole("dialog", { name: "新建记录" }).getByRole("button", { name: "判断并收录", exact: true }).click();
    const cancelledReportRecordId = await page.evaluate(async () => {
      const result = await window.grudgeVault.records.search({ text: "E2E取消报告" });
      return result.ok ? result.data.hits[0]?.record.id : undefined;
    });
    if (!cancelledReportRecordId) throw new Error("expected cancellable report record");
    await expect.poll(() => application.evaluate(() =>
      (globalThis as typeof globalThis & { __gvE2eCancelReportAttempts?: number }).__gvE2eCancelReportAttempts ?? 0
    )).toBe(1);
    await expect(page.locator(".detail-panel").getByRole("heading", { name: /E2E取消报告/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "取消分析" })).toBeVisible();
    const reportJobId = await page.evaluate(async (recordId) => {
      const result = await window.grudgeVault.jobs.list();
      return result.ok ? result.data.find((job) => job.type === "record.analyze" &&
        (job.payload as { recordId?: string }).recordId === recordId)?.id : undefined;
    }, cancelledReportRecordId);
    if (!reportJobId) throw new Error("expected running report job");
    await page.getByRole("button", { name: "取消分析" }).click();
    await expect.poll(() => page.evaluate(async (jobId) => {
      const result = await window.grudgeVault.jobs.list();
      return result.ok ? result.data.find((job) => job.id === jobId)?.state : undefined;
    }, reportJobId)).toBe("cancelled");
    await expect.poll(() => page.evaluate(async (recordId) => {
      const result = await window.grudgeVault.records.get(recordId);
      return result.ok ? result.data.record.reportState : undefined;
    }, cancelledReportRecordId)).toBe("failed");
    expect(await page.evaluate(async (recordId) => {
      const result = await window.grudgeVault.records.get(recordId);
      return result.ok ? result.data.report : undefined;
    }, cancelledReportRecordId)).toBeUndefined();
    await page.getByRole("button", { name: "重试分析" }).click();
    await expect.poll(() => page.evaluate(async (recordId) => {
      const result = await window.grudgeVault.records.get(recordId);
      return result.ok ? result.data.record.reportState : undefined;
    }, cancelledReportRecordId), { timeout: 20_000 }).toBe("complete");
    await expect.poll(() => application.evaluate(() =>
      (globalThis as typeof globalThis & { __gvE2eCancelReportAttempts?: number }).__gvE2eCancelReportAttempts ?? 0
    )).toBe(2);

    await page.locator(".new-record-button").click();
    const mediaAnchorEditor = page.getByRole("dialog", { name: "新建记录" });
    await mediaAnchorEditor.getByLabel("发生了什么？").fill("E2E错误媒体定位：合成录音中的争议需要核对");
    await mediaAnchorEditor.getByLabel("添加图片、音频或视频").setInputFiles(anchorWav);
    await mediaAnchorEditor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect.poll(() => page.evaluate(async () => {
      const search = await window.grudgeVault.records.search({ text: "E2E错误媒体定位" });
      if (!search.ok || !search.data.hits[0]) return false;
      const detail = await window.grudgeVault.records.get(search.data.hits[0].record.id);
      return detail.ok && detail.data.report?.content.mediaSegments?.some(({ description }) => description === "合成录音建议定位");
    }), { timeout: 20_000 }).toBe(true);
    await openDisclosure(page, "媒体片段");
    await expect(page.getByRole("button", { name: /合成录音建议定位/ })).toBeVisible();
    await page.getByRole("button", { name: /合成录音建议定位/ }).click();
    const audioPreview = page.locator(".attachment-preview audio");
    await expect(audioPreview).toBeVisible();
    await expect.poll(() => audioPreview.evaluate((element) => {
      const media = element as globalThis.HTMLAudioElement;
      return Number.isFinite(media.duration) ? media.duration : 0;
    })).toBeCloseTo(1, 2);
    await expect(page.getByText("模型建议定位超出原件时长或区间无效，已回到原件起点；请核对原件。"))
      .toBeVisible();
    expect(await audioPreview.evaluate((element) => (element as globalThis.HTMLAudioElement).currentTime)).toBeCloseTo(0, 2);
    await audioPreview.evaluate((element) => element.dispatchEvent(new globalThis.Event("error")));
    await expect(page.getByRole("alert")).toContainText("当前环境无法播放这个音频原件；可保存副本后用系统播放器核对。");
    await expect(page.getByRole("button", { name: "保存副本" })).toBeVisible();

    const settingsBeforeLateConnection = await page.evaluate(() => window.grudgeVault.llm.getSettings());
    const credentialsBeforeDatabase = new Database(join(workspace, "db", "grudge-vault.sqlite3"), { readonly: true });
    let credentialsBefore: unknown;
    try {
      credentialsBefore = credentialsBeforeDatabase.prepare(
        "SELECT provider, envelope_json FROM llm_provider_credentials ORDER BY provider"
      ).all();
    } finally { credentialsBeforeDatabase.close(); }
    await page.evaluate(() => {
      const state = globalThis as typeof globalThis & { __gvE2eLateConnectionResult?: IpcResult<LlmSettings> };
      delete state.__gvE2eLateConnectionResult;
      void window.grudgeVault.llm.connect({
        provider: "bailian", region: "cn-beijing", model: "e2e-delayed-connection", apiKey: "late-e2e-test-key"
      }).then((result) => { state.__gvE2eLateConnectionResult = result; });
    });
    await expect.poll(() => application.evaluate(() => typeof (
      globalThis as typeof globalThis & { __gvE2eReleaseConnection?: () => void }
    ).__gvE2eReleaseConnection === "function")).toBe(true);
    await page.getByRole("button", { name: "锁定", exact: true }).click();
    await expect(page.getByText("你的记录已收好")).toBeVisible();
    await page.getByRole("button", { name: "暂时打开账本" }).click();
    await expect(page.getByRole("heading", { name: "时间线" })).toBeVisible();
    await application.evaluate(() => {
      const release = (globalThis as typeof globalThis & { __gvE2eReleaseConnection?: () => void }).__gvE2eReleaseConnection;
      if (!release) throw new Error("Expected a live synthetic connection test.");
      release();
    });
    await expect.poll(() => page.evaluate(() => {
      const result = (globalThis as typeof globalThis & { __gvE2eLateConnectionResult?: IpcResult<LlmSettings> })
        .__gvE2eLateConnectionResult;
      return result && !result.ok ? result.error.code : undefined;
    })).toBe("LLM_CONFIGURATION_CHANGED");
    expect(await page.evaluate(() => window.grudgeVault.llm.getSettings())).toEqual(settingsBeforeLateConnection);
    const credentialsAfterDatabase = new Database(join(workspace, "db", "grudge-vault.sqlite3"), { readonly: true });
    try {
      expect(credentialsAfterDatabase.prepare(
        "SELECT provider, envelope_json FROM llm_provider_credentials ORDER BY provider"
      ).all()).toEqual(credentialsBefore);
    } finally { credentialsAfterDatabase.close(); }

    const configurationDatabase = new Database(join(workspace, "db", "grudge-vault.sqlite3"));
    const configurationRows = () => ({
      settings: configurationDatabase.prepare("SELECT * FROM llm_settings ORDER BY singleton").all(),
      providers: configurationDatabase.prepare("SELECT * FROM llm_provider_settings ORDER BY provider").all(),
      credentials: configurationDatabase.prepare("SELECT * FROM llm_provider_credentials ORDER BY provider").all()
    });
    const configurationBeforeFailure = configurationRows();
    configurationDatabase.exec(`CREATE TRIGGER e2e_reject_model_configuration AFTER UPDATE ON llm_settings
      BEGIN SELECT RAISE(FAIL, 'synthetic-model-write-failure'); END;`);
    try {
      const failedSave = await page.evaluate(() => window.grudgeVault.llm.connect({
        provider: "bailian", region: "cn-beijing", model: "e2e-store-failure", apiKey: "synthetic-store-failure-key"
      }));
      expect(failedSave.ok).toBe(false);
      if (!failedSave.ok) expect(failedSave.error.code).toBe("INTERNAL_ERROR");
      expect(configurationRows()).toEqual(configurationBeforeFailure);
      expect(await page.evaluate(() => window.grudgeVault.llm.getSettings())).toEqual(settingsBeforeLateConnection);
    } finally {
      configurationDatabase.exec("DROP TRIGGER e2e_reject_model_configuration");
      configurationDatabase.close();
    }
    const retriedSave = await page.evaluate(() => window.grudgeVault.llm.connect({
      provider: "bailian", region: "cn-beijing", model: "e2e-store-failure", apiKey: "synthetic-store-failure-key"
    }));
    expect(retriedSave.ok).toBe(true);
    if (retriedSave.ok) {
      expect(retriedSave.data.activeProvider).toBe("bailian");
      expect(retriedSave.data.providers.bailian?.model).toBe("e2e-store-failure");
    }

    await page.getByRole("button", { name: "锁定", exact: true }).click();
    await expect(page.getByText("你的记录已收好")).toBeVisible();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("restores aggregate ZIP import progress across navigation, cancels late results and safely reimports", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-zip-progress-e2e-"));
  const workspace = join(root, "workspace"); const userData = join(root, "user-data");
  const archive = join(root, "synthetic-private-title.zip");
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ entries: [
    { uuid: "PROGRESS-INCLUDE", creationDate: "2026-09-20T10:00:00Z", text: "合成导入进度首条奖金记录" },
    { uuid: "PROGRESS-SKIP", creationDate: "2026-09-20T10:00:00Z", text: "午饭后散步，下午工作顺利" },
    { uuid: "PROGRESS-REVIEW", creationDate: "2026-09-20T10:00:00Z", text: "他又这样说了，我有些不安" },
    { uuid: "PROGRESS-INVALID", text: "synthetic-private-invalid-body" },
    { uuid: "PROGRESS-LATE", creationDate: "2026-09-20T10:00:00Z", text: "E2E导入进度暂停的奖金记录" }
  ] })), "Journal.json");
  zip.end(); await pipeline(zip.outputStream as Readable, createWriteStream(archive));
  const originalHash = await hashFile(archive);
  const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
    env: { ...inheritedEnvironment, GRUDGE_VAULT_E2E_WORKSPACE: workspace } });
  try {
    const page = await application.firstWindow(); await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-progress-e2e-key" }))).toMatchObject({ ok: true });
    expect(await page.evaluate(() => window.grudgeVault.intake.dayOneImportProgress())).toEqual({ ok: true, data: null });
    await application.evaluate(({ dialog }, selectedZip) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedZip] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      (globalThis as typeof globalThis & { __gvE2eZipProgressHold?: boolean }).__gvE2eZipProgressHold = true;
    }, archive);
    const progress = () => page.evaluate(async () => {
      const value = await window.grudgeVault.intake.dayOneImportProgress(); return value.ok ? value.data : null;
    });
    const counts = () => {
      const database = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
      try { return ["redesign_records", "redesign_pending_reviews", "assets"].map((table) =>
        database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()); } finally { database.close(); }
    };
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "选择 Day One 导出 ZIP" }).click();
    await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eZipProgressStarted?: boolean;
    }).__gvE2eZipProgressStarted)).toBe(true);
    await expect.poll(progress).toMatchObject({ phase: "screening", totalEntries: 5, included: 1, skipped: 1, review: 1, failed: 1, issueCount: 1 });
    const first = (await progress())!;
    expect(JSON.stringify(first)).not.toMatch(/synthetic|PROGRESS|奖金|散步|这样|\.zip|Journal|workspace|key/);
    expect(Object.keys(first).sort()).toEqual(["operationId", "phase", "totalEntries", "included", "skipped", "review", "failed", "issueCount", "updatedAt"].sort());
    expect(counts()).toEqual([1, 1, 0]);
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await expect(page.locator(".record-card")).toHaveCount(1);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsGroup(page, "导入");
    await expect(page.getByRole("status", { name: "Day One 导入进度" })).toContainText("已处理 4 条／包内共 5 条：收录 1，跳过 1，待确认 1，失败 1");
    await expect(page.getByRole("button", { name: "正在逐条筛选…", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "停止本次导入" }).click();
    await expect.poll(progress).toMatchObject({ phase: "stopping", included: 1 });
    await expect(page.getByRole("button", { name: "停止本次导入" })).toBeDisabled();
    await application.evaluate(() => {
      const state = globalThis as typeof globalThis & { __gvE2eZipProgressRelease?: () => void; __gvE2eZipProgressHold?: boolean };
      state.__gvE2eZipProgressHold = false; state.__gvE2eZipProgressRelease?.();
    });
    await expect.poll(progress).toMatchObject({ phase: "cancelled", totalEntries: 5, included: 1, skipped: 1, review: 1, failed: 1, issueCount: 1,
      errorCode: "IMPORT_CANCELLED" });
    await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eZipProgressFinished?: boolean;
    }).__gvE2eZipProgressFinished)).toBe(true);
    expect(counts()).toEqual([1, 1, 0]);
    await expect.poll(() => readdir(join(userData, ".grudge-vault-redesign-transient-v1"))).toEqual([".owned-by-grudge-vault"]);
    await settingsGroup(page, "导入");
    await expect(page.getByRole("status", { name: "Day One 导入进度" })).toContainText("本次导入已取消或停止");
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsGroup(page, "导入");
    await expect(page.getByRole("status", { name: "Day One 导入进度" })).toContainText("已处理 4 条／包内共 5 条");
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "选择 Day One 导出 ZIP" }).click();
    await expect.poll(progress).toMatchObject({ phase: "completed", included: 2, skipped: 1, review: 1, failed: 1,
      summary: { totalEntries: 5, included: 2, skipped: 1, review: 1, failed: 1, issueCount: 1, mediaEntries: 0, missingMedia: 0 } });
    expect((await progress())?.operationId).not.toBe(first.operationId);
    await settingsGroup(page, "导入");
    await expect(page.getByRole("status", { name: "Day One 导入进度" })).toContainText("已检查 5 条：收录 2，跳过 1，待确认 1，失败 1");
    expect(counts()).toEqual([2, 1, 0]); expect(await hashFile(archive)).toBe(originalHash);
    await expect.poll(() => readdir(join(userData, ".grudge-vault-redesign-transient-v1"))).toEqual([".owned-by-grudge-vault"]);
    await page.getByRole("button", { name: "锁定", exact: true }).click();
    await expect(page.getByText("你的记录已收好")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.intake.dayOneImportProgress())).toEqual({ ok: true, data: null });
    await page.getByRole("button", { name: "暂时打开账本" }).click();
    await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.intake.dayOneImportProgress())).toEqual({ ok: true, data: null });
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

test("recovers a paused ZIP status after one IPC read stalls without accepting its late completion", async () => {
  test.setTimeout(35_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-zip-stalled-read-e2e-"));
  const workspace = join(root, "workspace"), userData = join(root, "user-data");
  const manager = new LocalWorkspaceManager({
    async assertAvailable() {}, async protect(key) { return `e2e:${key.toString("base64")}`; },
    async unprotect(envelope) { return { key: Buffer.from(envelope.slice(4), "base64") }; }
  }, join(root, "synthetic-state.json"));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const seed = new GrudgeVaultApplication(manager);
    await seed.createWorkspace(workspace, "Synthetic Stalled Progress Vault");
    await seed.updateWorkspaceSecuritySettings({ autoLockMinutes: 0, integrityScanIntervalDays: 30 });
    await manager.close();
    const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
    application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
      env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: workspace,
        GRUDGE_VAULT_E2E_STALLED_ZIP_PROGRESS: "1", GRUDGE_VAULT_E2E_NO_NETWORK: "1" } });
    const page = await application.firstWindow(); await expect(page.locator(".new-record-button")).toBeVisible();
    await expect.poll(() => application!.evaluate(() => Boolean((globalThis as typeof globalThis & {
      __gvE2eZipStatusHandlerReady?: boolean
    }).__gvE2eZipStatusHandlerReady))).toBe(true);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect.poll(() => application!.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eZipStatusReads?: number
    }).__gvE2eZipStatusReads ?? 0)).toBe(1);
    await settingsGroup(page, "导入");
    await expect(page.getByText("暂时无法读取导入进度，正在重新连接；不会重新开始导入。"))
      .toBeVisible({ timeout: 9_000 });
    await settingsGroup(page, "导入");
    await expect(page.getByRole("button", { name: "继续筛选", exact: true })).toBeVisible({ timeout: 9_000 });
    await settingsGroup(page, "导入");
    await expect(page.getByRole("status", { name: "Day One 导入进度" })).toContainText("筛选已暂停");
    await expect.poll(() => application!.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eZipStatusReads?: number
    }).__gvE2eZipStatusReads ?? 0)).toBeGreaterThanOrEqual(3);
    await application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eReleaseOldZipStatus?: () => void
    }).__gvE2eReleaseOldZipStatus?.());
    await page.waitForTimeout(200);
    await settingsGroup(page, "导入");
    await expect(page.getByRole("button", { name: "继续筛选", exact: true })).toBeVisible();
    await settingsGroup(page, "导入");
    await expect(page.getByRole("status", { name: "Day One 导入进度" })).toContainText("筛选已暂停");
    expect(await application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eInferenceCalls?: number
    }).__gvE2eInferenceCalls ?? 0)).toBe(0);
    const database = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
    try { expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(0); }
    finally { database.close(); }
  } finally {
    if (application) {
      await application.evaluate(() => {
        const state = globalThis as typeof globalThis & {
          __gvE2eReleaseOldZipStatus?: () => void; __gvE2eReleaseLaterZipStatuses?: () => void
        };
        state.__gvE2eReleaseOldZipStatus?.(); state.__gvE2eReleaseLaterZipStatuses?.();
      }).catch(() => {});
      await application.close();
    }
    await manager.close(); await rm(root, { recursive: true, force: true });
  }
});

test("pauses a ZIP at entry boundaries, resumes without repeat calls and releases paused work on stop or lock", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-zip-pause-e2e-"));
  const workspace = join(root, "workspace"); const userData = join(root, "user-data");
  const archives: string[] = [];
  for (const [index, texts] of [
    ["午饭后散步，合成暂停首条", "E2E导入进度暂停的奖金记录一", "午饭后散步，合成暂停中间条", "E2E导入进度暂停的奖金记录二", "合成暂停最后奖金记录"],
    ["E2E导入进度暂停的合成停止记录", "合成停止后不得调用"],
    ["E2E导入进度暂停的合成锁定记录", "合成锁定后不得调用"]
  ].entries()) {
    const archive = join(root, `synthetic-pause-${index}.zip`); const zip = new ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify({ entries: texts.map((text, item) => ({
      uuid: `PAUSE-${index}-${item}`, creationDate: "2026-09-20T10:00:00Z", text
    })) })), "Journal.json");
    zip.end(); await pipeline(zip.outputStream as Readable, createWriteStream(archive)); archives.push(archive);
  }
  const originalHashes = await Promise.all(archives.map(hashFile));
  const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
    env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NO_NETWORK: "1" } });
  try {
    const page = await application.firstWindow(); await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-pause-e2e-key" }))).toMatchObject({ ok: true });
    const progress = () => page.evaluate(async () => {
      const value = await window.grudgeVault.intake.dayOneImportProgress(); return value.ok ? value.data : null;
    });
    const modelCalls = () => application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eZipPauseScreenCalls?: number;
    }).__gvE2eZipPauseScreenCalls ?? 0);
    const selectArchive = async (archive: string) => application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      const state = globalThis as typeof globalThis & { __gvE2eZipProgressHold?: boolean;
        __gvE2eZipProgressStarted?: boolean; __gvE2eZipPauseScreenCalls?: number; __gvE2eZipUsage?: boolean };
      state.__gvE2eZipProgressHold = true; state.__gvE2eZipProgressStarted = false; state.__gvE2eZipPauseScreenCalls = 0;
      state.__gvE2eZipUsage = true;
    }, archive);
    const waitHeld = async () => expect.poll(() => application.evaluate(() => Boolean((globalThis as typeof globalThis & {
      __gvE2eZipProgressRelease?: () => void;
    }).__gvE2eZipProgressRelease))).toBe(true);
    const releaseHeld = async () => application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eZipProgressRelease?: () => void;
    }).__gvE2eZipProgressRelease?.());
    const counts = () => {
      const database = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
      try { return ["redesign_records", "redesign_pending_reviews", "assets"].map((table) =>
        database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()); } finally { database.close(); }
    };
    const control = (id: string, resume: boolean) => page.evaluate(({ operationId, continuing }) => continuing
      ? window.grudgeVault.intake.resumeDayOneZip(operationId) : window.grudgeVault.intake.pauseDayOneZip(operationId),
    { operationId: id, continuing: resume });
    const clickPause = async () => {
      try { await page.getByRole("button", { name: "暂停筛选", exact: true }).click(); }
      catch (cause) {
        // Aggregate diagnostics for this synthetic fixture only; preserve the original failure and timeout.
        const main = await progress();
        const renderer = await page.evaluate(() => {
          const buttons = [...document.querySelectorAll("button")];
          const states = (label: string) => buttons.filter((button) => button.textContent === label).map((button) => ({
            disabled: button.disabled, rendered: button.getClientRects().length > 0
          }));
          return { visibility: document.visibilityState, focused: document.hasFocus(),
            settingsSelected: document.querySelector("nav button.active")?.getAttribute("aria-label") === "设置",
            pause: states("暂停筛选"), resume: states("继续筛选"), withdraw: states("撤销暂停"),
            progressBanner: document.querySelector('[aria-label="Day One 导入进度"]')?.textContent ?? null,
            readUnavailable: [...document.querySelectorAll('[role="status"]')]
              .some((element) => element.textContent?.includes("暂时无法读取导入进度")) };
        });
        await test.info().attach("synthetic-zip-pause-state", { contentType: "application/json", body: Buffer.from(JSON.stringify({
          main: main && { phase: main.phase, included: main.included, skipped: main.skipped, review: main.review,
            failed: main.failed, totalEntries: main.totalEntries }, renderer, modelCalls: await modelCalls()
        })) });
        throw cause;
      }
    };
    const cleanTemporary = async () => expect.poll(() => readdir(join(userData, ".grudge-vault-redesign-transient-v1")))
      .toEqual([".owned-by-grudge-vault"]);
    await selectArchive(archives[0]!); await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "选择 Day One 导出 ZIP" }).click(); await waitHeld();
    await expect.poll(progress).toMatchObject({ phase: "screening", skipped: 1, included: 0, totalEntries: 5 });
    expect((await progress())?.usage).toEqual({ requests: 2, responses: 1, completeUsageResponses: 1, promptTokens: 20, completionTokens: 5 });
    await expect(page.getByRole("status", { name: "Day One 筛选用量" })).toContainText("有 1 次请求未取得完整用量");
    const firstId = (await progress())!.operationId;
    expect(await control(randomUUID(), false)).toEqual({ ok: true, data: false });
    expect(await control("not-a-uuid", true)).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await control(firstId, true)).toEqual({ ok: true, data: false });
    await clickPause();
    await expect.poll(progress).toMatchObject({ phase: "pausing", skipped: 1, included: 0 });
    await settingsGroup(page, "导入");
    await expect(page.getByRole("status", { name: "Day One 导入进度" })).toContainText("等待当前条目处理完");
    await page.getByRole("button", { name: "撤销暂停" }).click();
    await expect.poll(progress).toMatchObject({ phase: "screening" });
    await clickPause();
    await expect.poll(progress).toMatchObject({ phase: "pausing" }); await releaseHeld();
    await expect.poll(progress).toMatchObject({ operationId: firstId, phase: "paused", skipped: 1, included: 1 });
    expect(await modelCalls()).toBe(2); expect(counts()).toEqual([1, 0, 0]);
    expect(await control(firstId, false)).toEqual({ ok: true, data: false });
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsGroup(page, "导入");
    await expect(page.getByRole("button", { name: "继续筛选", exact: true })).toBeVisible();
    await settingsGroup(page, "导入");
    await expect(page.getByRole("status", { name: "Day One 导入进度" })).toContainText("不重复检查已处理条目");
    expect(await modelCalls()).toBe(2); expect((await progress())?.phase).toBe("paused");
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "继续筛选", exact: true }).click(); await waitHeld();
    await expect.poll(progress).toMatchObject({ operationId: firstId, phase: "screening", skipped: 2, included: 1 });
    expect(await modelCalls()).toBe(4);
    await clickPause();
    await expect.poll(progress).toMatchObject({ phase: "pausing" }); await releaseHeld();
    await expect.poll(progress).toMatchObject({ phase: "paused", skipped: 2, included: 2 });
    expect(await modelCalls()).toBe(4);
    await expect.poll(async () => {
      const banner = page.getByRole("status", { name: "Day One 导入进度" });
      return { phase: (await progress())?.phase,
        continueButtons: await page.getByRole("button", { name: "继续筛选", exact: true }).count(),
        activeNavigation: await page.locator(".sidebar nav button.active").textContent(),
        visibleProgress: await banner.count() ? await banner.textContent() : null };
    }, { timeout: 10_000 }).toMatchObject({ phase: "paused", continueButtons: 1 });
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "继续筛选", exact: true }).click();
    await expect.poll(progress).toMatchObject({ operationId: firstId, phase: "completed", included: 3, skipped: 2,
      summary: { totalEntries: 5, included: 3, skipped: 2, review: 0, failed: 0 } });
    expect(await modelCalls()).toBe(5); expect(counts()).toEqual([3, 0, 0]); await cleanTemporary();
    expect((await progress())?.usage).toEqual({ requests: 5, responses: 5, completeUsageResponses: 4, promptTokens: 80, completionTokens: 22 });
    await expect(page.getByRole("status", { name: "Day One 筛选用量" })).toContainText("输入 80、输出 22 token");
    await expect(page.getByRole("status", { name: "Day One 筛选用量" })).toContainText("累计并不完整");
    expect(await control(firstId, true)).toEqual({ ok: true, data: false });

    for (const index of [1, 2]) {
      await settingsGroup(page, "导入");
      await selectArchive(archives[index]!); await page.getByRole("button", { name: "选择 Day One 导出 ZIP" }).click(); await waitHeld();
      await expect.poll(progress).toMatchObject({ phase: "screening", included: 0 });
      const currentId = (await progress())!.operationId;
      expect(await control(firstId, false)).toEqual({ ok: true, data: false });
      await clickPause();
      await expect.poll(progress).toMatchObject({ phase: "pausing" }); await releaseHeld();
      await expect.poll(progress).toMatchObject({ phase: "paused", included: 1, totalEntries: 2 });
      expect(await modelCalls()).toBe(1); expect(counts()).toEqual([3 + index, 0, 0]);
      if (index === 1) {
        await page.getByRole("button", { name: "停止本次导入" }).click();
        await expect.poll(progress).toMatchObject({ phase: "cancelled", included: 1, errorCode: "IMPORT_CANCELLED" });
        const stoppedReceipt = await page.evaluate(() => window.grudgeVault.intake.lastDayOneImportReceipt());
        expect(stoppedReceipt).toMatchObject({ ok: true, data: { outcome: "cancelled", included: 1, totalEntries: 2,
          errorCode: "IMPORT_CANCELLED" } });
        expect(stoppedReceipt.ok && stoppedReceipt.data?.missingMedia).toBeUndefined();
        expect(await control(currentId, true)).toEqual({ ok: true, data: false });
      } else {
        const priorReceipt = await page.evaluate(() => window.grudgeVault.intake.lastDayOneImportReceipt());
        await page.getByRole("button", { name: "锁定", exact: true }).click();
        await expect(page.getByText("你的记录已收好")).toBeVisible(); expect(await progress()).toBeNull();
        expect(await control(currentId, true)).toEqual({ ok: true, data: false });
        await cleanTemporary();
        await page.getByRole("button", { name: "暂时打开账本" }).click(); await expect(page.locator(".new-record-button")).toBeVisible();
        expect(await progress()).toBeNull(); expect(await control(currentId, true)).toEqual({ ok: true, data: false });
        expect(await page.evaluate(() => window.grudgeVault.intake.lastDayOneImportReceipt())).toEqual(priorReceipt);
      }
      await cleanTemporary(); expect(await modelCalls()).toBe(1); expect(counts()).toEqual([3 + index, 0, 0]);
    }
    expect(await Promise.all(archives.map(hashFile))).toEqual(originalHashes);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number })
      .__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

test("keeps only terminal ZIP aggregates across restart and separates receipt failure from committed imports", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-zip-receipt-e2e-"));
  const workspace = join(root, "workspace"); const userData = join(root, "user-data");
  const archives: string[] = [];
  for (const index of [0, 1]) {
    const archive = join(root, `synthetic-receipt-${index}.zip`); const zip = new ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify({ entries: ["午饭后散步", "合成奖金争议"].map((text, item) => ({
      uuid: `RECEIPT-${index}-${item}`, creationDate: "2026-09-20T10:00:00Z", text: `${text}批次${index}`
    })) })), "Journal.json");
    zip.end(); await pipeline(zip.outputStream as Readable, createWriteStream(archive)); archives.push(archive);
  }
  const originalHashes = await Promise.all(archives.map(hashFile));
  const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const launch = () => electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
    env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NO_NETWORK: "1" } });
  let application = await launch();
  try {
    let page = await application.firstWindow(); await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-receipt-e2e-key" }))).toMatchObject({ ok: true });
    const progress = () => page.evaluate(async () => {
      const result = await window.grudgeVault.intake.dayOneImportProgress(); return result.ok ? result.data : null;
    });
    const receipt = () => page.evaluate(async () => {
      const result = await window.grudgeVault.intake.lastDayOneImportReceipt(); return result.ok ? result.data : null;
    });
    const calls = () => application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eZipPauseScreenCalls?: number;
    }).__gvE2eZipPauseScreenCalls ?? 0);
    const networkAttempts = () => application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eUnexpectedNetwork?: number;
    }).__gvE2eUnexpectedNetwork ?? 0);
    const withDatabase = <T,>(operation: (database: Database.Database) => T): T => {
      const database = new Database(join(workspace, "db/grudge-vault.sqlite3"));
      try { return operation(database); } finally { database.close(); }
    };
    const count = () => withDatabase((database) => database.prepare("SELECT count(*) FROM redesign_records").pluck().get());
    const selectArchive = (path: string) => application.evaluate(({ dialog }, archive) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      const state = globalThis as typeof globalThis & { __gvE2eZipPauseScreenCalls?: number; __gvE2eZipUsage?: boolean };
      state.__gvE2eZipPauseScreenCalls = 0; state.__gvE2eZipUsage = true;
    }, path);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    expect(await receipt()).toBeNull(); await selectArchive(archives[0]!);
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "选择 Day One 导出 ZIP" }).click();
    await expect.poll(progress).toMatchObject({ phase: "completed", included: 1, skipped: 1, receiptSaved: true });
    const firstReceipt = (await receipt())!;
    expect(firstReceipt).toMatchObject({ outcome: "completed", totalEntries: 2, included: 1, skipped: 1, review: 0,
      failed: 0, issueCount: 0, mediaEntries: 0, missingMedia: 0,
      usage: { requests: 2, responses: 2, completeUsageResponses: 2, promptTokens: 40, completionTokens: 10 } });
    expect(Object.keys(firstReceipt).sort()).toEqual(["finishedAt", "outcome", "totalEntries", "included", "skipped", "review",
      "failed", "issueCount", "mediaEntries", "missingMedia", "usage"].sort());
    expect(firstReceipt.finishedAt).toBe((await progress())!.updatedAt);
    expect(JSON.stringify(firstReceipt)).not.toMatch(/RECEIPT-|合成|synthetic|Journal|operationId|apiKey|workspace/);
    expect(await calls()).toBe(2); expect(count()).toBe(1);
    await expect(page.getByLabel("Day One 导入结束时间")).toContainText("本机时间");
    expect(await networkAttempts()).toBe(0);
    await application.close(); application = await launch(); page = await application.firstWindow();
    await expect(page.locator(".new-record-button")).toBeVisible(); expect(await progress()).toBeNull();
    expect(await receipt()).toEqual(firstReceipt); expect(await calls()).toBe(0);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsGroup(page, "导入");
    await expect(page.getByRole("status", { name: "Day One 上次导入摘要" })).toContainText("所选包共 2 条");
    await settingsGroup(page, "导入");
    await expect(page.getByRole("status", { name: "Day One 上次导入摘要" })).toContainText("不是可恢复的导入断点");
    await settingsGroup(page, "导入");
    await expect(page.getByRole("status", { name: "Day One 上次导入摘要" })).toContainText("输入 40、输出 10 token");
    await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "选择 Day One 导出 ZIP" }).click();
    await expect.poll(progress).toMatchObject({ phase: "cancelled", totalEntries: null });
    expect(await receipt()).toEqual(firstReceipt); expect(await calls()).toBe(0);
    await selectArchive(archives[1]!);
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "选择 Day One 导出 ZIP" }).click();
    await expect.poll(progress).toMatchObject({ phase: "cancelled", totalEntries: 2 });
    expect(await receipt()).toEqual(firstReceipt); expect(await calls()).toBe(0);
    withDatabase((database) => database.exec(`CREATE TRIGGER reject_receipt AFTER UPDATE ON workspace_settings
      WHEN NEW.key = 'redesign.last-dayone-import-v1'
      BEGIN SELECT RAISE(FAIL, 'synthetic-private-receipt-failure'); END;`));
    await settingsGroup(page, "导入");
    await selectArchive(archives[1]!); await page.getByRole("button", { name: "选择 Day One 导出 ZIP" }).click();
    await expect.poll(progress).toMatchObject({ phase: "completed", included: 1, skipped: 1, receiptSaved: false });
    await expect(page.getByRole("status").filter({ hasText: "未能保存本次批次摘要" })).toContainText("请勿仅为补摘要重新导入");
    expect(count()).toBe(2); expect(await receipt()).toEqual(firstReceipt); expect(await calls()).toBe(2);
    withDatabase((database) => database.exec("DROP TRIGGER reject_receipt"));
    expect(await networkAttempts()).toBe(0);
    await application.close(); application = await launch(); page = await application.firstWindow();
    await expect(page.locator(".new-record-button")).toBeVisible(); expect(await progress()).toBeNull();
    expect(await receipt()).toEqual(firstReceipt); expect(count()).toBe(2); expect(await calls()).toBe(0);
    withDatabase((database) => database.prepare("UPDATE workspace_settings SET value_json = ? WHERE key = ?")
      .run("synthetic-private-corrupt-receipt", "redesign.last-dayone-import-v1"));
    const unavailable = await page.evaluate(() => window.grudgeVault.intake.lastDayOneImportReceipt());
    expect(unavailable).toMatchObject({ ok: false, error: { code: "SOURCE_UNAVAILABLE" } });
    expect(JSON.stringify(unavailable)).not.toContain("synthetic-private");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsGroup(page, "导入");
    await expect(page.getByRole("button", { name: "重新读取摘要" })).toBeVisible();
    await settingsGroup(page, "导入");
    await expect(page.getByRole("status", { name: "Day One 上次导入摘要" })).toHaveCount(0);
    withDatabase((database) => database.prepare("UPDATE workspace_settings SET value_json = ? WHERE key = ?")
      .run(JSON.stringify(firstReceipt), "redesign.last-dayone-import-v1"));
    await page.getByRole("button", { name: "重新读取摘要" }).click();
    await settingsGroup(page, "导入");
    await expect(page.getByRole("status", { name: "Day One 上次导入摘要" })).toContainText("扫描完成");
    expect(await calls()).toBe(0); expect(await Promise.all(archives.map(hashFile))).toEqual(originalHashes);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number })
      .__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

test("shows report precision and person provenance and protects person supplements through reanalysis", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-report-fields-e2e-"));
  const workspace = join(root, "workspace"); const userData = join(root, "user-data");
  const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
    env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NO_NETWORK: "1" } });
  try {
    const page = await application.firstWindow(); await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-report-fields-key" }))).toMatchObject({ ok: true });
    const create = async (text: string) => {
      await page.locator(".new-record-button").click(); const editor = page.getByRole("dialog", { name: "新建记录" });
      await editor.getByLabel("发生了什么？").fill(text); await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
      await expect(page.locator(".report-summary")).toHaveText("项目奖金尚未结清，需要核对约定与付款记录。");
    };
    const firstText = "E2E报告字段来源：约在九月有合成奖金争议，参与者信息仍须核对。";
    await create(firstText);
    const timeField = page.locator(".field-grid .report-field").filter({ has: page.locator("span", { hasText: /^时间$/ }) });
    const peopleField = page.locator(".report-people-field");
    await expect(timeField).toContainText("约在九月（大约时间）"); await expect(timeField.locator("em")).toHaveText("AI 整理");
    await expect(peopleField.locator("li em")).toHaveText(["来自原始材料", "AI 整理"]);
    await expect(peopleField.locator("li").nth(1)).not.toContainText("合成角色");
    const reportWindow = await application.browserWindow(page);
    for (const width of [1440, 1024, 840, 390]) {
      await reportWindow.evaluate((browserWindow, size) => browserWindow.setContentSize(size, 900), width);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
      expect(await peopleField.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return Array.from(element.querySelectorAll("strong, em, button"), (child) => child.getBoundingClientRect())
          .every((child) => child.left >= bounds.left - 1 && child.right <= bounds.right + 1);
      })).toBe(true);
    }
    await reportWindow.evaluate((browserWindow) => browserWindow.setContentSize(1024, 900));
    await page.getByRole("button", { name: "补充人物信息" }).click();
    const statement = "我记得合成人物补充名称参与沟通，具体角色仍需核对。";
    await expect(page.getByRole("textbox", { name: /针对“有哪些相关人物及角色？”的补充说明/ })).toBeFocused();
    await page.getByRole("textbox", { name: /针对“有哪些相关人物及角色？”的补充说明/ }).fill(statement);
    await page.getByRole("button", { name: "保存补充" }).click();
    await expect(page.getByText(`你已补充（用户陈述，待核对）：${statement}`)).toBeVisible();
    await page.getByRole("button", { name: "重新分析", exact: true }).click();
    const detail = () => page.evaluate(async () => {
      const result = await window.grudgeVault.records.search({ text: "合成人物补充名称" });
      if (!result.ok || !result.data.hits[0]) return null;
      const detail = await window.grudgeVault.records.get(result.data.hits[0].record.id); return detail.ok ? detail.data : null;
    });
    await expect.poll(async () => (await detail())?.record.reportState).toBe("complete");
    const updated = (await detail())!;
    expect(updated.source.text).toBe(firstText);
    expect(updated.overrides.find(({ fieldKey }) => fieldKey === "clarifications")?.value)
      .toEqual([{ kind: "unknown", topic: "有哪些相关人物及角色？", response: statement }]);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eReportFieldPrompts?: string[] })
      .__gvE2eReportFieldPrompts?.at(-1)?.includes('clarifications=[{"kind":"unknown","topic":"有哪些相关人物及角色？","response":"我记得合成人物补充名称参与沟通，具体角色仍需核对。"}]'))).toBe(true);
    await expect(peopleField.locator("li em")).toHaveText(["来自原始材料", "AI 整理"]);
    await expect(page.getByText(`你已补充（用户陈述，待核对）：${statement}`)).toBeVisible();
    await page.getByRole("button", { name: "返回时间线" }).click();
    await create("E2E报告字段来源人物待补充：合成奖金争议，没有明确日期与人物。");
    await expect(timeField).toContainText("待补充：大约何时发生？"); await expect(timeField).not.toContainText("2099");
    expect(await page.evaluate(async () => {
      const result = await window.grudgeVault.records.search({ text: "2099" }); return result.ok ? result.data.hits.length : -1;
    })).toBe(0);
    expect(await page.evaluate(async () => {
      const result = await window.grudgeVault.records.search({ text: "E2E报告字段来源人物待补充" });
      if (!result.ok || !result.data.hits[0]) return null;
      const detail = await window.grudgeVault.records.get(result.data.hits[0].record.id);
      return detail.ok ? { state: detail.data.record.reportState, time: detail.data.report?.content.time } : null;
    })).toMatchObject({ state: "complete", time: { source: "ai", prompt: "待补充：大约何时发生？" } });
    await expect(peopleField).toContainText("待补充：有哪些相关人物？"); await expect(peopleField.locator("li")).toHaveCount(0);
    await page.getByRole("button", { name: "补充人物信息" }).click();
    await expect(page.getByRole("textbox", { name: /有哪些相关人物及角色/ })).toBeVisible();
    await page.locator(".clarification-editor").getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "补充时间", exact: true }).click();
    await page.locator('.supplement input[type="date"]').fill("2026-09-21");
    await page.locator(".supplement").getByRole("button", { name: "保存", exact: true }).click();
    await expect(timeField).toContainText("2026-09-21"); await expect(timeField.locator("em")).toHaveText("你已补充");
    await expect(timeField).not.toContainText("2099");
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number })
      .__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

test("highlights original Unicode text after a length-changing lowercase conversion", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-text-anchor-e2e-"));
  const workspace = join(root, "workspace"); const userData = join(root, "user-data");
  const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
    env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NO_NETWORK: "1" } });
  try {
    const page = await application.firstWindow(); await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-text-anchor-key" }))).toMatchObject({ ok: true });
    const original = "İİ😀合成目标奖金争议与完整原文";
    await page.locator(".new-record-button").click(); const editor = page.getByRole("dialog", { name: "新建记录" });
    await editor.getByLabel("发生了什么？").fill(original); await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(page.locator(".report-summary")).toBeVisible();
    const result = await page.evaluate(() => window.grudgeVault.records.search({ text: "目标" }));
    expect(result).toMatchObject({ ok: true, data: { hits: [{ anchor: { surface: "source", textRange: [5, 7] } }] } });
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByPlaceholder("描述你记得的内容…").fill("目标");
    await page.getByLabel("使用百炼语义检索").uncheck();
    await page.locator(".search-input").getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByText("找到 1 条记录")).toBeVisible();
    await expect(page.getByText("定位到原文第 6 字")).toBeVisible();
    await page.locator(".search-results").getByRole("button").first().click();
    await expect(page.locator(".source-view pre mark")).toHaveText("目标");
    await expect(page.locator(".source-view pre")).toHaveText(original);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number })
      .__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

test("repairs old report keyword coverage offline and preserves month ranges and calendar dates in the timeline", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-report-time-e2e-"));
  const workspace = join(root, "workspace"); const userData = join(root, "user-data");
  const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const launch = () => electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
    env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NO_NETWORK: "1" } });
  let application = await launch();
  try {
    let page = await application.firstWindow(); await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-report-time-key" }))).toMatchObject({ ok: true });
    const original = "E2E报告字段来源 合成奖金争议与完整原文";
    await page.locator(".new-record-button").click(); const editor = page.getByRole("dialog", { name: "新建记录" });
    await editor.getByLabel("发生了什么？").fill(original); await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(page.locator(".report-summary")).toBeVisible();
    const before = await page.evaluate(async () => {
      const timeline = await window.grudgeVault.records.timeline({});
      if (!timeline.ok || timeline.data.records.length !== 1) throw new Error("Expected one synthetic record");
      const detail = await window.grudgeVault.records.get(timeline.data.records[0]!.id);
      if (!detail.ok) throw new Error("Expected synthetic report detail");
      return detail.data;
    });
    expect(before.report?.content.time.value?.value).toBe("约在九月");
    expect(await page.evaluate(() => window.grudgeVault.records.search({ text: "约在九月" })))
      .toMatchObject({ ok: true, data: { hits: [{ anchor: { surface: "report" } }] } });
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
    await application.close();
    const oldDatabase = new Database(join(workspace, "db/grudge-vault.sqlite3"));
    try {
      oldDatabase.prepare("UPDATE redesign_record_fts SET report_text = '' WHERE record_id = ?").run(before.record.id);
      oldDatabase.prepare("DELETE FROM workspace_settings WHERE key = 'redesign.keyword-projection-v2'").run();
    } finally { oldDatabase.close(); }
    application = await launch(); page = await application.firstWindow(); await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eInferenceCalls?: number }).__gvE2eInferenceCalls ?? 0)).toBe(0);
    const unchanged = await page.evaluate((id) => window.grudgeVault.records.get(id), before.record.id);
    expect(unchanged).toEqual({ ok: true, data: before });
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByPlaceholder("描述你记得的内容…").fill("约在九月"); await page.getByLabel("使用百炼语义检索").uncheck();
    await page.locator(".search-input").getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByText("找到 1 条记录")).toBeVisible();
    await expect(page.getByText("定位到事件报告")).toBeVisible();
    await page.locator(".search-results").getByRole("button").first().click();
    await expect(page.locator(".report-field").filter({ hasText: "时间" }).locator("strong"))
      .toHaveText("约在九月（大约时间）");
    expect(await page.evaluate((id) => window.grudgeVault.records.patchFields({ recordId: id, expectedRevision: 1,
      patch: { occurredAt: { kind: "range", from: "2026-09", to: "2026-10" } }
    }), before.record.id)).toMatchObject({ ok: true });
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await expect(page.locator(".timeline-groups h2")).toHaveText("2026-09 — 2026-10 · 时间范围");
    expect(await page.evaluate((id) => window.grudgeVault.records.patchFields({ recordId: id, expectedRevision: 2,
      patch: { occurredAt: { kind: "date", value: "2026-09-20" } }
    }), before.record.id)).toMatchObject({ ok: true });
    const browserClock = await page.context().newCDPSession(page);
    await browserClock.send("Emulation.setTimezoneOverride", { timezoneId: "America/Los_Angeles" });
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await expect(page.locator(".timeline-groups h2")).toHaveText("2026年9月20日");
    expect(await page.evaluate((id) => window.grudgeVault.records.get(id), before.record.id))
      .toMatchObject({ ok: true, data: { source: { text: original } } });
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eInferenceCalls?: number }).__gvE2eInferenceCalls ?? 0)).toBe(0);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

// Playwright requires fixture destructuring even though this test owns its Electron process.
// eslint-disable-next-line no-empty-pattern
test("excludes obsolete same-revision report fragments and shows partial semantic coverage until the new index activates", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-current-search-e2e-"));
  const workspace = join(root, "workspace"), userData = join(root, "user-data");
  const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
    env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NO_NETWORK: "1", GRUDGE_VAULT_E2E_SEARCH_FLOW: "1" } })
    .catch(async (error: unknown) => { await rm(root, { recursive: true, force: true }); throw error; });
  try {
    const page = await application.firstWindow(); await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-search-currency-key" }))).toMatchObject({ ok: true });
    const id = await page.evaluate(async () => {
      const prepared = await window.grudgeVault.intake.prepare({ requestId: globalThis.crypto.randomUUID(),
        text: "E2E搜索报告刷新：公司拒绝按约定支付奖金", files: [] });
      if (!prepared.ok) throw new Error("Expected synthetic intake");
      const saved = await window.grudgeVault.intake.screenAndSave(prepared.data.sessionId, globalThis.crypto.randomUUID());
      if (!saved.ok || saved.data.kind !== "saved") throw new Error("Expected synthetic saved record");
      return saved.data.recordId;
    });
    const releaseReport = async () => {
      await expect.poll(() => application.evaluate(() => typeof (globalThis as typeof globalThis & {
        __gvE2eReleaseReportRefresh?: () => void;
      }).__gvE2eReleaseReportRefresh)).toBe("function");
      await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eReleaseReportRefresh?: () => void }).__gvE2eReleaseReportRefresh!());
      await expect.poll(() => page.evaluate(async (id) => {
        const detail = await window.grudgeVault.records.get(id); return detail.ok ? detail.data.record.reportState : "missing";
      }, id)).toBe("complete");
    };
    await releaseReport();
    expect(await page.evaluate(() => window.grudgeVault.records.rebuildSearchIndex())).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(async () => {
      const status = await window.grudgeVault.records.searchIndexStatus(); return status.ok ? status.data.state : "missing";
    })).toBe("ready");
    await application.evaluate(() => { (globalThis as typeof globalThis & { __gvE2eHoldSearchIndex?: boolean }).__gvE2eHoldSearchIndex = true; });
    expect(await page.evaluate((id) => window.grudgeVault.records.reanalyze(id, 1), id)).toMatchObject({ ok: true });
    await releaseReport();
    await expect.poll(() => application.evaluate(() => typeof (globalThis as typeof globalThis & {
      __gvE2eReleaseSearchIndex?: () => void;
    }).__gvE2eReleaseSearchIndex)).toBe("function");
    const counts = () => {
      const database = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
      try { return ["redesign_records", "redesign_sources", "redesign_pending_reviews", "assets", "redesign_reports", "redesign_search_embeddings"]
        .map((table) => database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()); }
      finally { database.close(); }
    };
    const beforeSearch = counts();
    const partial = await page.evaluate(async () => {
      const query = await window.grudgeVault.records.prepareSearch({ requestId: globalThis.crypto.randomUUID(), text: "合成语义探针", files: [] });
      if (!query.ok) throw new Error("Expected synthetic query"); return window.grudgeVault.records.executeSearch(query.data.sessionId, {});
    });
    expect(partial).toMatchObject({ ok: true, data: { hits: [{ record: { id, revision: 1 } }],
      capabilities: { semantic: "ready", indexCoverage: { currentFragments: 2, expectedFragments: 4, outdatedFragments: 2 } } } });
    if (!partial.ok) throw new Error("Expected partial synthetic search");
    expect(partial.data.hits[0]!.matches?.every(({ anchor }) => anchor?.surface === "source" || Boolean(anchor?.textRange))).toBe(true);
    expect(counts()).toEqual(beforeSearch);
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByPlaceholder("描述你记得的内容…").fill("合成语义探针");
    await page.locator(".search-input").getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator(".search-results .record-card")).toHaveCount(1);
    await expect(page.locator(".banner.neutral")).toContainText("2／4 个片段，2 个过期片段已排除");
    await expect(page.locator(".banner.neutral")).toContainText("未找到匹配不代表没有相关记录");
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!; window.setMinimumSize(390, 600); window.setSize(390, 844);
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    expect(await page.locator(".banner.neutral").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("partial-current-search-390.png"), fullPage: true });
    expect(counts()).toEqual(beforeSearch);
    await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eReleaseSearchIndex?: () => void }).__gvE2eReleaseSearchIndex!());
    await expect.poll(() => page.evaluate(async () => {
      const status = await window.grudgeVault.records.searchIndexStatus(); return status.ok ? status.data.state : "missing";
    })).toBe("ready");
    await page.locator(".search-input").getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator(".banner.neutral")).toHaveCount(0);
    await expect(page.locator(".search-results .record-card")).toHaveCount(1);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

test("filters month and range overlap in the UI and carries its timezone through local search and IPC", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-date-filter-e2e-"));
  const workspace = join(root, "workspace"); const userData = join(root, "user-data");
  const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
    env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NO_NETWORK: "1" } });
  try {
    const page = await application.firstWindow(); await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-date-filter-key" }))).toMatchObject({ ok: true });
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const id = await page.evaluate(async (index) => {
        const prepared = await window.grudgeVault.intake.prepare({ requestId: globalThis.crypto.randomUUID(),
          text: `合成日期边界奖金事件 ${index}`, files: [] });
        if (!prepared.ok) throw new Error("Expected synthetic prepared intake");
        const saved = await window.grudgeVault.intake.screenAndSave(prepared.data.sessionId, globalThis.crypto.randomUUID());
        if (!saved.ok || saved.data.kind !== "saved") throw new Error("Expected synthetic saved intake");
        return saved.data.recordId;
      }, index);
      ids.push(id);
      await expect.poll(async () => page.evaluate(async (id) => {
        const detail = await window.grudgeVault.records.get(id); return detail.ok ? detail.data.record.reportState : "missing";
      }, id)).toMatch(/^(complete|partial)$/);
      expect(await page.evaluate(async ({ id, index }) => window.grudgeVault.records.patchFields({ recordId: id, expectedRevision: 1,
        patch: { title: ["合成月份", "合成区间", "合成明确时刻"][index]!, occurredAt: index === 0 ? { kind: "month", value: "2026-09" }
          : index === 1 ? { kind: "range", from: "2026-09-10", to: "2026-09-20" }
            : { kind: "instant", value: "2026-09-20T00:30:00Z" } }
      }), { id, index })).toMatchObject({ ok: true });
    }
    const inferenceCalls = await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eInferenceCalls?: number }).__gvE2eInferenceCalls ?? 0);
    const browserClock = await page.context().newCDPSession(page);
    await browserClock.send("Emulation.setTimezoneOverride", { timezoneId: "America/Los_Angeles" });
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await expect(page.locator(".timeline-groups .record-card")).toHaveCount(3);
    await expect(page.locator(".timeline-groups h2").filter({ hasText: "2026年9月19日" })).toBeVisible();
    await page.locator(".filter-bar").getByLabel("从", { exact: true }).fill("2026-09-15");
    await page.locator(".filter-bar").getByLabel("至", { exact: true }).fill("2026-09-15");
    await expect(page.locator(".timeline-groups .record-card")).toHaveCount(2);
    await expect(page.locator(".timeline-groups .record-card").filter({ hasText: "合成明确时刻" })).toHaveCount(0);
    await openDisclosure(page, "日期如何匹配？");
    await expect(page.getByText(/月份与时间范围按可能重叠筛选/)).toBeVisible();
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByLabel("使用百炼语义检索").uncheck();
    await page.getByPlaceholder("描述你记得的内容…").fill("合成日期边界");
    await openDisclosure(page, "筛选");
    await page.locator(".search-filters").getByLabel("从", { exact: true }).fill("2026-09-15");
    await openDisclosure(page, "筛选");
    await page.locator(".search-filters").getByLabel("至", { exact: true }).fill("2026-09-15");
    await page.locator(".search-input").getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByText("找到 2 条记录")).toBeVisible();
    await openDisclosure(page, "筛选");
    await page.locator(".search-filters").getByLabel("从", { exact: true }).fill("2026-09-19");
    await openDisclosure(page, "筛选");
    await page.locator(".search-filters").getByLabel("至", { exact: true }).fill("2026-09-19");
    await page.locator(".search-input").getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByText("找到 3 条记录")).toBeVisible();
    const localFallback = await page.evaluate(async () => {
      const query = await window.grudgeVault.records.prepareSearch({ requestId: globalThis.crypto.randomUUID(), text: "合成日期边界", files: [] });
      if (!query.ok) throw new Error("Expected synthetic search session");
      return window.grudgeVault.records.executeSearch(query.data.sessionId,
        { from: "2026-09-15", to: "2026-09-15", timeZone: "America/Los_Angeles" });
    });
    expect(localFallback).toMatchObject({ ok: true, data: { capabilities: { semantic: "unavailable" } } });
    if (!localFallback.ok) throw new Error("Expected local fallback");
    expect(localFallback.data.hits.map(({ record }) => record.id).sort()).toEqual(ids.slice(0, 2).sort());
    expect(await page.evaluate(() => window.grudgeVault.records.timeline({ timeZone: "unknown/zone" })))
      .toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await page.evaluate(() => window.grudgeVault.records.search({ text: "合成", timeZone: "unknown/zone" })))
      .toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    const longFrom = "UnbrokenSyntheticStart".repeat(35); const longTo = "UnbrokenSyntheticEnd".repeat(35);
    expect(await page.evaluate(({ id, from, to }) => window.grudgeVault.records.patchFields({ recordId: id, expectedRevision: 2,
      patch: { occurredAt: { kind: "range", from, to } } }), { id: ids[1]!, from: longFrom, to: longTo })).toMatchObject({ ok: true });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(840, 760));
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await expect(page.locator(".timeline-groups h2").filter({ hasText: longFrom })).toContainText(`${longFrom} — ${longTo} · 时间范围`);
    await expect(page.locator(".timeline-groups h2").filter({ hasText: longFrom })).toContainText("记录日期");
    expect(await page.locator(".timeline-groups h2").filter({ hasText: longFrom }).evaluate((element) =>
      element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.locator(".record-card-top > span:first-child").filter({ hasText: longFrom })).toContainText(`${longFrom} — ${longTo}`);
    await expect(page.locator(".record-card-top > span:first-child").filter({ hasText: longFrom })).toContainText("记录日期");
    expect(await page.locator(".record-card-top > span:first-child").filter({ hasText: longFrom }).evaluate((element) =>
      element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.locator(".record-card").filter({ hasText: longFrom }).click();
    await expect(page.locator(".detail-header p").filter({ hasText: longFrom })).toBeVisible();
    expect(await page.locator(".detail-header p").filter({ hasText: longFrom }).evaluate((element) =>
      element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eInferenceCalls?: number }).__gvE2eInferenceCalls ?? 0)).toBe(inferenceCalls);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

test("projects current report time after restart without rewriting source dates and protects user time through analysis", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-report-occurrence-e2e-"));
  const workspace = join(root, "workspace"); const userData = join(root, "user-data");
  const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const launch = () => electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
    env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NO_NETWORK: "1" } });
  let application = await launch();
  try {
    let page = await application.firstWindow(); await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-occurrence-key" }))).toMatchObject({ ok: true });
    const original = "E2E时间线报告日期 合成奖金事件：2020-01-02 是合同日期，引用规则发表于 2019年3月1日，本次拒付发生在 2026年9月。";
    await page.locator(".new-record-button").click();
    await page.getByRole("dialog", { name: "新建记录" }).getByLabel("发生了什么？").fill(original);
    await page.getByRole("dialog", { name: "新建记录" }).getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(page.locator(".report-summary")).toBeVisible();
    const before = await page.evaluate(async () => {
      const timeline = await window.grudgeVault.records.timeline({ from: "2026-09-15", to: "2026-09-15", timeZone: "UTC" });
      if (!timeline.ok || timeline.data.records.length !== 1) throw new Error("Expected projected synthetic month");
      const detail = await window.grudgeVault.records.get(timeline.data.records[0]!.id);
      if (!detail.ok) throw new Error("Expected synthetic detail"); return detail.data;
    });
    expect(before.record).toMatchObject({ occurredAt: { kind: "month", value: "2026-09" }, occurredAtSource: "ai", occurredAtPrecision: "approximate" });
    expect(before.source.text).toBe(original); expect(before.report?.content.time.value?.value).toBe("约2026年9月");
    const storedDate = () => {
      const database = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
      try { return database.prepare("SELECT occurred_at_json FROM redesign_records WHERE id = ?").pluck().get(before.record.id); }
      finally { database.close(); }
    };
    expect(storedDate()).toBe('{"kind":"unknown"}');
    await page.getByRole("button", { name: /返回时间线/ }).click();
    await expect(page.locator(".timeline-groups h2")).toHaveText("2026-09（大约时间）");
    await expect(page.locator(".record-time-source")).toHaveText("AI 整理");
    await application.close(); application = await launch(); page = await application.firstWindow();
    await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate((id) => window.grudgeVault.records.get(id), before.record.id)).toEqual({ ok: true, data: before });
    expect(storedDate()).toBe('{"kind":"unknown"}');
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eInferenceCalls?: number }).__gvE2eInferenceCalls ?? 0)).toBe(0);
    expect(await page.evaluate((id) => window.grudgeVault.records.patchFields({ recordId: id, expectedRevision: 1,
      patch: { occurredAt: { kind: "date", value: "2026-09-05" } } }), before.record.id)).toMatchObject({ ok: true });
    expect(await page.evaluate((id) => window.grudgeVault.records.reanalyze(id, 2), before.record.id)).toMatchObject({ ok: true });
    await expect.poll(async () => page.evaluate(async (id) => {
      const detail = await window.grudgeVault.records.get(id); return detail.ok ? detail.data.record.reportState : "missing";
    }, before.record.id)).toMatch(/^(complete|partial)$/);
    expect(await page.evaluate((id) => window.grudgeVault.records.get(id), before.record.id)).toMatchObject({ ok: true, data: {
      record: { occurredAt: { kind: "date", value: "2026-09-05" }, occurredAtSource: "user" },
      report: { content: { time: { source: "user", value: { value: "2026-09-05", precision: "exact" } } } }
    } });
    expect(await page.evaluate((id) => window.grudgeVault.records.patchFields({ recordId: id, expectedRevision: 2,
      patch: { occurredAt: { kind: "unknown" } } }), before.record.id)).toMatchObject({ ok: true });
    expect(await page.evaluate((id) => window.grudgeVault.records.reanalyze(id, 3), before.record.id)).toMatchObject({ ok: true });
    await expect.poll(async () => page.evaluate(async (id) => {
      const detail = await window.grudgeVault.records.get(id); return detail.ok ? detail.data.record.reportState : "missing";
    }, before.record.id)).toMatch(/^(complete|partial)$/);
    const cleared = await page.evaluate((id) => window.grudgeVault.records.get(id), before.record.id);
    expect(cleared).toMatchObject({ ok: true, data: { record: { occurredAt: { kind: "unknown" }, occurredAtSource: "user" },
      report: { content: { time: { source: "user", prompt: "待补充：大约何时发生？" } } } } });
    if (!cleared.ok) throw new Error("Expected synthetic cleared record");
    expect(cleared.data.report?.content.time.value).toBeUndefined();
    expect(await page.evaluate(() => window.grudgeVault.records.search({ text: "约2026年9月" }))).toMatchObject({ ok: true, data: { hits: [] } });
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByRole("button", { name: "时间线", exact: true }).click();
    await expect(page.locator(".timeline-groups h2")).toContainText("记录日期");
    await expect(page.locator(".record-time-source")).toHaveText("你已补充");
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

test("uses current protected legal context and persists pending effective information through IPC and restart", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-legal-context-e2e-"));
  const workspace = join(root, "workspace"); const userData = join(root, "user-data");
  const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const launch = () => electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
    env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NO_NETWORK: "1", GRUDGE_VAULT_E2E_LEGAL_FLOW: "1" } });
  let application = await launch();
  try {
    let page = await application.firstWindow(); await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-legal-key" }))).toMatchObject({ ok: true });
    const original = "E2E法律时间核验：合成人物甲称奖金未付，约定与材料尚待核对。";
    await page.locator(".new-record-button").click();
    await page.getByRole("dialog", { name: "新建记录" }).getByLabel("发生了什么？").fill(original);
    await page.getByRole("dialog", { name: "新建记录" }).getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(page.locator(".citation-card")).toHaveCount(1);
    await openDisclosure(page, "法律视角");
    await expect(page.locator(".citation-card")).toBeVisible();
    await expect(page.locator(".citation-card")).toContainText("待核验");
    await expect(page.locator(".citation-card")).toContainText("生效、失效信息及事发时点的适用性尚未核验。");
    await expect(page.locator(".citation-card")).not.toContainText("已核验");
    await expect(page.locator(".citation-card .legal-claim")).toHaveText("对应问题：合成奖金争议的适用规则待核对");
    await expect(page.locator(".citation-card time")).toHaveAttribute("datetime", "2026-09-29T00:00:00.000Z");
    await expect(page.locator(".citation-card .citation-url")).toContainText("https://www.gov.cn/synthetic-e2e-rule?proof=");
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(840, 900));
    await page.setViewportSize({ width: 390, height: 900 });
    await page.locator(".citation-card").scrollIntoViewIfNeeded();
    expect(await page.locator(".citation-card").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.locator(".citation-card").screenshot({ path: test.info().outputPath("legal-citation-390.png") });
    const before = await page.evaluate(async () => {
      const timeline = await window.grudgeVault.records.timeline({});
      if (!timeline.ok || timeline.data.records.length !== 1) throw new Error("Expected one synthetic legal record");
      const detail = await window.grudgeVault.records.get(timeline.data.records[0]!.id);
      if (!detail.ok) throw new Error("Expected synthetic legal detail"); return detail.data;
    });
    const latestInput = () => application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eLegalInputs?: LegalResearchInput[] }).__gvE2eLegalInputs?.at(-1));
    expect(await latestInput()).toMatchObject({ occurredAt: { kind: "date", value: "2026-09-10" }, occurredAtSource: "ai",
      occurredAtPrecision: "exact", confirmedFacts: [], reportedFacts: ["Person-1称奖金未付，约定和凭证仍待核对。"],
      sourceVersion: before.source.sourceVersion });
    expect(before.record.occurredAt).toEqual({ kind: "date", value: "2026-09-10" });
    await application.evaluate(() => { (globalThis as typeof globalThis & { __gvE2eLegalReportMode?: "changed" }).__gvE2eLegalReportMode = "changed"; });
    expect(await page.evaluate((id) => window.grudgeVault.records.reanalyze(id, 1), before.record.id)).toMatchObject({ ok: true });
    await expect.poll(latestInput).toMatchObject({ occurredAt: { kind: "date", value: "2026-09-12" }, occurredAtSource: "ai" });
    await expect.poll(async () => page.evaluate(async (id) => {
      const detail = await window.grudgeVault.records.get(id); return detail.ok ? detail.data.report?.content.time.value?.value : undefined;
    }, before.record.id)).toBe("2026-09-12");
    expect(await page.evaluate((id) => window.grudgeVault.records.patchFields({ recordId: id, expectedRevision: 1,
      patch: { occurredAt: { kind: "month", value: "2026-09" } } }), before.record.id)).toMatchObject({ ok: true });
    expect(await page.evaluate((id) => window.grudgeVault.records.reanalyze(id, 2), before.record.id)).toMatchObject({ ok: true });
    await expect.poll(latestInput).toMatchObject({ occurredAt: { kind: "month", value: "2026-09" }, occurredAtSource: "user", occurredAtPrecision: "exact" });
    await expect.poll(async () => page.evaluate(async (id) => {
      const detail = await window.grudgeVault.records.get(id); return detail.ok ? detail.data.report?.recordRevision : undefined;
    }, before.record.id)).toBe(2);
    expect(await page.evaluate((id) => window.grudgeVault.records.patchFields({ recordId: id, expectedRevision: 2,
      patch: { occurredAt: { kind: "unknown" } } }), before.record.id)).toMatchObject({ ok: true });
    expect(await page.evaluate((id) => window.grudgeVault.records.reanalyze(id, 3), before.record.id)).toMatchObject({ ok: true });
    await expect.poll(latestInput).toMatchObject({ occurredAt: { kind: "unknown" }, occurredAtSource: "user", occurredAtPrecision: "unknown" });
    await expect.poll(async () => page.evaluate(async (id) => {
      const detail = await window.grudgeVault.records.get(id); return detail.ok ? detail.data.report?.recordRevision : undefined;
    }, before.record.id)).toBe(3);
    const persisted = await page.evaluate((id) => window.grudgeVault.records.get(id), before.record.id);
    expect(persisted).toMatchObject({ ok: true, data: { record: { reportState: "complete" }, source: { text: original },
      report: { content: { time: { source: "user", prompt: "待补充：大约何时发生？" },
        citations: [{ verificationStatus: "pending", effectiveInfo: "生效、失效信息及事发时点的适用性尚未核验。" }] } } } });
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
    await application.close(); application = await launch(); page = await application.firstWindow();
    await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate((id) => window.grudgeVault.records.get(id), before.record.id)).toEqual(persisted);
    await page.locator(".record-card").first().click();
    await expect(page.locator(".citation-card")).toContainText("待核验");
    await expect(page.locator(".citation-card")).toContainText("生效、失效信息及事发时点的适用性尚未核验。");
    expect(await latestInput()).toBeUndefined();
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

test("routes real macOS WAV clips through private screening, encrypted reports, queries, cancellation and configured auxiliaries", async () => {
  test.skip(process.platform !== "darwin", "Native Mac codec gate");
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-native-flow-e2e-"));
  const workspace = join(root, "workspace"); const userData = join(root, "user-data");
  const audioPath = join(root, "synthetic-long.wav"); await writeSyntheticWav(audioPath, 48, 44_100, 2);
  const originalHash = createHash("sha256").update(await readFile(audioPath)).digest("hex");
  const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
    env: { ...inheritedEnvironment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NATIVE_FLOW: "1" } });
  try {
    const page = await application.firstWindow();
    await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-native-e2e-key" }))).toMatchObject({ ok: true });
    const setMode = async (mode: string) => application.evaluate((_electron, value) => {
      const state = globalThis as typeof globalThis & { __gvE2eNativeMode?: string; __gvE2eNativeCalls?: string[];
        __gvE2eNativeSegmentStarted?: boolean; __gvE2eNativeRouting?: Array<{ tool: string; model: string }> };
      state.__gvE2eNativeMode = value; state.__gvE2eNativeCalls = []; state.__gvE2eNativeSegmentStarted = false;
      state.__gvE2eNativeRouting = [];
    }, mode);
    const calls = () => application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eNativeCalls?: string[] }).__gvE2eNativeCalls ?? []);
    const transientEntries = () => readdir(join(userData, ".grudge-vault-redesign-transient-v1"));
    const counts = () => {
      const database = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
      try { return ["redesign_records", "redesign_pending_reviews", "assets", "redesign_reports"].map((table) =>
        database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()); } finally { database.close(); }
    };
    const openEditor = async (text: string) => {
      await page.locator(".new-record-button").click(); const editor = page.getByRole("dialog", { name: "新建记录" });
      await editor.getByLabel("发生了什么？").fill(text);
      await editor.getByLabel("添加图片、音频或视频").setInputFiles(audioPath);
      await expect(editor.getByText(/Mac 本机分段/)).toBeVisible(); return editor;
    };
    const closeEditor = async () => Promise.all([page.waitForEvent("dialog").then((dialog) => dialog.accept()),
      page.getByRole("dialog", { name: "新建记录" }).getByRole("button", { name: "关闭" }).click()]);

    await setMode("ordinary"); let editor = await openEditor("午饭后散步（合成长音频）");
    await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(editor.getByText(/不属于收录范围/)).toBeVisible();
    expect(await calls()).toEqual(["segment-0", "segment-1"]); expect(counts()).toEqual([0, 0, 0, 0]);
    expect(await transientEntries()).toEqual([".owned-by-grudge-vault"]); await closeEditor();

    await setMode("partial"); editor = await openEditor("合成无法完整检查的长音频");
    await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(editor.getByRole("alert")).toBeVisible();
    expect(await calls()).toEqual(["segment-0"]); expect(counts()).toEqual([0, 0, 0, 0]);
    expect(await transientEntries()).toEqual([".owned-by-grudge-vault"]); await closeEditor();

    await setMode("cancel"); editor = await openEditor("合成取消分段任务");
    await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect.poll(() => application.evaluate(() =>
      (globalThis as typeof globalThis & { __gvE2eNativeSegmentStarted?: boolean }).__gvE2eNativeSegmentStarted)).toBe(true);
    await expect(editor.locator(".stage-progress")).toContainText("正在检查第 1 段；已检查 0.0 / 48.0 秒");
    await closeEditor(); await expect.poll(transientEntries).toEqual([".owned-by-grudge-vault"]);
    expect(await calls()).toEqual(["segment-0"]); expect(counts()).toEqual([0, 0, 0, 0]);

    await setMode("related"); editor = await openEditor("原生分段E2E：后段的合成争议需要核对");
    await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(page.locator(".report-summary")).toHaveText("分段模型替身报告：后段的合成争议已保留。", { timeout: 20_000 });
    const detail = await page.evaluate(async () => {
      const search = await window.grudgeVault.records.search({ text: "原生分段E2E" });
      if (!search.ok || !search.data.hits[0]) throw new Error("Expected synthetic media record");
      const result = await window.grudgeVault.records.get(search.data.hits[0].record.id);
      if (!result.ok) throw new Error("Expected synthetic media detail"); return result.data;
    });
    expect(detail.record.reportState).toBe("complete"); expect(detail.attachments[0]?.sha256).toBe(originalHash);
    const tail = detail.report?.content.mediaSegments?.find(({ description }) => description.includes("合成片段后段含争议话语"));
    expect(tail?.anchor.intervalMs?.[0]).toBeGreaterThan(0); expect(tail?.anchor.intervalMs?.[1]).toBe(48_000);
    expect(detail.report?.content.mediaSegments).toContainEqual(expect.objectContaining({ anchor: {
      sourceVersion: detail.source.sourceVersion, assetId: detail.attachments[0]!.id,
      intervalMs: [tail!.anchor.intervalMs![0] + 100, tail!.anchor.intervalMs![0] + 200]
    } }));
    expect(await calls()).toEqual(["segment-0", "segment-1", "screen", "segment-0", "segment-1", "report"]);
    expect(counts()).toEqual([1, 0, 1, 1]); expect(await transientEntries()).toEqual([".owned-by-grudge-vault"]);
    expect(createHash("sha256").update(await readFile(audioPath)).digest("hex")).toBe(originalHash);
    // Only the isolated synthetic encrypted object is corrupted; restore it before retrying.
    const objectPath = join(workspace, "vault/objects/sha256", originalHash.slice(0, 2), originalHash.slice(2, 4), `${originalHash}.gvobj`);
    const encrypted = await readFile(objectPath); const damaged = Buffer.from(encrypted);
    damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
    const waitForJob = async (jobId: string) => expect.poll(() => page.evaluate(async (id) => {
      const result = await window.grudgeVault.jobs.list(); return result.ok ? result.data.find((job) => job.id === id)?.state : undefined;
    }, jobId), { timeout: 20_000 }).toBe("succeeded");
    try {
      await writeFile(objectPath, damaged); await setMode("corrupt");
      const run = await page.evaluate(({ id, revision }) => window.grudgeVault.records.reanalyze(id, revision), detail.record);
      if (!run.ok) throw new Error("Expected synthetic reanalysis job"); await waitForJob(run.data);
      expect(await calls()).toEqual(["report"]);
      expect(await transientEntries()).toEqual([".owned-by-grudge-vault"]);
      const database = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
      try {
        const row = database.prepare("SELECT state, content_json FROM redesign_reports WHERE analysis_run_id = ?").get(run.data) as { state: string; content_json: string };
        expect(row.state).toBe("partial"); expect(JSON.parse(row.content_json).mediaSegments).toEqual([]);
      } finally { database.close(); }
      const visible = await page.evaluate(async (id) => window.grudgeVault.records.get(id), detail.record.id);
      expect(visible.ok && visible.data.report?.id).toBe(detail.report?.id);
    } finally { await writeFile(objectPath, encrypted); }
    await setMode("related");
    const restored = await page.evaluate(({ id, revision }) => window.grudgeVault.records.reanalyze(id, revision), detail.record);
    if (!restored.ok) throw new Error("Expected restored synthetic reanalysis job"); await waitForJob(restored.data);
    const restoredDetail = await page.evaluate(async (id) => window.grudgeVault.records.get(id), detail.record.id);
    expect(restoredDetail.ok && restoredDetail.data.record.reportState).toBe("complete");
    expect(restoredDetail.ok && restoredDetail.data.report?.id).not.toBe(detail.report?.id);
    expect(await calls()).toEqual(["segment-0", "segment-1", "report"]);
    expect(await transientEntries()).toEqual([".owned-by-grudge-vault"]);

    if (!restoredDetail.ok) throw new Error("Expected restored synthetic detail");
    const completedReportId = restoredDetail.data.report?.id;
    await setMode("cancel");
    expect(await page.evaluate(({ id, revision }) => window.grudgeVault.records.reanalyze(id, revision), detail.record)).toMatchObject({ ok: true });
    await expect.poll(() => application.evaluate(() =>
      (globalThis as typeof globalThis & { __gvE2eNativeSegmentStarted?: boolean }).__gvE2eNativeSegmentStarted)).toBe(true);
    await expect(page.getByRole("status").filter({ hasText: "报告任务进度 0%" })).toBeVisible();
    await page.getByRole("button", { name: "取消分析", exact: true }).click();
    await expect.poll(() => page.evaluate(async (id) => {
      const result = await window.grudgeVault.records.get(id); return result.ok ? result.data.record.reportState : undefined;
    }, detail.record.id)).toBe("failed");
    expect(await calls()).toEqual(["segment-0"]);
    const cancelledReport = await page.evaluate(async (id) => window.grudgeVault.records.get(id), detail.record.id);
    expect(cancelledReport.ok && cancelledReport.data.report?.id).toBe(completedReportId);
    await expect.poll(transientEntries).toEqual([".owned-by-grudge-vault"]);
    await setMode("related"); await page.getByRole("button", { name: "重试分析", exact: true }).click();
    await expect.poll(() => page.evaluate(async (id) => {
      const result = await window.grudgeVault.records.get(id); return result.ok ? result.data.record.reportState : undefined;
    }, detail.record.id)).toBe("complete");
    expect(await calls()).toEqual(["segment-0", "segment-1", "report"]);
    await expect.poll(transientEntries).toEqual([".owned-by-grudge-vault"]);

    expect(await page.evaluate(() => window.grudgeVault.records.setSearchIndexEnabled(true))).toMatchObject({ ok: true });
    expect(await page.evaluate(() => window.grudgeVault.records.rebuildSearchIndex())).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(async () => {
      const result = await window.grudgeVault.records.searchIndexStatus(); return result.ok ? result.data.state : undefined;
    })).toBe("ready");
    const queryCounts = () => {
      const database = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
      try { return ["redesign_records", "redesign_sources", "redesign_pending_reviews", "assets", "redesign_reports", "redesign_search_embeddings"].map((table) =>
        database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()); } finally { database.close(); }
    };
    const beforeQuery = queryCounts();
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await setMode("cancel");
    await page.getByLabel("选择搜索图片、音频或视频").setInputFiles(audioPath);
    await page.locator(".search-box").getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator(".stage-progress")).toContainText("正在检查第 1 段；已检查 0.0 / 48.0 秒");
    await page.getByRole("button", { name: "取消搜索", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("本次搜索已取消。");
    await expect(page.locator(".stage-progress")).toHaveCount(0);
    expect(await calls()).toEqual(["segment-0"]); expect(queryCounts()).toEqual(beforeQuery);
    expect(await transientEntries()).toEqual([".owned-by-grudge-vault"]);
    await setMode("related");
    await page.getByLabel("选择搜索图片、音频或视频").setInputFiles(audioPath);
    await page.locator(".search-box").getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator(".search-results article")).toHaveCount(1);
    expect(await calls()).toEqual(["segment-0", "segment-1", "query"]);
    expect(queryCounts()).toEqual(beforeQuery); expect(await transientEntries()).toEqual([".owned-by-grudge-vault"]);

    // Configure both synthetic accounts, retaining MiniMax as main and Bailian as auxiliary.
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "minimax",
      model: "MiniMax-M3", apiKey: "synthetic-minimax-e2e-key" }))).toMatchObject({ ok: true });
    await setMode("related"); editor = await openEditor("原生分段E2E：MiniMax辅助路由的合成争议");
    await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "新建记录" })).toHaveCount(0);
    await expect.poll(() => page.evaluate(async () => {
      const search = await window.grudgeVault.records.search({ text: "MiniMax辅助路由" });
      if (!search.ok || !search.data.hits[0]) return undefined;
      const result = await window.grudgeVault.records.get(search.data.hits[0].record.id);
      return result.ok ? result.data.report?.modelProfile : undefined;
    }), { timeout: 20_000 }).toBe("minimax:MiniMax-M3+media=bailian:qwen3.8-omni-flash");
    expect(await calls()).toEqual(["segment-0", "segment-1", "screen", "segment-0", "segment-1", "report"]);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eNativeRouting?: Array<{ tool: string; model: string }>;
    }).__gvE2eNativeRouting)).toEqual([
      { tool: "submit_media_segment_observations", model: "qwen3.8-omni-flash" },
      { tool: "submit_media_segment_observations", model: "qwen3.8-omni-flash" },
      { tool: "submit_screening", model: "MiniMax-M3" },
      { tool: "submit_media_segment_observations", model: "qwen3.8-omni-flash" },
      { tool: "submit_media_segment_observations", model: "qwen3.8-omni-flash" },
      { tool: "submit_report", model: "MiniMax-M3" }
    ]);
    // A cached semantic page cannot survive pausing the actual model configuration through public IPC.
    expect(await page.evaluate(() => window.grudgeVault.records.rebuildSearchIndex())).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(async () => {
      const result = await window.grudgeVault.records.searchIndexStatus(); return result.ok ? result.data.state : undefined;
    })).toBe("ready");
    const beforeConfigQuery = queryCounts();
    const preparedConfigQuery = await page.evaluate(() => window.grudgeVault.records.prepareSearch({ requestId: globalThis.crypto.randomUUID(), text: "合成争议", files: [] }));
    if (!preparedConfigQuery.ok) throw new Error("Expected synthetic semantic query preparation");
    const configSessionId = preparedConfigQuery.data.sessionId;
    const configPage = await page.evaluate((id) => window.grudgeVault.records.executeSearch(id, { limit: 1 }), configSessionId);
    expect(configPage).toMatchObject({ ok: true, data: { capabilities: { semantic: "ready" } } });
    if (!configPage.ok || !configPage.data.nextCursor) throw new Error("Expected cached semantic pagination");
    expect(await page.evaluate(() => window.grudgeVault.llm.pause())).toMatchObject({ ok: true });
    const invalidatedPage = await page.evaluate(({ id, cursor }) => window.grudgeVault.records.executeSearch(id, { limit: 1, cursor }),
      { id: configSessionId, cursor: configPage.data.nextCursor });
    expect(invalidatedPage).toMatchObject({ ok: false, error: { code: "LLM_CONFIGURATION_CHANGED" } });
    expect(queryCounts()).toEqual(beforeConfigQuery);
    expect(await page.evaluate(() => window.grudgeVault.llm.activate("minimax"))).toMatchObject({ ok: true });
    expect(await page.evaluate(() => window.grudgeVault.records.setSearchIndexEnabled(true))).toMatchObject({ ok: true });
    const retryConfigQuery = await page.evaluate(async () => {
      const prepared = await window.grudgeVault.records.prepareSearch({ requestId: globalThis.crypto.randomUUID(), text: "合成争议", files: [] });
      if (!prepared.ok) return prepared;
      return window.grudgeVault.records.executeSearch(prepared.data.sessionId, { limit: 5 });
    });
    expect(retryConfigQuery).toMatchObject({ ok: true, data: { capabilities: { semantic: "ready" } } });
    expect(queryCounts()).toEqual(beforeConfigQuery);
    const beforeUnavailable = counts();
    expect(await page.evaluate(() => window.grudgeVault.llm.disconnect("bailian"))).toMatchObject({ ok: true });
    await setMode("related"); editor = await openEditor("合成未配置辅助能力，不可发送音视频");
    await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("配置并测试百炼 Omni 辅助能力");
    expect(await calls()).toEqual([]); expect(counts()).toEqual(beforeUnavailable);
    expect(await transientEntries()).toEqual([".owned-by-grudge-vault"]); await closeEditor();
    expect(createHash("sha256").update(await readFile(audioPath)).digest("hex")).toBe(originalHash);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

test("uses private HEIC copies for screening, reports, display and search while exporting the encrypted original", async () => {
  test.skip(process.platform !== "darwin", "Native Mac image codec gate");
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-heic-flow-e2e-"));
  const workspace = join(root, "workspace"), userData = join(root, "user-data");
  const imagePath = join(root, "synthetic.heic"), multiPath = join(root, "synthetic-multi.heic");
  const syntheticImages = JSON.parse(await readFile(resolve("tests/fixtures/native-image/synthetic.json"), "utf8")) as { single: string; multi: string };
  const original = Buffer.from(syntheticImages.single, "base64"), originalHash = createHash("sha256").update(original).digest("hex");
  await writeFile(imagePath, original); await writeFile(multiPath, Buffer.from(syntheticImages.multi, "base64"));
  const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
    env: { ...inheritedEnvironment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_IMAGE_FLOW: "1" } });
  try {
    const page = await application.firstWindow(); await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-heic-e2e-key" }))).toMatchObject({ ok: true });
    const setMode = async (mode: string) => application.evaluate((_electron, value) => {
      const state = globalThis as typeof globalThis & { __gvE2eImageMode?: string; __gvE2eImageCalls?: string[]; __gvE2eImageStarted?: boolean };
      state.__gvE2eImageMode = value; state.__gvE2eImageCalls = []; state.__gvE2eImageStarted = false;
    }, mode);
    const calls = () => application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eImageCalls?: string[] }).__gvE2eImageCalls ?? []);
    const transientEntries = () => readdir(join(userData, ".grudge-vault-redesign-transient-v1"));
    const counts = () => {
      const database = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
      try { return ["redesign_records", "redesign_sources", "redesign_pending_reviews", "assets", "redesign_reports", "redesign_search_embeddings"].map((table) =>
        database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()); } finally { database.close(); }
    };
    const openEditor = async (text: string, path = imagePath) => {
      await page.locator(".new-record-button").click(); const editor = page.getByRole("dialog", { name: "新建记录" });
      await editor.getByLabel("发生了什么？").fill(text); await editor.getByLabel("添加图片、音频或视频").setInputFiles(path);
      await expect(editor.getByText(/M4A／HEIC 将转换为私有处理副本/)).toBeVisible(); return editor;
    };
    const closeEditor = async () => Promise.all([page.waitForEvent("dialog").then((dialog) => dialog.accept()),
      page.getByRole("dialog", { name: "新建记录" }).getByRole("button", { name: "关闭" }).click()]);

    await setMode("ordinary"); let editor = await openEditor("合成 HEIC 普通日常");
    await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(editor.getByText(/不属于收录范围/)).toBeVisible();
    expect(await calls()).toEqual(["submit_screening"]); expect(counts()).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await transientEntries()).toEqual([".owned-by-grudge-vault"]); await closeEditor();

    await setMode("related"); editor = await openEditor("合成多图 HEIC 不可静默取首图", multiPath);
    await editor.getByRole("button", { name: "判断并收录", exact: true }).click(); await expect(editor.getByRole("alert")).toBeVisible();
    expect(await calls()).toEqual([]); expect(counts()).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await transientEntries()).toEqual([".owned-by-grudge-vault"]); await closeEditor();

    await setMode("cancel"); editor = await openEditor("合成 HEIC 筛选取消");
    await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eImageStarted?: boolean }).__gvE2eImageStarted)).toBe(true);
    await closeEditor(); await expect.poll(transientEntries).toEqual([".owned-by-grudge-vault"]);
    expect(counts()).toEqual([0, 0, 0, 0, 0, 0]);

    await setMode("related"); editor = await openEditor("原生图片E2E：合成图片中的争议需要核对");
    await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(page.locator(".report-summary")).toHaveText("合成 HEIC 转换图片报告（模型替身）。", { timeout: 20_000 });
    const detail = await page.evaluate(async () => {
      const search = await window.grudgeVault.records.search({ text: "原生图片E2E" });
      if (!search.ok || !search.data.hits[0]) throw new Error("Expected synthetic image record");
      const result = await window.grudgeVault.records.get(search.data.hits[0].record.id);
      if (!result.ok) throw new Error("Expected synthetic image detail"); return result.data;
    });
    expect(detail.record.reportState).toBe("complete"); expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0]).toMatchObject({ sha256: originalHash, byteSize: original.length, mimeType: "image/heic" });
    expect(detail.report?.content.mediaSegments?.[0]?.anchor).toMatchObject({ assetId: detail.attachments[0]!.id, sourceVersion: detail.source.sourceVersion });
    expect(await calls()).toEqual(["submit_screening", "submit_report"]);
    expect(await transientEntries()).toEqual([".owned-by-grudge-vault"]);
    await page.getByRole("button", { name: "原始内容", exact: true }).click();
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await expect(page.getByText(/HEIC 转换预览：/)).toBeVisible();
    const image = page.getByAltText("synthetic.heic 转换预览");
    await expect.poll(() => image.evaluate((element: globalThis.HTMLImageElement) => [element.naturalWidth, element.naturalHeight])).toEqual([64, 96]);
    expect(await transientEntries()).toEqual([".owned-by-grudge-vault"]);
    const exported = join(root, "exported-original.heic");
    await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, exported);
    await page.getByRole("button", { name: "保存副本", exact: true }).click();
    await expect.poll(async () => { try { return (await readFile(exported)).equals(original); } catch { return false; } }).toBe(true);
    const objectPath = join(workspace, "vault/objects/sha256", originalHash.slice(0, 2), originalHash.slice(2, 4), `${originalHash}.gvobj`);
    const encrypted = await readFile(objectPath); expect(encrypted.equals(original)).toBe(false);
    expect(encrypted.includes(Buffer.from("GV_SYNTHETIC_PRIVATE_IMAGE_METADATA"))).toBe(false);
    const damaged = Buffer.from(encrypted); damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
    try {
      await writeFile(objectPath, damaged); await setMode("corrupt");
      expect(await page.evaluate((id) => window.grudgeVault.assets.preview(id), detail.attachments[0]!.id)).toMatchObject({ ok: false });
      const run = await page.evaluate(({ id, revision }) => window.grudgeVault.records.reanalyze(id, revision), detail.record);
      if (!run.ok) throw new Error("Expected synthetic corrupt image report job");
      await expect.poll(() => page.evaluate(async (id) => {
        const result = await window.grudgeVault.jobs.list(); return result.ok ? result.data.find((job) => job.id === id)?.state : undefined;
      }, run.data), { timeout: 20_000 }).toBe("succeeded");
      const database = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
      try { expect(database.prepare("SELECT state FROM redesign_reports WHERE analysis_run_id = ?").pluck().get(run.data)).toBe("partial"); }
      finally { database.close(); }
      const preserved = await page.evaluate((id) => window.grudgeVault.records.get(id), detail.record.id);
      expect(preserved.ok && preserved.data.report?.id).toBe(detail.report?.id);
      expect(await calls()).toEqual(["submit_report"]); expect(await transientEntries()).toEqual([".owned-by-grudge-vault"]);
    } finally { await writeFile(objectPath, encrypted); }

    expect(await page.evaluate(() => window.grudgeVault.records.setSearchIndexEnabled(true))).toMatchObject({ ok: true });
    expect(await page.evaluate(() => window.grudgeVault.records.rebuildSearchIndex())).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(async () => {
      const result = await window.grudgeVault.records.searchIndexStatus(); return result.ok ? result.data.state : undefined;
    })).toBe("ready");
    const beforeQuery = counts();
    const beforeEmbeddings = await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eImageEmbeddings?: number }).__gvE2eImageEmbeddings ?? 0);
    expect(beforeEmbeddings).toBeGreaterThan(0);
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByLabel("选择搜索图片、音频或视频").setInputFiles(imagePath);
    await page.locator(".search-box").getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator(".search-results article")).toHaveCount(1);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eImageEmbeddings?: number }).__gvE2eImageEmbeddings ?? 0)).toBe(beforeEmbeddings + 1);
    expect(counts()).toEqual(beforeQuery); expect(await transientEntries()).toEqual([".owned-by-grudge-vault"]);
    expect((await readFile(imagePath)).equals(original)).toBe(true); expect((await readFile(exported)).equals(original)).toBe(true);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

test("plays a greater-than-64-MiB authenticated original with range seeking and revokes private preview copies", async () => {
  test.skip(process.platform !== "darwin", "Native Mac preview gate"); test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-large-preview-e2e-"));
  const workspace = join(root, "workspace"), userData = join(root, "user-data"), audioPath = join(root, "synthetic-large.wav");
  await writeSyntheticWav(audioPath, 400, 44_100, 2); const originalHash = await hashFile(audioPath);
  const manager = new LocalWorkspaceManager({
    async assertAvailable() {}, async protect(key) { return `e2e:${key.toString("base64")}`; },
    async unprotect(envelope) { return { key: Buffer.from(envelope.slice(4), "base64") }; }
  }, join(root, "synthetic-seed-state.json"));
  let recordId = "", assetId = "";
  try {
    const seed = new GrudgeVaultApplication(manager); await seed.createWorkspace(workspace, "Synthetic Preview Vault");
    const intake = await seed.prepareIntake({ text: "合成大音频原件预览用例", paths: [audioPath] });
    const saved = await seed.screenAndSaveIntake(intake.sessionId, randomUUID(), { async screen(input) {
      return { decision: "include", categories: ["grudge"], reason: "仅用于预览回归的模型替身",
        anchors: input.media.map(({ id }) => ({ sourceVersion: input.sourceVersion, temporaryMediaRef: id })),
        coverage: "complete", policyVersion: "synthetic-preview-v1" };
    } });
    if (saved.kind !== "saved") throw new Error("Expected synthetic encrypted preview fixture");
    recordId = saved.recordId; const detail = seed.getRecordDetail(recordId); assetId = detail.attachments[0]!.id;
    expect(detail.attachments[0]!.byteSize).toBeGreaterThan(64 * 1024 * 1024);
    const session = manager.current()!; for (const job of session.jobs.list()) if (job.state === "queued") session.jobs.cancel(job.id, new Date().toISOString());
  } finally { await manager.close(); }
  const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
    env: { ...inheritedEnvironment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_PREVIEW_FLOW: "1" } });
  try {
    const page = await application.firstWindow(); await expect(page.locator(".record-card")).toHaveCount(1);
    const entries = () => readdir(join(userData, ".grudge-vault-redesign-transient-v1"));
    const reads = () => application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2ePreviewReads?: Array<{ start: number; end: number; byteSize: number; chunkBytes: number }>
    }).__gvE2ePreviewReads ?? []);
    await page.locator(".record-card").click(); await page.getByRole("button", { name: "原始内容", exact: true }).click();
    await page.getByRole("button", { name: "预览", exact: true }).click();
    const player = page.locator(".attachment-preview audio"); await expect(player).toBeVisible();
    await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2ePreviewAccess?: Array<{ status: number; origin: string }>
    }).__gvE2ePreviewAccess ?? [])).toContainEqual(expect.objectContaining({ status: 206 }));
    await expect.poll(() => player.evaluate((element: globalThis.HTMLAudioElement) => Number.isFinite(element.duration) ? element.duration : 0)).toBeCloseTo(400, 2);
    const oldUrl = await player.getAttribute("src"); expect(oldUrl).toMatch(/^gv-preview:\/\/media\/[a-f0-9]{64}$/);
    const beforeSeek = (await reads()).length;
    const alreadyBuffered = await player.evaluate((element: globalThis.HTMLAudioElement) => {
      for (let index = 0; index < element.buffered.length; index++) if (element.buffered.start(index) <= 350 && element.buffered.end(index) > 350.05) return true;
      return false;
    });
    await player.evaluate((element: globalThis.HTMLAudioElement) => { element.currentTime = 350; });
    await expect.poll(() => player.evaluate((element: globalThis.HTMLAudioElement) => element.currentTime)).toBeCloseTo(350, 1);
    await player.evaluate(async (element: globalThis.HTMLAudioElement) => { await element.play(); });
    await expect.poll(() => player.evaluate((element: globalThis.HTMLAudioElement) => element.currentTime)).toBeGreaterThan(350.05);
    // Chromium may prefetch the target. Otherwise observe reads at the actual WAV byte offset, not a rounded MiB guess.
    await expect.poll(async () => alreadyBuffered || (await reads()).slice(beforeSeek).some(({ start }) => start > 350 * 44_100 * 2 * 2 - 256 * 1024)).toBe(true);
    await player.evaluate((element: globalThis.HTMLAudioElement) => element.pause());
    expect((await reads()).every(({ chunkBytes }) => chunkBytes <= 64 * 1024)).toBe(true);
    const copies = (await entries()).filter((name) => name.startsWith("media-preview-")); expect(copies).toHaveLength(1);
    expect(await hashFile(join(userData, ".grudge-vault-redesign-transient-v1", copies[0]!, "original.wav"))).toBe(originalHash);
    await page.getByRole("button", { name: "关闭预览", exact: true }).click(); await expect(player).toHaveCount(0);
    await expect.poll(entries).toEqual([".owned-by-grudge-vault"]);

    // Corrupt one byte in the isolated encrypted fixture, never in a user workspace or source.
    const objectPath = join(workspace, "vault/objects/sha256", originalHash.slice(0, 2), originalHash.slice(2, 4), `${originalHash}.gvobj`);
    const file = await open(objectPath, "r+"); const info = await file.stat(), last = Buffer.alloc(1);
    await file.read(last, 0, 1, info.size - 1); const countBeforeCorrupt = (await reads()).length;
    try {
      await file.write(Buffer.from([last[0]! ^ 1]), 0, 1, info.size - 1);
      await page.getByRole("button", { name: "预览", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("原件完整性校验失败"); expect(await reads()).toHaveLength(countBeforeCorrupt);
      await expect.poll(entries).toEqual([".owned-by-grudge-vault"]);
    } finally { await file.write(last, 0, 1, info.size - 1); await file.close(); }
    await page.getByRole("button", { name: "预览", exact: true }).click(); await expect(player).toBeVisible();
    await expect.poll(() => player.evaluate((element: globalThis.HTMLAudioElement) => element.duration)).toBeCloseTo(400, 2);
    await page.getByRole("button", { name: "锁定", exact: true }).click(); await expect(player).toHaveCount(0);
    await expect.poll(entries).toEqual([".owned-by-grudge-vault"]);
    await page.getByRole("button", { name: "暂时打开账本", exact: true }).click(); await expect(page.locator(".record-card")).toHaveCount(1);
    const newPreview = await page.evaluate(({ assetId, requestId }) => window.grudgeVault.assets.openMediaPreview({ assetId, requestId }), { assetId, requestId: randomUUID() });
    if (!newPreview.ok) throw new Error("Expected re-opened synthetic preview"); expect(newPreview.data.url).not.toBe(oldUrl);
    expect(newPreview.data.byteSize).toBeGreaterThan(64 * 1024 * 1024); expect(Object.keys(newPreview.data).sort()).toEqual(["assetId", "byteSize", "mimeType", "requestId", "url"]);
    expect(await page.evaluate((id) => window.grudgeVault.assets.closeMediaPreview(id), newPreview.data.requestId)).toMatchObject({ ok: true, data: true });
    await expect.poll(entries).toEqual([".owned-by-grudge-vault"]);
    const detail = await page.evaluate((id) => window.grudgeVault.records.get(id), recordId);
    expect(detail.ok && detail.data.attachments[0]?.sha256).toBe(originalHash); expect(await hashFile(audioPath)).toBe(originalHash);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

test("plays self-contained synthetic MP3, M4A, MP4 and MOV originals but rejects an external-reference movie", async () => {
  test.skip(process.platform !== "darwin", "Native Mac preview gate"); test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-container-preview-e2e-"));
  const workspace = join(root, "workspace"), userData = join(root, "user-data");
  const source = join(root, "synthetic.wav"), mp3 = join(root, "synthetic.mp3"), audio = join(root, "synthetic.m4a"),
    mp4 = join(root, "synthetic.mp4"), mov = join(root, "synthetic.mov"), reference = join(root, "reference-only.mov");
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await writeSyntheticWav(source, 4, 44_100, 2);
    await writeFile(mp3, syntheticSilentMp3());
    const runner = new SafeProcessRunner();
    const run = async (executable: string, args: string[]) => {
      const result = await runner.run({ executable, args, cwd: root, timeoutMs: 60_000, maxOutputBytes: 64_000 });
      expect(result.exitCode, result.stderr.toString("utf8")).toBe(0);
      return result;
    };
    const generator = join(root, "fixture-generator");
    await run("/usr/bin/xcrun", ["swiftc", "-parse-as-library", "-module-cache-path", join(root, "module-cache"),
      resolve("tests/fixtures/native-media/generate.swift"), "-o", generator]);
    await run("/usr/bin/afconvert", [source, audio, "-f", "m4af", "-d", "aac ", "-b", "128000"]);
    await run(generator, [audio, mp4, "video"]); await run(generator, [audio, mov, "video-mov"]);
    await run(generator, [mp4, reference, "reference-video"]);
    const originals = new Map(await Promise.all([mp3, audio, mp4, mov, reference].map(async (path) => [path, await hashFile(path)] as const)));
    const manager = new LocalWorkspaceManager({
      async assertAvailable() {}, async protect(key) { return `e2e:${key.toString("base64")}`; },
      async unprotect(envelope) { return { key: Buffer.from(envelope.slice(4), "base64") }; }
    }, join(root, "synthetic-state.json"));
    try {
      const seed = new GrudgeVaultApplication(manager); await seed.createWorkspace(workspace, "Synthetic Container Vault");
      const intake = await seed.prepareIntake({ text: "合成自包含媒体预览回归", paths: [...originals.keys()] });
      const saved = await seed.screenAndSaveIntake(intake.sessionId, randomUUID(), { async screen(input) {
        return { decision: "include", categories: ["grudge"], reason: "仅用于预览回归的模型替身",
          anchors: input.media.map(({ id }) => ({ sourceVersion: input.sourceVersion, temporaryMediaRef: id })),
          coverage: "complete", policyVersion: "synthetic-preview-v1" };
      } });
      expect(saved.kind).toBe("saved");
      for (const job of manager.current()!.jobs.list()) if (job.state === "queued") manager.current()!.jobs.cancel(job.id, new Date().toISOString());
    } finally { await manager.close(); }
    const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
    application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
      env: { ...inheritedEnvironment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_PREVIEW_FLOW: "1" } });
    const page = await application.firstWindow(); await expect(page.locator(".record-card")).toHaveCount(1);
    expect(await page.evaluate(() => window.grudgeVault.assets.openMediaPreview({ requestId: "invalid", assetId: "invalid" }))).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await page.evaluate(() => window.grudgeVault.assets.closeMediaPreview("invalid"))).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    await page.locator(".record-card").click(); await page.getByRole("button", { name: "原始内容", exact: true }).click();
    const entries = () => readdir(join(userData, ".grudge-vault-redesign-transient-v1"));
    for (const [name, element] of [["synthetic.mp3", "audio"], ["synthetic.m4a", "audio"], ["synthetic.mp4", "video"], ["synthetic.mov", "video"]] as const) {
      const duration = JSON.parse((await run(resolve("apps/desktop/build/native/grudge-vault-media"), ["probe", join(root, name)])).stdout.toString("utf8")).durationMs / 1000;
      expect(duration).toBeGreaterThan(3.9); expect(duration).toBeLessThan(4.2);
      const item = page.locator("li").filter({ has: page.locator(".attachment-row strong", { hasText: name }) });
      await item.getByRole("button", { name: "预览", exact: true }).click();
      const player = item.locator(`.attachment-preview ${element}`); await expect(player).toBeVisible();
      // Chromium and AVFoundation expose AAC edit/priming duration differently (4.063492 vs 4 seconds on this fixture).
      // Bound that metadata difference; actual playback/seek and video dimensions are asserted separately below.
      await expect.poll(() => player.evaluate((value: globalThis.HTMLMediaElement, expected: number) => Number.isFinite(value.duration) ? Math.abs(value.duration - expected) : Infinity, duration)).toBeLessThan(0.1);
      if (element === "video") await expect.poll(() => player.evaluate((value: globalThis.HTMLVideoElement) => value.videoWidth)).toBe(96);
      await player.evaluate((value: globalThis.HTMLMediaElement) => { value.currentTime = 2.5; });
      await player.evaluate(async (value: globalThis.HTMLMediaElement) => { await value.play(); });
      await expect.poll(() => player.evaluate((value: globalThis.HTMLMediaElement) => value.currentTime)).toBeGreaterThan(2.55);
      await player.evaluate((value: globalThis.HTMLMediaElement) => value.pause());
      if (name === "synthetic.m4a") {
        const previous = await player.getAttribute("src");
        await application.evaluate(({ dialog }, path) => {
          const state = globalThis as typeof globalThis & { __gvE2ePreviousOpenDialog?: typeof dialog.showOpenDialog };
          state.__gvE2ePreviousOpenDialog = dialog.showOpenDialog;
          dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
        }, join(root, "module-cache"));
        try {
          // Choosing an existing non-workspace directory must revoke the old lease but not permanently disable future previews.
          expect(await page.evaluate(() => window.grudgeVault.workspace.open())).toMatchObject({ ok: false });
          expect(await page.evaluate(() => window.grudgeVault.workspace.status())).toMatchObject({ ok: true, data: { status: "open" } });
          await expect.poll(entries).toEqual([".owned-by-grudge-vault"]);
        } finally {
          await application.evaluate(({ dialog }) => {
            const state = globalThis as typeof globalThis & { __gvE2ePreviousOpenDialog?: typeof dialog.showOpenDialog };
            dialog.showOpenDialog = state.__gvE2ePreviousOpenDialog!; delete state.__gvE2ePreviousOpenDialog;
          });
        }
        await item.getByRole("button", { name: "关闭预览", exact: true }).click();
        await item.getByRole("button", { name: "预览", exact: true }).click();
        await expect(player).toBeVisible(); expect(await player.getAttribute("src")).not.toBe(previous);
        await expect.poll(() => player.evaluate((value: globalThis.HTMLMediaElement, expected: number) => Number.isFinite(value.duration) ? Math.abs(value.duration - expected) : Infinity, duration)).toBeLessThan(0.1);
      }
      await item.getByRole("button", { name: "关闭预览", exact: true }).click();
      await expect.poll(entries).toEqual([".owned-by-grudge-vault"]);
    }
    const inaccessible = page.locator("li").filter({ has: page.locator(".attachment-row strong", { hasText: "reference-only.mov" }) });
    await inaccessible.getByRole("button", { name: "预览", exact: true }).click();
    await expect(inaccessible.getByRole("alert")).toContainText("超出当前安全预览能力");
    await expect(inaccessible.locator(".attachment-preview")).toHaveCount(0);
    await expect.poll(entries).toEqual([".owned-by-grudge-vault"]);
    for (const [path, hash] of originals) expect(await hashFile(path)).toBe(hash);
  } finally { await application?.close(); await rm(root, { recursive: true, force: true }); }
});

test("queries a self-contained video without saving the query and seeks to the original report interval", async () => {
  test.skip(process.platform !== "darwin", "Native Mac video query gate"); test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-video-query-e2e-"));
  const workspace = join(root, "workspace"), userData = join(root, "user-data");
  const source = join(root, "synthetic.wav"), audio = join(root, "synthetic.m4a"), video = join(root, "synthetic.mp4");
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await writeSyntheticWav(source, 4, 44_100, 2);
    const runner = new SafeProcessRunner();
    const run = async (executable: string, args: string[]) => {
      const result = await runner.run({ executable, args, cwd: root, timeoutMs: 60_000, maxOutputBytes: 64_000 });
      expect(result.exitCode, result.stderr.toString("utf8")).toBe(0);
    };
    const generator = join(root, "fixture-generator");
    await run("/usr/bin/xcrun", ["swiftc", "-parse-as-library", "-module-cache-path", join(root, "module-cache"),
      resolve("tests/fixtures/native-media/generate.swift"), "-o", generator]);
    await run("/usr/bin/afconvert", [source, audio, "-f", "m4af", "-d", "aac ", "-b", "128000"]);
    await run(generator, [audio, video, "video"]);
    const originalHash = await hashFile(video);
    const manager = new LocalWorkspaceManager({
      async assertAvailable() {}, async protect(key) { return `e2e:${key.toString("base64")}`; },
      async unprotect(envelope) { return { key: Buffer.from(envelope.slice(4), "base64") }; }
    }, join(root, "synthetic-state.json"));
    try {
      const seed = new GrudgeVaultApplication(manager); await seed.createWorkspace(workspace, "Synthetic Video Query Vault");
      // The host can already be OS-idle before Electron starts; keep this synthetic fixture open across native compilation/query.
      await seed.updateWorkspaceSecuritySettings({ autoLockMinutes: 0, integrityScanIntervalDays: 30 });
      const intake = await seed.prepareIntake({ text: "合成视频原件供查询定位", paths: [video] });
      const saved = await seed.screenAndSaveIntake(intake.sessionId, randomUUID(), { async screen(input) {
        return { decision: "include", categories: ["rights"], reason: "合成视频中的权益事实",
          anchors: [{ sourceVersion: input.sourceVersion, temporaryMediaRef: input.media[0]!.id, intervalMs: [1_000, 2_000] }],
          coverage: "complete", policyVersion: "synthetic-video-query-v1" };
      } });
      if (saved.kind !== "saved") throw new Error("Expected a synthetic video record");
      const detail = seed.getRecordDetail(saved.recordId); const assetId = detail.attachments[0]!.id;
      await seed.runRecordAnalysis(saved.recordId, detail.record.revision, { async analyze() {
        return { content: {
          summary: "合成视频记录摘要", time: { source: "ai" }, location: { source: "ai" }, people: [],
          chronology: [], mediaSegments: [{ id: randomUUID(), description: "合成视频片段显示奖金讨论",
            anchor: { sourceVersion: detail.source.sourceVersion, assetId, intervalMs: [1_000, 2_000] } }],
          unknowns: [], disputes: [], suggestions: [], legalIssues: [], citations: [], coverageNotes: []
        }, state: "complete", promptVersion: "synthetic-video-query-v1", modelProfile: "e2e:video" };
      } });
      for (const job of manager.current()!.jobs.list()) if (job.state === "queued") manager.current()!.jobs.cancel(job.id, new Date().toISOString());
    } finally { await manager.close(); }
    const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
    application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
      env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_VIDEO_QUERY_FLOW: "1",
        GRUDGE_VAULT_E2E_NO_NETWORK: "1" } });
    const page = await application.firstWindow(); await expect(page.locator(".record-card")).toHaveCount(1);
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-video-query-key" }))).toMatchObject({ ok: true });
    expect(await page.evaluate(() => window.grudgeVault.records.setSearchIndexEnabled(true))).toMatchObject({ ok: true });
    expect(await page.evaluate(() => window.grudgeVault.records.rebuildSearchIndex())).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(async () => {
      const result = await window.grudgeVault.records.searchIndexStatus(); return result.ok ? result.data.state : undefined;
    })).toBe("ready");
    const status = await page.evaluate(() => window.grudgeVault.records.searchIndexStatus());
    expect(status).toMatchObject({ ok: true, data: { queryModalities: expect.arrayContaining(["video"]) } });
    const counts = () => {
      const database = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
      try { return ["redesign_records", "redesign_sources", "redesign_pending_reviews", "assets", "redesign_reports",
        "redesign_search_embeddings"].map((table) => database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()); }
      finally { database.close(); }
    };
    const before = counts();
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByLabel("选择搜索图片、音频或视频").setInputFiles(video);
    await expect(page.locator(".query-files li")).toContainText("synthetic.mp4");
    await expect(page.locator(".semantic-toggle input")).toBeChecked();
    await expect(page.locator(".search-box").getByRole("button", { name: "搜索", exact: true })).toBeEnabled();
    await page.locator(".search-box").getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator(".search-results article")).toHaveCount(1, { timeout: 30_000 });
    const match = page.locator(".match-link").filter({ hasText: "音视频模型描述匹配" }).first();
    await expect(match).toBeVisible(); await match.click();
    const anchored = page.locator(".anchored-asset");
    await expect(anchored).toContainText("synthetic.mp4");
    await expect(anchored).toContainText("模型建议位置 1.0–2.0 秒");
    const player = anchored.locator("video"); await expect(player).toBeVisible();
    await expect(anchored.getByRole("button", { name: "关闭预览", exact: true })).toBeVisible();
    await expect.poll(() => player.evaluate((element: globalThis.HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.9);
    await expect.poll(() => player.evaluate((element: globalThis.HTMLVideoElement) => element.currentTime)).toBeLessThan(1.2);
    await anchored.getByRole("button", { name: "关闭预览", exact: true }).click();
    expect(counts()).toEqual(before); expect(await hashFile(video)).toBe(originalHash);
    await expect.poll(() => readdir(join(userData, ".grudge-vault-redesign-transient-v1")))
      .toEqual([".owned-by-grudge-vault"]);
    const calls = await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eNativeCalls?: string[] }).__gvE2eNativeCalls ?? []);
    expect(calls).toEqual(["query"]);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eVideoQuerySha256?: string
    }).__gvE2eVideoQuerySha256)).toBe(originalHash);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application?.close(); await rm(root, { recursive: true, force: true }); }
});

test("screens, encrypts, decodes and exports actual synthetic JPEG, PNG and WebP rasters", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-raster-codecs-e2e-"));
  const workspace = join(root, "workspace"), userData = join(root, "user-data");
  const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
    env: { ...inheritedEnvironment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_RASTER_FLOW: "1" } });
  try {
    const page = await application.firstWindow();
    await expect(page.locator(".new-record-button")).toBeVisible();
    const rasters = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 96; canvas.height = 64;
      const context = canvas.getContext("2d"); if (!context) throw new Error("Expected a local canvas encoder");
      for (const [color, x, y] of [["#ff0000", 0, 0], ["#00ff00", 48, 0], ["#0000ff", 0, 32], ["#ffff00", 48, 32]] as const) {
        context.fillStyle = color; context.fillRect(x, y, 48, 32);
      }
      return ([{ mimeType: "image/jpeg", extension: "jpg" }, { mimeType: "image/png", extension: "png" },
        { mimeType: "image/webp", extension: "webp" }] as const).map((format) => ({ ...format, dataUrl: canvas.toDataURL(format.mimeType, 0.95) }));
    });
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-raster-e2e-key" }))).toMatchObject({ ok: true });
    const expectedInputs: Array<{ mimeType: string; sha256: string }> = [];
    for (const { extension, mimeType, dataUrl } of rasters) {
      expect(dataUrl.startsWith(`data:${mimeType};base64,`)).toBe(true);
      const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
      const path = join(root, `synthetic.${extension}`), exported = join(root, `exported.${extension}`);
      await writeFile(path, bytes); const sha256 = createHash("sha256").update(bytes).digest("hex");
      expectedInputs.push({ mimeType, sha256 });
      const prefix = `E2E实际光栅-${extension}`;
      await page.locator(".new-record-button").click();
      const editor = page.getByRole("dialog", { name: "新建记录" });
      await editor.getByLabel("发生了什么？").fill(`${prefix}：这是仅用于格式链路验证的虚构争议图片，不是用户资料。`);
      await editor.getByLabel("添加图片、音频或视频").setInputFiles(path);
      await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
      await expect(editor).toHaveCount(0); await expect(page.locator(".detail-panel")).toBeVisible();
      const detail = await page.evaluate(async (text) => {
        const found = await window.grudgeVault.records.search({ text });
        if (!found.ok || !found.data.hits[0]) throw new Error("Expected an encrypted synthetic raster record");
        const result = await window.grudgeVault.records.get(found.data.hits[0].record.id);
        if (!result.ok) throw new Error("Expected the saved synthetic raster attachment"); return result.data;
      }, prefix);
      expect(detail.attachments).toHaveLength(1);
      expect(detail.attachments[0]).toMatchObject({ mimeType, byteSize: bytes.length, sha256 });
      await page.getByRole("button", { name: "原始内容", exact: true }).click();
      await page.getByRole("button", { name: "预览", exact: true }).click();
      const image = page.locator(".attachment-preview img");
      await expect.poll(() => image.evaluate((element: globalThis.HTMLImageElement) => [element.naturalWidth, element.naturalHeight])).toEqual([96, 64]);
      const pixels = await image.evaluate((element: globalThis.HTMLImageElement) => {
        const canvas = document.createElement("canvas"); canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
        const context = canvas.getContext("2d"); if (!context) throw new Error("Expected a local raster decoder");
        context.drawImage(element, 0, 0);
        return [[24, 16], [72, 16], [24, 48], [72, 48]].map(([x, y]) => Array.from(context.getImageData(x!, y!, 1, 1).data));
      });
      for (const [index, expected] of [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]].entries()) {
        for (const [channel, value] of expected.entries()) expect(Math.abs(pixels[index]![channel]! - value)).toBeLessThanOrEqual(15);
      }
      await application.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, exported);
      await page.getByRole("button", { name: "保存副本", exact: true }).click();
      await expect.poll(async () => { try { return (await readFile(exported)).equals(bytes); } catch { return false; } }).toBe(true);
      expect((await readFile(path)).equals(bytes)).toBe(true);
      const objectPath = join(workspace, "vault/objects/sha256", sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.gvobj`);
      expect((await readFile(objectPath)).equals(bytes)).toBe(false);
      await page.getByRole("button", { name: "关闭预览", exact: true }).click();
      await expect(image).toHaveCount(0);
      await expect.poll(() => readdir(join(userData, ".grudge-vault-redesign-transient-v1"))).toEqual([".owned-by-grudge-vault"]);
      await page.getByRole("button", { name: /返回时间线/ }).click();
    }
    expect(await application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eRasterInputs?: Array<{ mimeType: string; sha256: string }>;
    }).__gvE2eRasterInputs ?? [])).toEqual(expectedInputs);
    await expect(page.locator(".record-card")).toHaveCount(3);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});
