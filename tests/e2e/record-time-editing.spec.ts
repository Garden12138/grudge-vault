import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { TemporalValue } from "@grudge-vault/domain";

// eslint-disable-next-line no-empty-pattern
test("edits occurrence precision from the UI, protects it through reanalysis and persists unknown after restart", async ({}, testInfo) => {
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
    const calls = () => desktop.evaluate(() => (globalThis as typeof globalThis & { __gvE2eInferenceCalls?: number }).__gvE2eInferenceCalls ?? 0);
    const timeField = page.locator(".field-grid .report-field").filter({ has: page.locator("span", { hasText: /^时间$/ }) });
    const browserWindowHandle = await desktop.browserWindow(page);
    // Only this owned test window: production minWidth would otherwise clamp the 390px request to 840px.
    await browserWindowHandle.evaluate((browserWindow) => browserWindow.setMinimumSize(320, 400));
    const cases: Array<{ kind: TemporalValue["kind"]; fields: Array<[string, string]>; expected: TemporalValue; label: string }> = [
      { kind: "month", fields: [["发生月份", "2026-08"]], expected: { kind: "month", value: "2026-08" }, label: "2026-08（月份）" },
      { kind: "range", fields: [["范围起点", "2026-09"], ["范围终点", "2026-10"]],
        expected: { kind: "range", from: "2026-09", to: "2026-10" }, label: "2026-09 — 2026-10（时间范围）" },
      { kind: "relative", fields: [["时间描述", "大约上周，具体日期记不清"]],
        expected: { kind: "relative", text: "大约上周，具体日期记不清" }, label: "大约上周，具体日期记不清（相对时间）" },
      { kind: "instant", fields: [["具体时刻（含时区）", "2026-10-02T15:30:00+08:00"]],
        expected: { kind: "instant", value: "2026-10-02T07:30:00.000Z" }, label: "具体时刻" },
      { kind: "date", fields: [["发生日期", "2026-09-21"]], expected: { kind: "date", value: "2026-09-21" }, label: "2026-09-21（日期）" },
      { kind: "unknown", fields: [], expected: { kind: "unknown" }, label: "待补充" }
    ];
    for (const item of cases) {
      const before = await read(), beforeCalls = await calls();
      await page.getByRole("button", { name: "补充时间", exact: true }).click();
      await expect(page.getByLabel("时间填写方式", { exact: true })).toBeFocused();
      // Existing stored precision is used when opening, not coerced to a date.
      if (before.record.occurredAt.kind !== "unknown") await expect(page.getByLabel("时间填写方式", { exact: true }))
        .toHaveValue(before.record.occurredAt.kind);
      await page.getByLabel("时间填写方式", { exact: true }).selectOption(item.kind);
      for (const [name, value] of item.fields) await page.getByLabel(name, { exact: true }).fill(value);
      for (const width of [1440, 1024, 840, 390]) {
        await browserWindowHandle.evaluate((browserWindow, width) => browserWindow.setContentSize(width, 900), width);
        await expect.poll(() => page.evaluate(() => globalThis.innerWidth)).toBe(width);
        expect(await page.evaluate(() => [document.documentElement, ...document.querySelectorAll<globalThis.HTMLElement>(
          ".supplement,.time-editor,.time-editor label,.time-range-fields,.time-editor-actions"
        )].filter((element) => element.getClientRects().length).every((element) => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
        if (item.kind === "range" && (width === 1024 || width === 390)) {
          await page.locator(".time-editor").evaluate((element) => element.scrollIntoView({ block: "center" }));
          await page.screenshot({ path: testInfo.outputPath(`range-editor-${width}.png`) });
        }
      }
      await browserWindowHandle.evaluate((browserWindow) => browserWindow.setContentSize(1024, 900));
      await page.locator(".time-editor").getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.locator(".time-editor")).toHaveCount(0);
      const saved = await read();
      expect(saved.record.revision).toBe(before.record.revision + 1);
      expect(saved.record.occurredAt).toEqual(item.expected);
      expect(saved.record.occurredAtSource).toBe("user");
      expect(saved.overrides.find(({ fieldKey }) => fieldKey === "occurredAt")?.value).toEqual(item.expected);
      expect(saved.source).toEqual(initial.source); expect(saved.source.text).toBe(original);
      expect(await calls()).toBe(beforeCalls); // Editing does not silently start model inference.
      await expect(timeField).toContainText(item.label); await expect(timeField.locator("em")).toHaveText("你已补充");
      await page.getByRole("button", { name: "重新分析", exact: true }).click();
      await expect.poll(async () => { const detail = await read(); return detail.record.reportState === "complete" &&
        detail.report?.recordRevision === detail.record.revision; }).toBe(true);
      expect((await read()).record.occurredAt).toEqual(item.expected);
      expect((await read()).source).toEqual(initial.source);
      await expect(timeField).toContainText(item.label); await expect(timeField.locator("em")).toHaveText("你已补充");
    }
    await expect(timeField).not.toContainText("约2026年9月");
    await expect(timeField).not.toContainText("2026-09-21");
    const final = await read();
    await timeField.scrollIntoViewIfNeeded();
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
      windowWidths: [1440, 1024, 840, 390], sourceUnchanged: true, inferenceDuringEdits: 0,
      protectedThroughReanalysis: true, unknownPersistedAfterRestart: true, unexpectedNetwork: 0 }), contentType: "application/json" });
  } finally { if (application) await application.close(); await rm(root, { recursive: true, force: true }); }
});
