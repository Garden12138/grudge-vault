import { mkdtemp, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { _electron as electron, expect, test } from "@playwright/test";
import { ZipFile } from "yazl";
import { LocalWorkspaceManager } from "../../apps/desktop/src/main/workspace-manager";
import { GrudgeVaultApplication } from "../../packages/application/src/index";
import { DayOneZipImporter } from "../../packages/importer-dayone/src/index";

// eslint-disable-next-line no-empty-pattern
test("recovers all old pending details from the original ZIP without screening or confirming them", async ({}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-old-pending-e2e-"));
  const workspace = join(root, "workspace"), archive = join(root, "original.zip");
  const texts = ["第一条原始经过".repeat(50) + "第一条末尾", "第二条原始经过".repeat(50) + "第二条末尾"];
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ entries: texts.map((text, index) => ({ uuid: `OLD-PENDING-${index}`,
    creationDate: "2026-10-01T00:00:00Z", text })) })), "Journal.json");
  zip.end(); await pipeline(zip.outputStream, createWriteStream(archive));
  const seed = new LocalWorkspaceManager({ async assertAvailable() {}, async protect(key) { return `e2e:${key.toString("base64")}`; },
    async unprotect(envelope) { return { key: Buffer.from(envelope.slice(4), "base64") }; } }, join(root, "seed-state.json"));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await seed.create(workspace, "合成旧待确认账本");
    const service = new GrudgeVaultApplication(seed, undefined, new DayOneZipImporter());
    await service.importScreenedDayOneZip(archive, { async screen() {
      return { decision: "review", categories: ["rights"], reason: "需要确认", anchors: [], coverage: "complete", policyVersion: "synthetic-v1" };
    } });
    const old = service.listPendingReviews();
    for (const item of old) { seed.current()!.records!.deletePending(item.id); seed.current()!.records!.createPending(item, randomUUID()); }
    await seed.close();
    const options = { args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${join(root, "user-data")}`],
      env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined)),
        GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NO_NETWORK: "1" } };
    application = await electron.launch(options);
    let page = await application.firstWindow(); await page.getByRole("button", { name: /待确认/ }).click();
    const drawer = page.getByRole("dialog", { name: "待确认", exact: true });
    const item = drawer.locator("article").first(); await item.getByRole("button", { name: "查看详情", exact: true }).click();
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, archive);
    await item.getByRole("button", { name: "选择原 ZIP，补全全文", exact: true }).click();
    await expect(item.getByRole("status")).toHaveText("已补全 2 条待确认的全文。");
    await expect(item.locator("pre")).toHaveText(texts.find(text => text.slice(0, 60) === old[0]!.excerpt.slice(0, 60))!);
    await page.screenshot({ path: testInfo.outputPath("old-pending-recovered.png") });
    expect(await page.evaluate(() => window.grudgeVault.records.timeline({}))).toMatchObject({ ok: true, data: { records: [] } });
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eInferenceCalls?: number }).__gvE2eInferenceCalls ?? 0)).toBe(0);
    await application.close(); application = await electron.launch(options); page = await application.firstWindow();
    for (const pending of old) {
      const result = await page.evaluate(id => window.grudgeVault.pending.get(id), pending.id);
      expect(result).toMatchObject({ ok: true, data: { text: texts.find(text => text.slice(0, 60) === pending.excerpt.slice(0, 60)), sessionAvailable: true } });
    }
    expect(await page.evaluate(() => window.grudgeVault.pending.list())).toMatchObject({ ok: true, data: [{}, {}] });
  } finally { if (application) await application.close(); await seed.close(); await rm(root, { recursive: true, force: true }); }
});

// eslint-disable-next-line no-empty-pattern
test("reads the full pending day after closing and restarting, then removes it when ignored", async ({}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-pending-details-e2e-"));
  const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const options = { args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${join(root, "user-data")}`],
    env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: join(root, "workspace"), GRUDGE_VAULT_E2E_NO_NETWORK: "1" } };
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const text = "他又这样说了，我有些不安。\n" + "当天其他事情的上下文。".repeat(80) + "\n最后他提到要扣掉我当月的奖金，这是我想核对的具体事情。";
  try {
    application = await electron.launch(options);
    let page = await application.firstWindow(); await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-pending-detail-key" }))).toMatchObject({ ok: true });
    await page.locator(".new-record-button").click();
    const editor = page.getByRole("dialog", { name: "新建记录" });
    await editor.getByLabel("发生了什么？").fill(text); await editor.getByRole("button", { name: "判断并收录" }).click();
    await expect(editor.getByLabel("当前记录待确认")).toBeVisible();
    page.once("dialog", dialog => dialog.accept()); await editor.getByRole("button", { name: "关闭", exact: true }).click();
    await application.close(); application = await electron.launch(options); page = await application.firstWindow();
    await page.getByRole("button", { name: /待确认/ }).click();
    const drawer = page.getByRole("dialog", { name: "待确认", exact: true });
    await drawer.getByRole("button", { name: "查看详情", exact: true }).click();
    await expect(drawer.getByLabel("待确认详情").locator("pre")).toHaveText(text);
    await expect(drawer.getByText(/记录日期/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("pending-full-detail.png") });
    const read = await page.evaluate(async () => {
      const list = await window.grudgeVault.pending.list(); if (!list.ok) throw new Error("Synthetic pending unavailable");
      const item = list.data[0]!; const detail = await window.grudgeVault.pending.get(item.id);
      const timeline = await window.grudgeVault.records.timeline({});
      return { summaryText: item.text, detail: detail.ok ? detail.data : undefined, records: timeline.ok ? timeline.data.records.length : -1 };
    });
    expect(read.summaryText).toBeUndefined(); expect(read.detail).toMatchObject({ text, sessionAvailable: true }); expect(read.records).toBe(0);
    await drawer.getByRole("button", { name: "忽略并清理", exact: true }).click();
    await expect(drawer.getByText("没有待确认内容", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.pending.list())).toMatchObject({ ok: true, data: [] });
  } finally { if (application) await application.close(); await rm(root, { recursive: true, force: true }); }
});

// eslint-disable-next-line no-empty-pattern
test("supplements an imported pending day from local storage after the ZIP is deleted and keeps the original after restart", async ({}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-durable-pending-e2e-"));
  const workspace = join(root, "workspace"), archive = join(root, "original.zip");
  const original = "他又这样说了，我有些不安。\n" + "当天完整日记的上下文。".repeat(80) + "\n这是原文末尾，必须保留。";
  const supplement = "做梦梦游伤害到自己了";
  const zip = new ZipFile(); zip.addBuffer(Buffer.from(JSON.stringify({ entries: [{ uuid: "DURABLE-DAY", creationDate: "2026-04-13T13:47:56Z", text: original }] })), "Journal.json");
  zip.end(); await pipeline(zip.outputStream, createWriteStream(archive));
  const seed = new LocalWorkspaceManager({ async assertAvailable() {}, async protect(key) { return `e2e:${key.toString("base64")}`; },
    async unprotect(envelope) { return { key: Buffer.from(envelope.slice(4), "base64") }; } }, join(root, "seed-state.json"));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await seed.create(workspace, "合成本地原文账本");
    const service = new GrudgeVaultApplication(seed, undefined, new DayOneZipImporter());
    await service.importScreenedDayOneZip(archive, { async screen() { return { decision: "review", categories: ["danger"], reason: "具体发生了什么？", anchors: [], coverage: "complete", policyVersion: "synthetic" }; } });
    await seed.close(); await rm(archive);
    const options = { args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${join(root, "user-data")}`],
      env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined)), GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NO_NETWORK: "1" } };
    application = await electron.launch(options); let page = await application.firstWindow();
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing", model: "qwen3.8-omni-flash", apiKey: "synthetic-local-pending-key" }))).toMatchObject({ ok: true });
    await page.getByRole("button", { name: /待确认/ }).click();
    const drawer = page.getByRole("dialog", { name: "待确认", exact: true });
    await expect(drawer.getByText("从原件恢复")).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "确认保留", exact: true })).toBeEnabled();
    await drawer.getByRole("button", { name: "补充", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "补充待确认内容", exact: true });
    await editor.locator("summary").filter({ hasText: "原文" }).click();
    await expect(editor.locator("pre")).toHaveText(original);
    await editor.getByLabel("补充什么？", { exact: true }).fill(supplement);
    await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(editor).toHaveCount(0);
    const snapshot = await page.evaluate(async () => {
      const timeline = await window.grudgeVault.records.timeline({}); if (!timeline.ok || !timeline.data.records[0]) throw new Error("Synthetic record unavailable");
      const detail = await window.grudgeVault.records.get(timeline.data.records[0].id); if (!detail.ok) throw new Error("Synthetic detail unavailable"); return detail.data;
    });
    expect(snapshot.source.text).toBe(original); expect(snapshot.source.recordedAt).toBe("2026-04-13T13:47:56.000Z");
    expect(snapshot.record.origin).toBe("zip");
    expect(snapshot.overrides.find(item => item.fieldKey === "clarifications")?.value).toEqual([expect.objectContaining({ response: supplement })]);
    await page.getByRole("button", { name: "原始内容", exact: true }).click();
    await expect(page.locator(".source-view pre")).toHaveText(original);
    await page.screenshot({ path: testInfo.outputPath("supplement-preserves-original.png") });
    await application.close(); application = await electron.launch(options); page = await application.firstWindow();
    const reopened = await page.evaluate(id => window.grudgeVault.records.get(id), snapshot.record.id);
    expect(reopened).toMatchObject({ ok: true, data: { source: { text: original }, overrides: [expect.objectContaining({ value: [expect.objectContaining({ response: supplement })] })] } });
    expect(await page.evaluate(() => window.grudgeVault.pending.list())).toMatchObject({ ok: true, data: [] });
  } finally { if (application) await application.close(); await seed.close(); await rm(root, { recursive: true, force: true }); }
});
