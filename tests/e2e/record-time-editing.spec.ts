import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { TemporalValue } from "@grudge-vault/domain";
import { openDisclosure } from "./ui-helpers";

// eslint-disable-next-line no-empty-pattern
test("supplements occurrence precision through conversation, preserves the source and persists unknown after restart", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-time-editor-e2e-"));
  const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  const options = { args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${join(root, "user-data")}`],
    env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: join(root, "workspace"), GRUDGE_VAULT_E2E_NO_NETWORK: "1" } };
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    application = await electron.launch(options);
    const desktop = application, page = await desktop.firstWindow();
    await expect(page.locator(".new-record-button")).toBeVisible();
    // Only the owned fixture: avoid host idle time auto-locking this multi-step verification.
    expect(await page.evaluate(() => window.grudgeVault.workspace.updateSecuritySettings({ autoLockMinutes: 0,
      integrityScanIntervalDays: 30 }))).toMatchObject({ ok: true });
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-time-editor-key" }))).toMatchObject({ ok: true });
    const original = "E2E时间线报告日期：合成奖金争议，月份和实际发生时间仍需本人补充。";
    await page.locator(".new-record-button").click();
    const editor = page.getByRole("dialog", { name: "新建记录" });
    await editor.getByLabel("发生了什么？").fill(original); await editor.getByRole("button", { name: "判断并收录", exact: true }).click();
    await expect(page.locator(".report-summary")).toBeVisible();
    const initial = await page.evaluate(async () => {
      const timeline = await window.grudgeVault.records.timeline({});
      if (!timeline.ok || timeline.data.records.length !== 1) throw new Error("Expected one owned synthetic record");
      const detail = await window.grudgeVault.records.get(timeline.data.records[0]!.id);
      if (!detail.ok) throw new Error("Synthetic detail unavailable"); return detail.data;
    });
    const read = () => page.evaluate(async (id) => {
      const result = await window.grudgeVault.records.get(id); if (!result.ok) throw new Error("Synthetic detail unavailable");
      return result.data;
    }, initial.record.id);
    await expect.poll(async () => (await read()).record.reportState).toBe("complete");
    const timeField = page.locator(".field-grid .report-field").filter({ has: page.locator("span", { hasText: /^时间$/ }) });
    const browserWindowHandle = await desktop.browserWindow(page);
    // Only this owned test window: production minWidth would otherwise clamp the 390px request to 840px.
    await browserWindowHandle.evaluate((browserWindow) => browserWindow.setMinimumSize(320, 400));
    const cases: Array<{ kind: TemporalValue["kind"]; answer: string; expected: TemporalValue; label: string }> = [
      { kind: "month", answer: "事情发生在2026年8月，具体哪天记不清。", expected: { kind: "month", value: "2026-08" }, label: "2026-08（月份）" },
      { kind: "range", answer: "事情发生在2026年9月到10月那段时间。",
        expected: { kind: "range", from: "2026-09", to: "2026-10" }, label: "2026-09 — 2026-10（时间范围）" },
      { kind: "relative", answer: "大约上周，具体日期记不清。",
        expected: { kind: "relative", text: "大约上周，具体日期记不清" }, label: "大约上周，具体日期记不清（相对时间）" },
      { kind: "instant", answer: "事情发生在2026年10月2日15:30，北京时间 UTC+08:00。",
        expected: { kind: "instant", value: "2026-10-02T07:30:00.000Z" }, label: "具体时刻" },
      { kind: "date", answer: "事情发生在2026年9月21日。", expected: { kind: "date", value: "2026-09-21" }, label: "2026-09-21（日期）" },
      { kind: "unknown", answer: "时间记不清，先标为不确定。", expected: { kind: "unknown" }, label: "待补充" }
    ];
    for (const item of cases) {
      const before = await read();
      await page.getByRole("button", { name: "对话补充", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "对话补充", exact: true });
      await expect(dialog.locator(".supplement-message.assistant")).toHaveCount(1);
      await expect(dialog.getByLabel("你的补充", { exact: true })).toBeFocused();
      await expect(dialog.locator(".supplement-message.assistant")).toContainText("约定的金额");
      await dialog.getByLabel("你的补充", { exact: true }).fill(item.answer);
      await dialog.getByLabel("你的补充", { exact: true }).press("Enter");
      await expect(dialog.locator(".supplement-message.assistant")).toHaveCount(2);
      expect((await read()).record.revision).toBe(before.record.revision);
      for (const width of [1440, 1024, 840, 390]) {
        await browserWindowHandle.evaluate((browserWindow, width) => browserWindow.setContentSize(width, 900), width);
        await expect.poll(() => page.evaluate(() => globalThis.innerWidth)).toBe(width);
        expect(await page.evaluate(() => [document.documentElement, ...document.querySelectorAll<globalThis.HTMLElement>(
          ".supplement-dialog,.supplement-message,.supplement-composer,.supplement-footer"
        )].filter((element) => element.getClientRects().length).every((element) => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
        if (item.kind === "range" && (width === 1024 || width === 390)) {
          await dialog.evaluate((element) => element.scrollIntoView({ block: "center" }));
          await page.screenshot({ path: testInfo.outputPath(`conversation-${width}.png`) });
        }
      }
      await browserWindowHandle.evaluate((browserWindow) => browserWindow.setContentSize(1024, 900));
      await dialog.getByRole("button", { name: "保存补充并更新报告", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(async () => { const detail = await read(); return detail.record.reportState === "complete" &&
        detail.report?.recordRevision === detail.record.revision; }).toBe(true);
      const saved = await read();
      expect(saved.record.revision).toBe(before.record.revision + 1);
      expect(saved.record.occurredAt).toEqual(item.expected);
      expect(saved.record.occurredAtSource).toBe("user");
      expect(saved.overrides.find(({ fieldKey }) => fieldKey === "occurredAt")?.value).toEqual(item.expected);
      expect(saved.source).toEqual(initial.source); expect(saved.source.text).toBe(original);
      if (item.kind === "unknown") await expect(timeField).toHaveCount(0);
      else {
        await openDisclosure(page, "时间、地点与人物");
        await expect(timeField).toContainText(item.label); await expect(timeField.locator("em")).toHaveText("你已补充");
      }
      await page.getByRole("button", { name: "重新整理", exact: true }).click();
      await expect.poll(async () => { const detail = await read(); return detail.record.reportState === "complete" &&
        detail.report?.recordRevision === detail.record.revision; }).toBe(true);
      expect((await read()).record.occurredAt).toEqual(item.expected);
      expect((await read()).source).toEqual(initial.source);
      if (item.kind === "unknown") await expect(timeField).toHaveCount(0);
      else { await expect(timeField).toContainText(item.label); await expect(timeField.locator("em")).toHaveText("你已补充"); }
    }
    await expect(timeField).toHaveCount(0);
    const final = await read();
    await page.screenshot({ path: testInfo.outputPath("unknown-after-reanalysis.png") });
    expect(await desktop.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
    await desktop.close(); application = undefined;
    application = await electron.launch(options);
    const reopenedPage = await application.firstWindow();
    await expect(reopenedPage.locator(".record-card")).toHaveCount(1);
    const reopened = await reopenedPage.evaluate(async (id) => { const result = await window.grudgeVault.records.get(id);
      if (!result.ok) throw new Error("Owned reopened record unavailable"); return result.data; }, final.record.id);
    expect(reopened.record.occurredAt).toEqual({ kind: "unknown" });
    expect(reopened.overrides).toEqual(final.overrides); expect(reopened.source).toEqual(initial.source);
    expect(reopened.record.revision).toBe(final.record.revision); expect(reopened.report?.recordRevision).toBe(final.record.revision);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
    await testInfo.attach("aggregate-time-editor-observation", { body: JSON.stringify({ modesVerified: cases.map(({ kind }) => kind),
      windowWidths: [1440, 1024, 840, 390], sourceUnchanged: true, questionBeforeAnswer: true,
      protectedThroughReanalysis: true, unknownPersistedAfterRestart: true, unexpectedNetwork: 0 }), contentType: "application/json" });
  } finally { if (application) await application.close(); await rm(root, { recursive: true, force: true }); }
});
