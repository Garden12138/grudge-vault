import { openDisclosure } from "./ui-helpers";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

async function startIsolatedUi() {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-responsive-e2e-"));
  const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  try {
    const application = await electron.launch({
      args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${join(root, "user-data")}`],
      env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: join(root, "workspace"), GRUDGE_VAULT_E2E_NO_NETWORK: "1" }
    });
    return { application, root, page: await application.firstWindow() };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

async function connectSyntheticModel(page: Page) {
  const result = await page.evaluate(() => window.grudgeVault.llm.connect({
    provider: "bailian", region: "cn-beijing", model: "qwen3.8-omni-flash", apiKey: "synthetic-responsive-key"
  }));
  expect(result).toMatchObject({ ok: true });
}

async function expectLayout(page: Page, surface: string) {
  const overflowing = await page.evaluate(() => {
    const boxes = [document.documentElement, ...document.querySelectorAll<globalThis.HTMLElement>(
      ".modal, .drawer, .intake-modal form, .file-list, .file-list li, .pending-list article, .detail-header, .report-section, .report-field, .inline-editor, .attachment-row, .match-explanation, .record-card, .settings-card, .settings-form, .banner"
    )];
    return boxes.filter((box) => box.getClientRects().length && box.scrollWidth > box.clientWidth + 1)
      .map((box) => ({ element: box.tagName, className: box.className, width: box.clientWidth, contentWidth: box.scrollWidth }));
  });
  expect(overflowing, `${surface}: essential content must fit, not merely be clipped by an outer container`).toEqual([]);
  const stretchedBadges = await page.locator(".settings-card-header > .status, .detail-header > .status").evaluateAll((badges) =>
    badges.filter((badge) => badge.getBoundingClientRect().height > 36).map((badge) => ({ height: badge.getBoundingClientRect().height, text: badge.textContent })));
  expect(stretchedBadges, `${surface}: one-line state badges must not stretch to the full section heading height`).toEqual([]);
}

test("invalidates previous screening feedback only when the input changes and allows the same file to be chosen again", async () => {
  const { application, page, root } = await startIsolatedUi();
  try {
    await expect(page.locator(".new-record-button")).toBeVisible();
    await page.locator(".new-record-button").click();
    const editor = page.getByRole("dialog", { name: "新建记录" });
    const text = editor.getByLabel("发生了什么？");
    const save = editor.getByRole("button", { name: "判断并收录", exact: true });
    await expect(editor.getByRole("heading", { name: "先连接模型，再开始记录" })).toBeVisible();
    await expect(text).toHaveCount(0);
    await expect(editor.getByRole("button", { name: "测试连接并保存" })).toBeVisible();
    await connectSyntheticModel(page);
    await page.reload(); await page.locator(".new-record-button").click();
    const ordinary = "午饭后散步，下午工作顺利。";
    await text.fill(ordinary); await save.click();
    await expect(editor.locator(".banner.neutral")).toContainText("不属于收录范围");
    await text.fill(`${ordinary}准备补充另一件具体的事。`);
    await expect(editor.locator(".banner")).toHaveCount(0);
    await text.fill(ordinary);
    const picker = editor.getByLabel("添加图片、音频或视频", { exact: true });
    const image = { name: "synthetic-feedback.png", mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=", "base64") };
    await picker.setInputFiles(image);
    await expect(editor.locator(".file-list li")).toHaveCount(1);
    await expect.poll(() => picker.inputValue()).toBe("");
    await save.click(); await expect(editor.locator(".banner.neutral")).toContainText("不属于收录范围");
    await editor.getByRole("button", { name: "移除 synthetic-feedback.png", exact: true }).click();
    await expect(editor.locator(".file-list li")).toHaveCount(0);
    await expect(editor.locator(".banner")).toHaveCount(0);
    await picker.setInputFiles(image);
    await expect(editor.locator(".file-list li")).toHaveCount(1);
    await expect.poll(() => picker.inputValue()).toBe("");
    await save.click(); await expect(editor.locator(".banner.neutral")).toContainText("不属于收录范围");
    await picker.setInputFiles([]);
    await expect(editor.locator(".file-list li")).toHaveCount(1);
    await expect(editor.locator(".banner.neutral")).toContainText("不属于收录范围");
    await text.fill("他又这样说了，我有些不安"); await save.click();
    await expect(editor.getByLabel("当前记录待确认")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(editor.locator(".banner.neutral")).toContainText("需要你确认");
    await text.fill("合成编辑后补充的完整说明。旧提示不应代表这份新输入。");
    await expect(editor.locator(".banner")).toHaveCount(0);
    const beforeIgnore = await page.evaluate(() => window.grudgeVault.pending.list());
    expect(beforeIgnore.ok && beforeIgnore.data.length).toBe(1);
    const ignored = await page.evaluate(async () => {
      const items = await window.grudgeVault.pending.list();
      if (!items.ok || items.data.length !== 1) throw new Error("Expected one synthetic prior pending input");
      return window.grudgeVault.pending.resolve(items.data[0]!.id, "ignore", globalThis.crypto.randomUUID());
    });
    expect(ignored).toMatchObject({ ok: true });
    const persisted = await page.evaluate(async () => ({
      timeline: await window.grudgeVault.records.timeline({}), pending: await window.grudgeVault.pending.list()
    }));
    expect(persisted.timeline).toMatchObject({ ok: true, data: { records: [] } });
    expect(persisted.pending).toMatchObject({ ok: true, data: [] });
    const prototypeWindow = application.waitForEvent("window");
    await application.evaluate(async ({ BrowserWindow }, prototypePath) => {
      const preview = new BrowserWindow({ width: 1440, height: 900, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
      await preview.loadFile(prototypePath);
    }, resolve("docs/redesign/UI_PROTOTYPE.html"));
    const prototype = await prototypeWindow;
    await prototype.locator("#new-record").click();
    await prototype.locator("#scene").selectOption("skip");
    const prototypeText = prototype.locator("#draft-text");
    const prototypeStatus = prototype.locator("#compose-status");
    const prototypeSave = prototype.locator("#save-draft");
    const prototypePicker = prototype.locator("#draft-files");
    await prototypeText.fill(ordinary); await prototypeSave.click();
    await expect(prototypeStatus).toContainText("普通日常未入库");
    await prototypeText.fill(`${ordinary}合成新说明。`);
    await expect(prototypeStatus).toBeEmpty();
    await prototypeSave.click(); await expect(prototypeStatus).toContainText("普通日常未入库");
    await prototypePicker.setInputFiles(image);
    await expect(prototypeStatus).toBeEmpty(); await expect.poll(() => prototypePicker.inputValue()).toBe("");
    await expect(prototype.locator("#draft-file-list .file-tag")).toHaveCount(1);
    await prototypeSave.click(); await expect(prototypeStatus).toContainText("普通日常未入库");
    await prototypePicker.setInputFiles([]);
    await expect(prototypeStatus).toContainText("普通日常未入库");
    await expect(prototype.locator("#draft-file-list .file-tag")).toHaveCount(1);
    await prototype.locator("#scene").selectOption("fail"); await prototypeSave.click();
    await expect(prototypeStatus).toContainText("未完成判断"); await expect(prototypeSave).toHaveText("重试判断");
    await prototypeText.fill("合成修改：这是一份新的输入，尚未重新判断。");
    await expect(prototypeStatus).toBeEmpty(); await expect(prototypeSave).toHaveText("保存");
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

test("uses Unicode character limits consistently for manual input and both search paths without truncating input", async () => {
  const { application, page, root } = await startIsolatedUi();
  try {
    await expect(page.locator(".new-record-button")).toBeVisible();
    await connectSyntheticModel(page);
    const boundaries = await page.evaluate(async () => {
      const manualText = "𠮷🧾".repeat(25_000);
      const queryText = "𠮷🧾".repeat(250);
      const prepared = await window.grudgeVault.intake.prepare({ requestId: globalThis.crypto.randomUUID(), text: manualText, files: [] });
      if (prepared.ok) await window.grudgeVault.intake.abandon(prepared.data.sessionId);
      const rejected = await window.grudgeVault.intake.prepare({ requestId: globalThis.crypto.randomUUID(), text: `${manualText}𠮷`, files: [] });
      if (rejected.ok) await window.grudgeVault.intake.abandon(rejected.data.sessionId);
      const searchPrepared = await window.grudgeVault.records.prepareSearch({ requestId: globalThis.crypto.randomUUID(), text: queryText, files: [] });
      if (searchPrepared.ok) await window.grudgeVault.records.abandonSearch(searchPrepared.data.sessionId);
      const searchRejected = await window.grudgeVault.records.prepareSearch({ requestId: globalThis.crypto.randomUUID(), text: `${queryText}𠮷`, files: [] });
      if (searchRejected.ok) await window.grudgeVault.records.abandonSearch(searchRejected.data.sessionId);
      const keyword = await window.grudgeVault.records.search({ text: queryText });
      const keywordRejected = await window.grudgeVault.records.search({ text: `${queryText}𠮷` });
      return {
        prepared: prepared.ok ? { ok: true, textLength: prepared.data.textLength } : { ok: false, code: prepared.error.code },
        rejected: rejected.ok ? { ok: true } : { ok: false, code: rejected.error.code },
        searchPrepared: searchPrepared.ok ? { ok: true, textLength: searchPrepared.data.textLength } : { ok: false, code: searchPrepared.error.code },
        searchRejected: searchRejected.ok ? { ok: true } : { ok: false, code: searchRejected.error.code },
        keyword: keyword.ok ? { ok: true, hits: keyword.data.hits.length } : { ok: false, code: keyword.error.code },
        keywordRejected: keywordRejected.ok ? { ok: true } : { ok: false, code: keywordRejected.error.code }
      };
    });
    expect(boundaries).toEqual({
      prepared: { ok: true, textLength: 50_000 }, rejected: { ok: false, code: "VALIDATION_FAILED" },
      searchPrepared: { ok: true, textLength: 500 }, searchRejected: { ok: false, code: "VALIDATION_FAILED" },
      keyword: { ok: true, hits: 0 }, keywordRejected: { ok: false, code: "VALIDATION_FAILED" }
    });
    await page.locator(".new-record-button").click();
    const editor = page.getByRole("dialog", { name: "新建记录" });
    const input = editor.getByLabel("发生了什么？");
    const prefix = "午饭后散步，";
    const manualText = prefix + "𠮷🧾".repeat((50_000 - Array.from(prefix).length) / 2);
    await input.focus(); await page.keyboard.insertText(manualText);
    const inputShape = () => input.evaluate((element) => {
      const value = (element as globalThis.HTMLTextAreaElement).value;
      return { characters: Array.from(value).length, intact: value.startsWith("午饭后散步，") && value.endsWith("𠮷🧾") };
    });
    await expect.poll(inputShape).toEqual({ characters: 50_000, intact: true });
    await expect(editor.locator("small")).toHaveText("50,000 / 50,000 字");
    const save = editor.getByRole("button", { name: "判断并收录", exact: true });
    await expect(save).toBeEnabled();
    await page.keyboard.insertText("𠮷");
    await expect.poll(inputShape).toEqual({ characters: 50_001, intact: false });
    await expect(save).toBeDisabled(); await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(editor.getByRole("alert")).toContainText("输入未被截断");
    await editor.locator("form").evaluate((form) => (form as globalThis.HTMLFormElement).requestSubmit());
    await expect(editor.locator(".stage-progress")).toHaveCount(0);
    await expect.poll(inputShape).toEqual({ characters: 50_001, intact: false });
    await input.focus(); await page.keyboard.press("Backspace");
    await expect(save).toBeEnabled(); await expect(editor.getByRole("alert")).toHaveCount(0);
    await save.click(); await expect(editor.getByRole("status")).toContainText("不属于收录范围");
    await expect.poll(() => input.inputValue().then((value) => value === manualText)).toBe(true);
    await page.evaluate(() => { window.confirm = () => true; });
    await editor.getByRole("button", { name: "关闭", exact: true }).click();
    await page.locator(".sidebar").getByRole("button", { name: "搜索", exact: true }).click();
    const query = page.getByPlaceholder("描述你记得的内容…");
    await query.focus(); await page.keyboard.insertText("𠮷🧾".repeat(250));
    const queryLength = () => query.evaluate((element) => Array.from((element as globalThis.HTMLInputElement).value).length);
    await expect.poll(queryLength).toBe(500);
    const search = page.locator(".search-box").getByRole("button", { name: "搜索", exact: true });
    await expect(search).toBeEnabled(); await page.keyboard.insertText("𠮷");
    await expect.poll(queryLength).toBe(501); await expect(search).toBeDisabled();
    await expect(query).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("alert")).toContainText("搜索文字不能超过 500 字");
    await query.focus(); await page.keyboard.press("Backspace");
    await expect(search).toBeEnabled(); await page.getByLabel("使用百炼语义检索").uncheck();
    await search.click(); await expect(page.getByRole("heading", { name: "没有找到相关正式记录" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    const persisted = await page.evaluate(async () => ({
      timeline: await window.grudgeVault.records.timeline({}), pending: await window.grudgeVault.pending.list()
    }));
    expect(persisted.timeline).toMatchObject({ ok: true, data: { records: [] } });
    expect(persisted.pending).toMatchObject({ ok: true, data: [] });
    const prototypeWindow = application.waitForEvent("window");
    await application.evaluate(async ({ BrowserWindow }, prototypePath) => {
      const preview = new BrowserWindow({ width: 1440, height: 900, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
      await preview.loadFile(prototypePath);
    }, resolve("docs/redesign/UI_PROTOTYPE.html"));
    const prototype = await prototypeWindow;
    await prototype.locator("#new-record").click();
    await prototype.locator("#scene").selectOption("skip");
    const prototypeText = prototype.locator("#draft-text");
    await prototypeText.fill(manualText);
    await prototype.locator("#save-draft").click();
    await expect(prototype.locator("#compose-status")).toContainText("普通日常未入库");
    await expect.poll(() => prototypeText.inputValue().then((value) => value === manualText)).toBe(true);
    await prototypeText.fill(`${manualText}𠮷`);
    await prototype.locator("#save-draft").click();
    await expect(prototype.locator("#compose-status")).toContainText("输入超出范围");
    await expect.poll(() => prototypeText.inputValue().then((value) => value === `${manualText}𠮷`)).toBe(true);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

test("keeps keyboard focus in the top dialog, protects the editor and restores the initiating control", async () => {
  const { application, page, root } = await startIsolatedUi();
  try {
    const opener = page.locator(".new-record-button");
    await expect(opener).toBeVisible();
    await connectSyntheticModel(page);
    await opener.focus(); await page.keyboard.press("Enter");
    const editor = page.getByRole("dialog", { name: "新建记录" });
    await expect(editor.getByLabel("发生了什么？")).toBeFocused();
    await editor.getByRole("button", { name: "取消", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(editor.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(editor.getByRole("button", { name: "取消", exact: true })).toBeFocused();
    await page.evaluate(() => document.querySelector<globalThis.HTMLButtonElement>(".sidebar nav button")?.focus());
    await expect.poll(() => editor.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0); await expect(opener).toBeFocused();

    await connectSyntheticModel(page);
    await opener.click();
    await editor.getByLabel("发生了什么？").fill("他又这样说了，我有些不安");
    await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(editor.getByLabel("当前记录待确认")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(editor.getByLabel("发生了什么？")).toHaveValue("他又这样说了，我有些不安");
    await editor.getByRole("button", { name: "取消", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(editor.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.keyboard.press("Escape"); await expect(editor).toBeVisible();
    await expect.poll(() => editor.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
    page.once("dialog", (dialog) => dialog.accept());
    await page.keyboard.press("Escape"); await expect(editor).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await page.locator(".sidebar").evaluate((element) => element.hasAttribute("inert"))).toBe(false);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});

test("fits the complete record, original, editing, review, search and settings paths at four window widths", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(90_000);
  const { application, page, root } = await startIsolatedUi();
  const longValue = "SyntheticReferenceWithoutSpaces".repeat(6);
  try {
    await expect(page.locator(".new-record-button")).toBeVisible();
    await connectSyntheticModel(page);
    // The injected adapter checks the same public intake path without real credentials or cloud calls.
    const retained = await page.evaluate(async () => {
      const prepared = await window.grudgeVault.intake.prepare({ requestId: globalThis.crypto.randomUUID(), text: "合成布局奖金记录：项目奖金仍未结清。", files: [] });
      if (!prepared.ok) throw new Error("Synthetic intake preparation failed");
      const saved = await window.grudgeVault.intake.screenAndSave(prepared.data.sessionId, globalThis.crypto.randomUUID());
      if (!saved.ok || saved.data.kind !== "saved") throw new Error("Synthetic record was not saved");
      const review = await window.grudgeVault.intake.prepare({ requestId: globalThis.crypto.randomUUID(), text: "他又这样说了，我有些不安", files: [] });
      if (!review.ok) throw new Error("Synthetic review preparation failed");
      const reviewed = await window.grudgeVault.intake.screenAndSave(review.data.sessionId, globalThis.crypto.randomUUID());
      if (!reviewed.ok || reviewed.data.kind !== "needs_review") throw new Error("Synthetic pending item was not created");
      return saved.data.recordId;
    });
    await expect.poll(() => page.evaluate(async (id) => {
      const detail = await window.grudgeVault.records.get(id); return detail.ok && Boolean(detail.data.report);
    }, retained), { timeout: 15_000 }).toBe(true);
    // Remount the shell so the intentionally API-created synthetic rows are refreshed.
    await page.reload();
    for (const viewport of [{ width: 1180, height: 760 }, { width: 1024, height: 800 }, { width: 840, height: 760 }, { width: 390, height: 760 }]) {
      await page.setViewportSize(viewport);
      await page.getByRole("button", { name: "时间线", exact: true }).click();
      await expect(page.locator(".record-card")).toHaveCount(1);
      await expectLayout(page, `timeline ${viewport.width}`);
      await page.locator(".record-card").click();
      await expect(page.getByRole("heading", { name: "事件摘要" })).toBeVisible();
      await expectLayout(page, `report ${viewport.width}`);
      await page.getByRole("button", { name: "编辑标题", exact: true }).click();
      await page.getByPlaceholder("输入标题").fill(longValue);
      await page.locator(".supplement").getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByRole("heading", { name: longValue, exact: true })).toBeVisible();
      await expectLayout(page, `long title ${viewport.width}`);
      await page.getByRole("button", { name: "补充地点", exact: true }).click();
      await page.getByPlaceholder("输入明确地点").fill(longValue);
      await expectLayout(page, `location editor ${viewport.width}`);
      await page.locator(".supplement").getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.locator(".report-field").getByText(longValue, { exact: true })).toBeVisible();
      await expectLayout(page, `long user field ${viewport.width}`);
      await page.getByRole("button", { name: "原始内容", exact: true }).click();
      await expectLayout(page, `original ${viewport.width}`);
      await page.getByRole("button", { name: /返回时间线/ }).click();

      await page.getByRole("button", { name: /待确认/ }).click();
      const drawer = page.getByLabel("待确认", { exact: true });
      await expect(drawer.getByText("他又这样说了，我有些不安", { exact: true })).toBeVisible();
      await expectLayout(page, `review ${viewport.width}`);
      await drawer.getByRole("button", { name: "关闭", exact: true }).click();
      await page.locator(".new-record-button").click();
      const editor = page.getByRole("dialog", { name: "新建记录", exact: true });
      await editor.getByLabel("发生了什么？").fill("午饭后散步，下午工作顺利");
      await editor.getByLabel("添加图片、音频或视频").setInputFiles({
        name: `${longValue}.png`, mimeType: "image/png",
        buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=", "base64")
      });
      await expectLayout(page, `new input with long filename ${viewport.width}`);
      await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
      await expect(editor.getByRole("status")).toContainText("不属于收录范围");
      await expectLayout(page, `skipped input ${viewport.width}`);
      if (viewport.width === 840) await page.screenshot({ path: testInfo.outputPath("editor-840.png") });
      page.once("dialog", (dialog) => dialog.accept());
      await editor.getByRole("button", { name: "关闭", exact: true }).click();

      await page.getByRole("button", { name: "搜索", exact: true }).click();
      await page.getByPlaceholder("描述你记得的内容…").fill("奖金");
      if (viewport.width === 1180) {
        await openDisclosure(page, "筛选");
        await page.locator(".search-filters").getByLabel("类别").selectOption("rights");
        await page.locator(".search-filters").getByLabel("来源").selectOption("manual");
        await page.locator(".search-box summary").click();
        await expect(page.getByRole("button", { name: "移除类别筛选：权益" })).toBeVisible();
        await page.getByRole("button", { name: "移除类别筛选：权益" }).click();
        await page.getByRole("button", { name: "移除来源筛选：手动记录" }).click();
        await expect(page.getByLabel("已选筛选条件").locator("button")).toHaveCount(0);
      }
      await page.getByLabel("使用百炼语义检索").uncheck();
      await page.locator(".search-input").getByRole("button", { name: "搜索", exact: true }).click();
      await expect(page.getByText("找到 1 条记录", { exact: true })).toBeVisible();
      await expectLayout(page, `search hits ${viewport.width}`);
      await page.getByRole("button", { name: /原文中包含“奖金”/ }).click();
      await expect(page.getByRole("heading", { name: "原始文字" })).toBeVisible();
      await expectLayout(page, `search detail ${viewport.width}`);
      await page.getByRole("button", { name: /返回搜索结果/ }).click();
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await expect(page.getByRole("heading", { name: "模型服务", exact: true })).toBeVisible();
      await expectLayout(page, `model settings ${viewport.width}`);
      await page.getByRole("button", { name: "导入", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Day One", exact: true })).toBeVisible();
      await expectLayout(page, `model and import settings ${viewport.width}`);
      if (viewport.width === 390) await page.screenshot({ path: testInfo.outputPath("settings-390.png"), fullPage: true });
    }
    const count = await page.evaluate(async () => {
      const results = await window.grudgeVault.records.timeline({}); return results.ok ? results.data.records.length : -1;
    });
    expect(count).toBe(1); // Skipped synthetic inputs must never leak into the formal list.
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});
