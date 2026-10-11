import { expect, type ElectronApplication, type Page } from "@playwright/test";

export async function focusDesktop(application: ElectronApplication, page: Page) {
  await application.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    app.focus({ steal: true });
    window.show();
    window.focus();
    window.webContents.focus();
  });
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
}
export async function openDisclosure(page: Page, title: string) {
  const details = page.locator("details").filter({ has: page.locator("summary", { hasText: title }) }).first();
  await expect(details).toBeVisible();
  if (!await details.getAttribute("open").then(value => value !== null)) await details.locator("summary").click();
}
export async function supplementRecord(page: Page, text: string) {
  await page.getByRole("button", { name: "对话补充", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "对话补充", exact: true });
  await expect(dialog.locator(".supplement-message.assistant")).toHaveCount(1);
  await dialog.getByLabel("你的补充", { exact: true }).fill(text);
  await dialog.getByRole("button", { name: "发送", exact: true }).click();
  await expect(dialog.locator(".supplement-message.assistant")).toHaveCount(2);
  await dialog.getByRole("button", { name: "保存补充并更新报告", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
export async function settingsGroup(page: Page, name: "模型服务" | "导入" | "隐私与安全") {
  const navigation = page.getByRole("navigation", { name: "设置分组" });
  if (await navigation.isVisible()) await navigation.getByRole("button", { name, exact: true }).click();
}
