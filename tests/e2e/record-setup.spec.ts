import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { openDisclosure } from "./ui-helpers";

test("prechecks settings, keeps full input through failed connections and never submits automatically", async () => {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-record-setup-"));
  const application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${join(root, "user-data")}`],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined)), GRUDGE_VAULT_E2E_WORKSPACE: join(root, "workspace"), GRUDGE_VAULT_E2E_NO_NETWORK: "1", GRUDGE_VAULT_E2E_SETTINGS_READ_FAILURE: "1" } });
  try {
    const page = await application.firstWindow();
    await application.evaluate(() => { (globalThis as typeof globalThis & { __gvE2eFailSettingsReads?: boolean }).__gvE2eFailSettingsReads = false; });
    const handle = await application.browserWindow(page); await handle.evaluate(w => w.setContentSize(1180, 760));
    await page.locator(".new-record-button").click();
    const editor = page.getByRole("dialog", { name: "新建记录" });
    await expect(editor.getByRole("heading", { name: "先连接模型，再开始记录" })).toBeVisible();
    await expect(editor.getByLabel("发生了什么？")).toHaveCount(0);
    const connection = editor.getByRole("button", { name: "测试连接并保存", exact: true });
    const bounds = await connection.boundingBox(); expect(bounds && bounds.y + bounds.height).toBeLessThan(760);
    await editor.getByLabel("API 密钥").fill("synthetic-setup-key"); page.once("dialog", dialog => dialog.accept()); await connection.click();
    const text = editor.getByLabel("发生了什么？"); await expect(text).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.records.timeline({}))).toMatchObject({ ok: true, data: { records: [] } });
    const full = "午饭后散步，" + "完整输入仍在内存。".repeat(100); await text.fill(full);
    await editor.getByLabel("添加图片、音频或视频").setInputFiles({ name: "kept.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=", "base64") });
    await editor.getByRole("button", { name: "模型连接", exact: true }).click(); await openDisclosure(page, "高级设置");
    await editor.getByLabel("模型 ID").fill("e2e-connection-failure"); await connection.click();
    await expect(editor.getByRole("alert")).toBeVisible(); await expect(editor.getByText("你的文字和附件仍保留在当前编辑器中。")).toBeVisible();
    await editor.getByLabel("推荐模型").selectOption("qwen3.8-omni-flash"); await connection.click();
    await expect(text).toHaveValue(full); await expect(editor.locator(".file-list li")).toContainText("kept.png");
    expect(await page.evaluate(() => window.grudgeVault.records.timeline({}))).toMatchObject({ ok: true, data: { records: [] } });
    await editor.getByRole("button", { name: "判断并收录", exact: true }).click(); await expect(editor.getByRole("status")).toContainText("不属于收录范围");
    page.once("dialog", dialog => dialog.accept()); await editor.getByRole("button", { name: "关闭", exact: true }).click();
    expect(await page.evaluate(() => window.grudgeVault.llm.pause())).toMatchObject({ ok: true });
    await page.locator(".new-record-button").click(); await expect(editor.getByText("已暂停", { exact: true })).toBeVisible();
    await expect(editor.getByRole("button", { name: "重新测试并启用" })).toBeVisible(); await editor.getByRole("button", { name: "关闭", exact: true }).click();
    await application.evaluate(() => { (globalThis as typeof globalThis & { __gvE2eFailSettingsReads?: boolean }).__gvE2eFailSettingsReads = true; });
    await page.locator(".new-record-button").click(); await expect(editor.getByRole("heading", { name: "模型状态暂时不可用" })).toBeVisible();
    await expect(editor.getByText("未配置", { exact: true })).toHaveCount(0);
    await application.evaluate(() => { (globalThis as typeof globalThis & { __gvE2eFailSettingsReads?: boolean }).__gvE2eFailSettingsReads = false; });
    await editor.getByRole("button", { name: "重新读取模型设置" }).focus(); await page.keyboard.press("Enter");
    await expect(editor.getByText("已暂停", { exact: true })).toBeVisible();
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

test("confirms a current pending input inline and clears it on lock without reviving the editor", async () => {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-inline-review-"));
  const application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${join(root, "user-data")}`],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined)), GRUDGE_VAULT_E2E_WORKSPACE: join(root, "workspace"), GRUDGE_VAULT_E2E_NO_NETWORK: "1" } });
  try {
    const page = await application.firstWindow(); await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing", model: "qwen3.8-omni-flash", apiKey: "synthetic-confirm-key" }))).toMatchObject({ ok: true });
    await page.locator(".new-record-button").click(); const editor = page.getByRole("dialog", { name: "新建记录" });
    const full = "他又这样说了，我有些不安。" + "需要保留的完整补充。".repeat(50);
    await editor.getByLabel("发生了什么？").fill(full); await editor.getByRole("button", { name: "判断并收录" }).click();
    await expect(editor.getByLabel("当前记录待确认")).toBeVisible(); await expect(page.getByRole("dialog")).toHaveCount(1);
    await editor.getByRole("button", { name: "确认收录", exact: true }).click(); await expect(editor).toHaveCount(0);
    const saved = await page.evaluate(async () => { const list = await window.grudgeVault.records.timeline({});
      if (!list.ok || list.data.records.length !== 1) throw new Error("Expected exactly one confirmed record");
      return window.grudgeVault.records.get(list.data.records[0]!.id); });
    expect(saved).toMatchObject({ ok: true, data: { source: { text: full } } });
    expect(await page.evaluate(() => window.grudgeVault.pending.list())).toMatchObject({ ok: true, data: [] });
    await page.locator(".new-record-button").click(); await editor.getByLabel("发生了什么？").fill("锁定前的敏感输入");
    expect(await page.evaluate(() => window.grudgeVault.workspace.lock())).toMatchObject({ ok: true });
    await expect(editor).toHaveCount(0); await page.getByRole("button", { name: "暂时打开账本", exact: true }).click();
    await expect(page.locator(".new-record-button")).toBeVisible(); await expect(editor).toHaveCount(0);
    await page.locator(".new-record-button").click(); await expect(editor.getByLabel("发生了什么？")).toHaveValue("");
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});
