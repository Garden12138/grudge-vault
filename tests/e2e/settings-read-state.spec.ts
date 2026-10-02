import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

// eslint-disable-next-line no-empty-pattern
test("shows settings read failures as unknown and retries each source without model calls or settings writes", async ({}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-settings-state-e2e-"));
  const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    desktop = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${join(root, "user-data")}`],
      env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: join(root, "workspace"), GRUDGE_VAULT_E2E_NO_NETWORK: "1",
        GRUDGE_VAULT_E2E_SETTINGS_READ_FAILURE: "1" } });
    const page = await desktop.firstWindow();
    await expect(page.getByRole("heading", { name: "时间线", exact: true })).toBeVisible();
    const browserWindowHandle = await desktop.browserWindow(page);
    await browserWindowHandle.evaluate(value => value.setContentSize(840, 900));
    await expect.poll(() => page.evaluate(() => globalThis.innerWidth)).toBe(840);
    await expect.poll(() => page.evaluate(async () => { const jobs = await window.grudgeVault.jobs.list();
      return jobs.ok && !jobs.data.some(({ state }) => state === "queued" || state === "running"); })).toBe(true);
    const before = await page.evaluate(async () => ({ model: await window.grudgeVault.llm.getSettings(),
      index: await window.grudgeVault.records.searchIndexStatus(), legal: await window.grudgeVault.legal.getDefaultJurisdiction(),
      timeline: await window.grudgeVault.records.timeline({}), pending: await window.grudgeVault.pending.list() }));
    await desktop.evaluate(() => { (globalThis as typeof globalThis & { __gvE2eFailSettingsReads?: boolean }).__gvE2eFailSettingsReads = true; });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const card = page.locator(".settings-card").filter({ has: page.getByRole("heading", { name: "多模态搜索索引", exact: true }) });
    await expect(page.getByRole("button", { name: "重新读取模型设置", exact: true })).toBeVisible();
    await expect(card.getByRole("alert")).toContainText("暂时无法读取索引状态");
    await expect(card.locator(".status")).toHaveText("状态未知");
    await expect(card).not.toContainText("未建立"); await expect(card).not.toContainText("请先连接百炼");
    await expect(page.getByRole("button", { name: "保存默认地域", exact: true })).toBeDisabled();
    await expect(page.getByLabel("默认地域", { exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "选择 Day One 导出 ZIP", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("settings-model-read-unavailable.png") });
    await card.screenshot({ path: testInfo.outputPath("settings-index-read-unavailable.png") });
    await page.getByRole("button", { name: "重新读取模型设置", exact: true }).focus();
    await expect(page.getByRole("button", { name: "重新读取模型设置", exact: true })).toBeFocused();
    await desktop.evaluate(() => { (globalThis as typeof globalThis & { __gvE2eFailSettingsReads?: boolean }).__gvE2eFailSettingsReads = false; });
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "重新读取模型设置", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "重新读取索引状态", exact: true }).click();
    await page.getByRole("button", { name: "重新读取默认地域", exact: true }).click();
    await expect(card.locator(".status")).toHaveText("未建立"); await expect(card).toContainText("请先连接百炼");
    await expect(page.getByLabel("默认地域", { exact: true })).toHaveValue("中国大陆");
    const after = await page.evaluate(async () => ({ model: await window.grudgeVault.llm.getSettings(),
      index: await window.grudgeVault.records.searchIndexStatus(), legal: await window.grudgeVault.legal.getDefaultJurisdiction(),
      timeline: await window.grudgeVault.records.timeline({}), pending: await window.grudgeVault.pending.list() }));
    expect(after).toEqual(before);
    expect(await desktop.evaluate(() => (globalThis as typeof globalThis & { __gvE2eInferenceCalls?: number }).__gvE2eInferenceCalls ?? 0)).toBe(0);
    expect(await desktop.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
    const failures = await desktop.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eSettingsReadFailures?: Record<"model" | "index" | "jurisdiction", number> }).__gvE2eSettingsReadFailures);
    for (const kind of ["model", "index", "jurisdiction"] as const) expect(failures?.[kind]).toBeGreaterThanOrEqual(1);
    await testInfo.attach("aggregate-settings-read-state", { body: JSON.stringify({ failures, windowWidth: 840,
      unknownNotUnconfigured: true, unreadLegalNotSaveableDefault: true, threeReadOnlyRetries: true, keyboardRetryVerified: true,
      originalSettingsAndFormalContentsUnchanged: true, inferenceCalls: 0, unexpectedNetwork: 0 }), contentType: "application/json" });
  } finally { if (desktop) await desktop.close(); await rm(root, { recursive: true, force: true }); }
});
