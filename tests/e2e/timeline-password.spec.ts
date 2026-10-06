import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { _electron as electron, expect, test } from "@playwright/test";

const images = resolve("release-preview/ux-20261006");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-timeline-password-e2e-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const launch = () => electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${join(root, "user-data")}`],
    env: { ...env, GRUDGE_VAULT_E2E_WORKSPACE: join(root, "workspace"), GRUDGE_VAULT_E2E_NO_NETWORK: "1" } });
  const application = await launch(); return { root, application, page: await application.firstWindow(), launch };
}

test("validates a ledger password across lock, folder selection and restart, with clean sensitive fields", async () => {
  const fixtureValue = await fixture(); let application = fixtureValue.application;
  try {
    let page = fixtureValue.page;
    await expect(page.locator(".new-record-button")).toBeVisible();
    await page.getByRole("button", { name: "锁定", exact: true }).click();
    await expect(page.getByRole("heading", { name: "给账本加一把锁" })).toBeVisible();
    await page.getByLabel("设置账本密码", { exact: true }).fill("Synthetic secret 2026");
    await page.getByLabel("再输入一次密码").fill("Different secret 2026");
    await page.getByRole("button", { name: "设置密码并打开账本" }).click();
    await expect(page.getByRole("alert")).toContainText("两次输入的密码不同");
    await page.getByLabel("再输入一次密码").fill("Synthetic secret 2026");
    await page.getByRole("button", { name: "设置密码并打开账本" }).click();
    await expect(page.locator(".new-record-button")).toBeVisible();
    await page.getByRole("button", { name: "锁定", exact: true }).click();
    await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
    await expect(page.getByLabel("账本密码", { exact: true })).toHaveValue("");
    await mkdir(images, { recursive: true });
    await page.setViewportSize({ width: 1180, height: 760 });
    await page.screenshot({ animations: "disabled", path: join(images, "password-lock-1180.png") });
    expect(await page.evaluate(() => window.grudgeVault.workspace.unlock())).toMatchObject({ ok: false, error: { code: "WORKSPACE_PASSWORD_REQUIRED" } });
    await page.getByLabel("账本密码", { exact: true }).fill("wrong password 2026");
    await page.getByRole("button", { name: "打开账本", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("密码不正确");
    await expect(page.getByLabel("账本密码", { exact: true })).toHaveValue("");
    await page.getByLabel("账本密码", { exact: true }).fill("Synthetic secret 2026");
    await page.keyboard.press("Enter");
    await expect(page.locator(".new-record-button")).toBeVisible();
    await application.evaluate(({ dialog }, workspace) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] }); }, join(fixtureValue.root, "workspace"));
    expect(await page.evaluate(() => window.grudgeVault.workspace.open())).toMatchObject({ ok: false, error: { code: "WORKSPACE_PASSWORD_REQUIRED" } });
    await expect(page.getByLabel("账本密码", { exact: true })).toBeVisible();
    await application.close(); application = await fixtureValue.launch(); page = await application.firstWindow();
    await expect(page.getByLabel("账本密码", { exact: true })).toBeVisible();
    await expect(page.locator(".app-shell")).toHaveCount(0);
    await page.getByLabel("账本密码", { exact: true }).fill("Synthetic secret 2026"); await page.keyboard.press("Enter");
    await expect(page.locator(".app-shell")).toBeVisible();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("navigation", { name: "设置分组" }).getByRole("button", { name: "隐私与安全" }).click();
    await page.getByLabel("当前密码").fill("Synthetic secret 2026");
    await page.getByLabel("新密码", { exact: true }).fill("Synthetic new secret 2026"); await page.getByLabel("确认新密码").fill("Synthetic new secret 2026");
    await page.getByRole("button", { name: "修改账本密码" }).click(); await expect(page.getByRole("status")).toContainText("密码已保存");
    await expect(page.getByLabel("当前密码")).toHaveValue("");
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application.close(); await rm(fixtureValue.root, { recursive: true, force: true }); }
});

test("shows compact connected nodes, hover and keyboard previews, equal date controls and responsive layouts", async () => {
  const { root, application, page } = await fixture();
  try {
    await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing", model: "qwen3.8-omni-flash", apiKey: "synthetic-ui-key" }))).toMatchObject({ ok: true });
    await page.evaluate(async () => {
      for (let index = 0; index < 8; index++) {
        const prepared = await window.grudgeVault.intake.prepare({ requestId: globalThis.crypto.randomUUID(), text: `合成项目奖金记录 ${index + 1}：项目奖金仍未结清，需要整理沟通经过。`, files: [] });
        if (!prepared.ok) throw Error("Synthetic prepare failed");
        const saved = await window.grudgeVault.intake.screenAndSave(prepared.data.sessionId, globalThis.crypto.randomUUID());
        if (!saved.ok || saved.data.kind !== "saved") throw Error("Synthetic screening failed");
        const detail = await window.grudgeVault.records.get(saved.data.recordId);
        if (!detail.ok) throw Error("Synthetic detail failed");
        const patched = await window.grudgeVault.records.patchFields({ recordId: detail.data.record.id, expectedRevision: detail.data.record.revision,
          patch: { occurredAt: { kind: "date", value: `2026-09-${String(24 - index * 2).padStart(2, "0")}` }, title: ["奖金结算还未收到回复", "补充书面约定", "整理项目结算凭据", "跟进上次沟通", "保存会议中的约定", "确认奖金发放时间", "核对结算明细", "第一次提出结算问题"][index] } });
        if (!patched.ok) throw Error("Synthetic patch failed");
      }
    });
    await page.reload(); await expect(page.locator(".timeline-event")).toHaveCount(8); await mkdir(images, { recursive: true });
    for (const width of [1180, 1024, 840, 390]) {
      await page.setViewportSize({ width, height: 760 }); await page.mouse.move(0, 0);
      const controls = await page.locator(".filter-bar input, .filter-bar select").evaluateAll(elements => elements.map(element => ({ top: element.getBoundingClientRect().top, height: element.getBoundingClientRect().height })));
      expect(new Set(controls.map(control => control.height)).size).toBe(1);
      if (width > 840) expect(new Set(controls.map(control => control.top)).size).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
      await expect(page.locator(".timeline-preview")).toHaveCount(0);
      await page.screenshot({ animations: "disabled", path: join(images, `timeline-${width}.png`) });
      if (width === 1180) {
        const first = page.locator(".timeline-event").first(); await first.hover(); await expect(page.locator(".timeline-preview")).toBeVisible();
        await page.screenshot({ animations: "disabled", path: join(images, "timeline-hover-1180.png") });
        await page.mouse.move(0, 0); await expect(page.locator(".timeline-preview")).toHaveCount(0);
        await first.focus(); await expect(page.locator(".timeline-preview")).toBeVisible();
        await page.keyboard.press("Escape"); await expect(page.locator(".timeline-preview")).toHaveCount(0); await expect(first).toBeFocused();
        await page.keyboard.press("Enter"); await expect(page.getByRole("heading", { name: "事件摘要" })).toBeVisible();
        await page.getByRole("button", { name: "← 返回时间线", exact: true }).click();
      }
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.locator(".timeline-background i").first().evaluate(element => globalThis.getComputedStyle(element).animationName)).toBe("none");
    await page.locator(".timeline-event").first().click(); await expect(page.getByRole("heading", { name: "事件摘要" })).toBeVisible();
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
  } finally { await application.close(); await rm(root, { recursive: true, force: true }); }
});
