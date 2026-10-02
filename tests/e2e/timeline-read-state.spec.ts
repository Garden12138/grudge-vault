import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

// eslint-disable-next-line no-empty-pattern
test("does not show a failed timeline read as empty or a stale list under a new filter and retries without model calls", async ({}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-timeline-state-e2e-"));
  const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    desktop = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${join(root, "user-data")}`],
      env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: join(root, "workspace"), GRUDGE_VAULT_E2E_NO_NETWORK: "1",
        GRUDGE_VAULT_E2E_TIMELINE_READ_FAILURE: "1" } });
    const page = await desktop.firstWindow();
    await expect(page.getByRole("heading", { name: "时间线", exact: true })).toBeVisible();
    const browserWindowHandle = await desktop.browserWindow(page);
    await browserWindowHandle.evaluate((value) => value.setContentSize(840, 900));
    await expect.poll(() => page.evaluate(() => globalThis.innerWidth)).toBe(840);
    await expect.poll(() => page.evaluate(async () => { const jobs = await window.grudgeVault.jobs.list();
      return jobs.ok && !jobs.data.some(({ state }) => state === "queued" || state === "running"); })).toBe(true);
    await expect(page.getByRole("alert")).toContainText("暂时无法读取时间线");
    await expect(page.locator(".empty-state")).toHaveCount(0); await expect(page.locator(".record-card")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("timeline-first-read-unavailable.png") });
    await page.getByRole("button", { name: "重新载入时间线", exact: true }).focus();
    await expect(page.getByRole("button", { name: "重新载入时间线", exact: true })).toBeFocused();
    await desktop.evaluate(() => { (globalThis as typeof globalThis & { __gvE2eFailTimelineRead?: boolean }).__gvE2eFailTimelineRead = false; });
    await page.keyboard.press("Enter");
    await expect(page.locator(".empty-state")).toBeVisible();
    expect(await desktop.evaluate(() => (globalThis as typeof globalThis & { __gvE2eInferenceCalls?: number }).__gvE2eInferenceCalls ?? 0)).toBe(0);
    // Only the owned empty configuration and fake model adapter, never a real key or workspace.
    expect(await page.evaluate(() => window.grudgeVault.workspace.updateSecuritySettings({ autoLockMinutes: 0,
      integrityScanIntervalDays: 30 }))).toMatchObject({ ok: true });
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-timeline-state-key" }))).toMatchObject({ ok: true });
    await page.locator(".new-record-button").click();
    await page.getByLabel("发生了什么？").fill("合成时间线回归：项目奖金仍未支付，需要核对约定与处理步骤。");
    await page.getByRole("dialog", { name: "新建记录" }).getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator(".report-summary")).toBeVisible();
    await expect.poll(() => page.evaluate(async () => { const jobs = await window.grudgeVault.jobs.list();
      return jobs.ok && !jobs.data.some(({ state }) => state === "queued" || state === "running"); })).toBe(true);
    const before = await page.evaluate(async () => {
      const list = await window.grudgeVault.records.timeline({});
      if (!list.ok || list.data.records.length !== 1) throw new Error("Expected one owned synthetic timeline record");
      const detail = await window.grudgeVault.records.get(list.data.records[0]!.id);
      if (!detail.ok) throw new Error("Owned synthetic detail unavailable"); return detail.data;
    });
    const calls = await desktop.evaluate(() => (globalThis as typeof globalThis & { __gvE2eInferenceCalls?: number }).__gvE2eInferenceCalls ?? 0);
    await page.getByRole("button", { name: "← 返回时间线", exact: true }).click(); await expect(page.locator(".record-card")).toHaveCount(1);
    await desktop.evaluate(() => { (globalThis as typeof globalThis & { __gvE2eFailTimelineRead?: boolean }).__gvE2eFailTimelineRead = true; });
    await page.locator(".filter-bar select").first().selectOption("danger");
    await expect(page.getByRole("alert")).toContainText("暂时无法读取时间线");
    await expect(page.locator(".record-card")).toHaveCount(0); await expect(page.locator(".empty-state")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("timeline-filter-read-unavailable.png") });
    await desktop.evaluate(() => { (globalThis as typeof globalThis & { __gvE2eFailTimelineRead?: boolean }).__gvE2eFailTimelineRead = false; });
    await page.getByRole("button", { name: "重新载入时间线", exact: true }).click(); await expect(page.locator(".empty-state")).toBeVisible();
    await page.locator(".filter-bar select").first().selectOption(""); await expect(page.locator(".record-card")).toHaveCount(1);
    expect(await page.evaluate((id) => window.grudgeVault.records.get(id), before.record.id)).toEqual({ ok: true, data: before });
    expect(await desktop.evaluate(() => (globalThis as typeof globalThis & { __gvE2eInferenceCalls?: number }).__gvE2eInferenceCalls ?? 0)).toBe(calls);
    const readFailures = await desktop.evaluate(() => (globalThis as typeof globalThis & { __gvE2eTimelineReadFailures?: number }).__gvE2eTimelineReadFailures ?? 0);
    expect(readFailures).toBeGreaterThanOrEqual(2);
    expect(await desktop.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
    await testInfo.attach("aggregate-timeline-read-state", { body: JSON.stringify({ readFailurePhases: 2, readFailures,
      failedReadNotEmpty: true, failedFilterHidesOldRows: true, retriesReadOnly: true, savedDetailUnchanged: true,
      keyboardRetryVerified: true, windowWidth: 840, modelCallsDuringRetriesAndFilters: 0, unexpectedNetwork: 0 }), contentType: "application/json" });
  } finally { if (desktop) await desktop.close(); await rm(root, { recursive: true, force: true }); }
});
