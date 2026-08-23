import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("completes the Phase 1 event recording loop and restores it after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-e2e-"));
  const workspace = join(root, "workspace");
  const userData = join(root, "user-data");
  const fixture = resolve("fixtures/assets/phase-zero-demo.txt");
  const expectedHash = createHash("sha256").update(await readFile(fixture)).digest("hex");
  const entry = resolve("apps/desktop/out-e2e/main/main.js");
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );

  const launch = () => electron.launch({
    args: [entry, `--user-data-dir=${userData}`],
    env: { ...inheritedEnvironment, GRUDGE_VAULT_E2E_WORKSPACE: workspace }
  });

  try {
    let application = await launch();
    let page = await application.firstWindow();
    await page.evaluate(() => window.localStorage.setItem("grudge-vault.language", "en"));
    await page.reload();
    await expect(page.getByText("Automated Vault", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Vault", exact: true }).click();
    await page.locator("#asset-file-input").setInputFiles(fixture);
    await expect(page.getByText(expectedHash)).toBeVisible();
    await expect(page.getByText("verified", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByLabel("Conversation title").fill("Work notes");
    await page.getByLabel("Conversation title").press("Enter");
    await expect(page.getByText("Work notes", { exact: true })).toBeVisible();
    await page.getByLabel("Describe what just happened…").fill("On 2026-08-20 Alex omitted my name from the report.");
    await page.getByRole("button", { name: "Save record" }).click();
    await expect(page.getByText("Candidate event created")).toBeVisible();
    await page.getByRole("button", { name: "Open event" }).click();

    await expect(page.getByRole("heading", { name: "Event details" })).toBeVisible();
    await page.locator("#event-asset-file-input").setInputFiles(fixture);
    await expect(page.getByText("phase-zero-demo.txt", { exact: true }).first()).toBeVisible();
    await page.getByPlaceholder("Person name").fill("Alex");
    await page.getByPlaceholder("Person name").locator("..").getByRole("button").click();
    await page.getByLabel("Facts").fill("[confirmed] The report omitted my name.");
    await page.getByLabel("Interests").fill("Attribution|Preserve accurate authorship.");
    await page.getByRole("checkbox", { name: "Alex", exact: true }).check();
    await page.getByRole("button", { name: "Save revision" }).click();
    await page.getByRole("button", { name: "Confirm event" }).click();
    await expect(page.getByText("Revision 4", { exact: true })).toBeVisible();

    await page.getByPlaceholder("Keywords, facts, emotions, or interests").fill("attribution");
    await page.locator(".filters select").nth(1).selectOption({ label: "Alex" });
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByText("On 2026-08-20 Alex omitted my name from the report", { exact: true }).first()).toBeVisible();
    await application.close();

    application = await launch();
    page = await application.firstWindow();
    await expect(page.getByText("Automated Vault", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Events", exact: true }).click();
    await expect(page.getByText("On 2026-08-20 Alex omitted my name from the report", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Vault", exact: true }).click();
    await expect(page.getByText(expectedHash)).toBeVisible();
    await application.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
