import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("completes the Phase 4 memory, Private Agent, and injected Enhanced Agent loop", async () => {
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
    await page.getByRole("button", { name: "Quick record", exact: true }).click();
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
    await page.locator(".filters").getByRole("button", { name: "Search", exact: true }).click();
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
    await page.getByLabel("Interests").fill("Attribution|Preserve accurate authorship.");
    await page.getByPlaceholder("Person name").fill("Alexander");
    await page.getByPlaceholder("Person name").locator("..").getByRole("button").click();
    await page.getByRole("button", { name: "Save revision", exact: true }).click();
    await page.getByRole("button", { name: "Confirm event", exact: true }).click();
    await expect(page.getByText("Revision 3", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "People", exact: true }).click();
    await page.locator(".people-index .event-list").getByText("Alexander", { exact: true }).click();
    await page.getByPlaceholder("Add an alias").fill("Alex");
    await page.getByRole("button", { name: "Add alias", exact: true }).click();
    const mergeSuggestion = page.locator(".suggestion-card").filter({ hasText: "Alex" }).first();
    await expect(mergeSuggestion).toBeVisible();
    await mergeSuggestion.getByRole("button", { name: "Confirm merge", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Identity members", exact: true })).toBeVisible();
    await expect(page.locator(".phase-three-panel").getByText("On 2026-08-20 Alex omitted my name from the report", { exact: true })).toBeVisible();
    await expect(page.locator(".phase-three-panel .memory-results strong").filter({ hasText: importedTitle })).toBeVisible();

    await page.getByRole("button", { name: "Events", exact: true }).click();
    await page.locator(".event-list-panel").getByText("On 2026-08-20 Alex omitted my name from the report", { exact: true }).click();
    const relatedSection = page.locator(".subsection").filter({ has: page.getByRole("heading", { name: "Related events", exact: true }) });
    await relatedSection.getByRole("button", { name: "Detect again", exact: true }).click();
    const similarRelation = relatedSection.locator("article").filter({ hasText: "similar" }).first();
    await expect(similarRelation).toBeVisible();
    await similarRelation.getByRole("button", { name: "Confirm event", exact: true }).click();
    const topicRelation = relatedSection.locator("article").filter({ hasText: "same_topic" }).first();
    if (await topicRelation.count()) await topicRelation.getByRole("button", { name: "Reject", exact: true }).click();

    await page.getByRole("navigation").getByRole("button", { name: "Search", exact: true }).click();
    await page.getByLabel("Unified search").fill("Synthetic journal");
    await page.locator(".phase-three-panel").getByRole("button", { name: "Search", exact: true }).click();
    const journalHit = page.locator(".memory-results article").filter({ hasText: "Journal entry" }).first();
    await expect(journalHit).toContainText(importedTitle);
    await journalHit.getByRole("button", { name: "Open source", exact: true }).click();
    await expect(page.locator(".source-modal")).toContainText(importedTitle);
    await page.locator(".source-modal").getByRole("button", { name: "×", exact: true }).click();

    await page.getByRole("button", { name: "Timeline", exact: true }).click();
    await page.locator(".phase-three-panel").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator(".timeline-groups").getByText("On 2026-08-20 Alex omitted my name from the report", { exact: true })).toBeVisible();
    await expect(page.locator(".timeline-groups strong").filter({ hasText: importedTitle })).toBeVisible();

    await page.getByRole("button", { name: "Review", exact: true }).click();
    await page.getByLabel("From").fill("2025-01-01");
    await page.getByLabel("To").fill("2026-12-31");
    await page.getByRole("button", { name: "Generate review", exact: true }).click();
    await expect(page.locator(".pattern-list article").first()).toBeVisible();
    await expect(page.locator(".pattern-list")).toContainText("Supporting events");

    await page.getByRole("button", { name: "Backfill", exact: true }).click();
    await page.getByRole("button", { name: "Choose JSON ZIP", exact: true }).click();
    await expect(page.locator(".import-panel .run-list article")).toHaveCount(2);
    const repeatedImport = page.locator(".import-panel .run-list article").first();
    await expect(repeatedImport.locator(".status")).toHaveText("succeeded", { timeout: 15_000 });
    await expect(repeatedImport).toContainText("+0");
    await expect(repeatedImport).toContainText("=1");
    await expect(page.locator(".candidate-inbox").getByText("No candidates are waiting for review.", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByText("Work notes", { exact: true }).click();
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await page.getByLabel("Describe what just happened…").fill("What should I do about report attribution risks and options?");
    await page.getByRole("button", { name: "Ask Agent", exact: true }).click();
    const privateTurn = page.locator(".agent-turn").last();
    await expect(privateTurn).toContainText("strategy");
    await expect(privateTurn).toContainText("Action options");
    await expect(privateTurn).toContainText("Local citations");
    await privateTurn.getByRole("button", { name: "On 2026-08-20 Alex omitted my name from the report", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Event details", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await page.getByLabel("Describe what just happened…").fill("Record: On 2026-08-24 I documented the attribution history.");
    await page.getByRole("button", { name: "Ask Agent", exact: true }).click();
    const writeCard = page.locator(".agent-action.pending").last();
    await expect(writeCard).toBeVisible();
    await writeCard.getByRole("button", { name: "Approve write", exact: true }).click();
    await expect(page.locator(".agent-action.approved").last()).toBeVisible();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Execution mode").selectOption("enhanced");
    await page.getByLabel("Model base URL").fill("https://model.example/v1");
    await page.getByLabel("Model name").fill("e2e-fake");
    await page.getByLabel("API key").fill("e2e-secret");
    await page.getByRole("button", { name: "Save Agent settings", exact: true }).click();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await page.getByLabel("Describe what just happened…").fill("E2E_ENHANCED_TOOL: What should I do about attribution risk?");
    await page.getByRole("button", { name: "Ask Agent", exact: true }).click();
    const consent = page.locator(".consent-modal");
    await expect(consent).toContainText("conversation_text");
    await expect(consent).toContainText("event_fields");
    await consent.getByRole("button", { name: "Allow and continue", exact: true }).click();
    await expect(page.getByText("Injected Enhanced answer with locally grounded citations.", { exact: true })).toBeVisible();
    const enhancedTurn = page.locator(".agent-turn").last();
    await enhancedTurn.getByRole("button", { name: "Work notes", exact: true }).first().click();
    await expect(page.locator(".source-modal")).toContainText("On 2026-08-20 Alex omitted my name from the report.");
    await page.locator(".source-modal").getByRole("button", { name: "×", exact: true }).click();
    await application.close();

    application = await launch();
    page = await application.firstWindow();
    await expect(page.getByText("Automated Vault", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Events", exact: true }).click();
    await expect(page.getByText("On 2026-08-20 Alex omitted my name from the report", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Vault", exact: true }).click();
    await expect(page.getByText(expectedHash)).toBeVisible();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByText("Injected Enhanced answer with locally grounded citations.", { exact: true })).toBeVisible();
    await application.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
