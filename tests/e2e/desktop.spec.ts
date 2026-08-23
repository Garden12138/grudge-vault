import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("completes the Phase 2 recording, Day One backfill, and idempotent re-import loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-e2e-"));
  const workspace = join(root, "workspace");
  const userData = join(root, "user-data");
  const fixture = resolve("fixtures/assets/phase-zero-demo.txt");
  const dayOneFixture = resolve("fixtures/dayone/synthetic-minimal.zip");
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

    await application.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [filePath] })
      });
    }, dayOneFixture);
    await page.getByRole("button", { name: "Backfill", exact: true }).click();
    await page.getByRole("button", { name: "Choose JSON ZIP", exact: true }).click();
    const latestImport = page.locator(".import-panel .run-list article").first();
    await expect(latestImport.locator(".status")).toHaveText("succeeded", { timeout: 15_000 });
    await expect(latestImport).toContainText("+1");
    await page.getByRole("button", { name: "Start backfill", exact: true }).click();
    const importedTitle = "Synthetic journal entry for future importer development.";
    await expect(page.getByText(importedTitle, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await page.getByText(importedTitle, { exact: true }).first().click();
    await page.getByRole("button", { name: "Open event", exact: true }).click();
    await page.getByLabel("Facts").fill("[unknown] Approximate amount: CNY 500.");
    await page.getByRole("button", { name: "Save revision", exact: true }).click();
    await page.getByRole("button", { name: "Confirm event", exact: true }).click();
    await expect(page.getByText("Revision 3", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Backfill", exact: true }).click();
    await page.getByRole("button", { name: "Choose JSON ZIP", exact: true }).click();
    await expect(page.locator(".import-panel .run-list article")).toHaveCount(2);
    const repeatedImport = page.locator(".import-panel .run-list article").first();
    await expect(repeatedImport.locator(".status")).toHaveText("succeeded", { timeout: 15_000 });
    await expect(repeatedImport).toContainText("+0");
    await expect(repeatedImport).toContainText("=1");
    await expect(page.locator(".candidate-inbox").getByText("No candidates are waiting for review.", { exact: true })).toBeVisible();
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
