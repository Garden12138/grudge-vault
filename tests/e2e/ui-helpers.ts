import { expect, type Page } from "@playwright/test";
export async function openDisclosure(page: Page, title: string) {
  const details = page.locator("details").filter({ has: page.locator("summary", { hasText: title }) }).first();
  await expect(details).toBeVisible();
  if (!await details.getAttribute("open").then(value => value !== null)) await details.locator("summary").click();
}
export async function settingsGroup(page: Page, name: "模型服务" | "导入" | "隐私与安全") {
  const navigation = page.getByRole("navigation", { name: "设置分组" });
  if (await navigation.isVisible()) await navigation.getByRole("button", { name, exact: true }).click();
}
