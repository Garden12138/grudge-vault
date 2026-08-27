import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("completes the simplified record, memory, review, materials, data, security, and assistant loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-e2e-"));
  const workspace = join(root, "workspace");
  const userData = join(root, "user-data");
  const fixture = resolve("fixtures/assets/phase-zero-demo.txt");
  const dayOneFixture = resolve("fixtures/dayone/synthetic-minimal.zip");
  const mediaFixture = join(root, "phase-six-demo.png");
  const importFolder = join(root, "dayone-import-folder");
  const current = new Date();
  const reviewMonthStart = new Date(current.getFullYear(), current.getMonth() - 1, 1);
  const reviewMonthEnd = new Date(current.getFullYear(), current.getMonth(), 0);
  const localDate = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  const automaticReviewDate = localDate(new Date(reviewMonthStart.getFullYear(), reviewMonthStart.getMonth(), 15));
  const automaticReviewRange = `${localDate(reviewMonthStart)} — ${localDate(reviewMonthEnd)}`;
  await mkdir(importFolder);
  await copyFile(dayOneFixture, join(importFolder, "incremental-dayone.zip"));
  await writeFile(mediaFixture, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"
  ));
  const expectedHash = createHash("sha256").update(await readFile(fixture)).digest("hex");
  const entry = resolve("apps/desktop/out-e2e/main/main.js");
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );

  const launch = (disableScheduler = false) => electron.launch({
    args: [entry, `--user-data-dir=${userData}`],
    env: { ...inheritedEnvironment, GRUDGE_VAULT_E2E_WORKSPACE: workspace,
      ...(disableScheduler ? { GRUDGE_VAULT_E2E_DISABLE_SCHEDULER: "1" } : {}) }
  });

  try {
    let application = await launch(true);
    let page = await application.firstWindow();
    await page.evaluate(() => window.localStorage.setItem("grudge-vault.language", "en"));
    await page.reload();
    await expect(page.getByText("Automated Vault", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Materials", exact: true }).click();
    await page.locator("#asset-file-input").setInputFiles(fixture);
    await expect(page.getByText(expectedHash)).toBeHidden();
    await expect(page.getByText("phase-zero-demo.txt", { exact: true })).toBeVisible();
    await page.locator("#asset-file-input").setInputFiles(mediaFixture);
    await expect(page.getByText("phase-six-demo.png", { exact: true })).toBeVisible();
    await page.getByLabel("Search memory").fill("E2E OCR attribution");
    await page.locator(".global-search").getByRole("button", { name: "Search", exact: true }).click();
    const ocrHit = page.locator(".memory-results article").filter({ hasText: "OCR" }).first();
    await expect(ocrHit).toContainText("E2E OCR attribution evidence", { timeout: 15_000 });
    await ocrHit.getByRole("button", { name: "Open source", exact: true }).click();
    await expect(page.locator(".source-modal")).toContainText("E2E OCR attribution evidence");
    await page.locator(".source-modal").getByRole("button", { name: "×", exact: true }).click();

    await page.getByRole("button", { name: "Record", exact: true }).click();
    await page.getByRole("button", { name: /Daily notes/ }).click();
    await page.getByLabel("Topic name").fill("Work notes");
    await page.getByLabel("Topic name").press("Enter");
    await expect(page.getByText("Work notes", { exact: true })).toBeVisible();

    await page.getByLabel("Write down what happened…").fill(`On ${automaticReviewDate} I saved an automatic review seed.`);
    await page.locator(".record-submit").click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add time, people, or materials" }).click();
    await expect(page.getByRole("heading", { name: "Record details" })).toBeVisible();
    await page.getByRole("button", { name: "Record", exact: true }).click();
    await page.getByLabel("Write down what happened…").fill("The unresolved attribution issue still needs a date.");
    await page.locator(".record-submit").click();
    await page.getByRole("button", { name: "Add time, people, or materials" }).click();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    const priority = page.locator(".review-controls select[aria-label='Priority']").first();
    await expect(priority).toBeVisible();
    await priority.selectOption("important");
    await expect(priority).toHaveValue("important");

    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await expect(page.getByText("Automated Vault", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    const monthlyReminder = page.locator(".review-controls .mini-list article").filter({ hasText: "Monthly review" }).first();
    await expect(monthlyReminder).toBeVisible({ timeout: 15_000 });
    await monthlyReminder.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.locator(".phase-three-panel").getByRole("heading", { name: automaticReviewRange, exact: true })).toBeVisible();
    const clarificationReminder = page.locator(".review-controls .mini-list article").filter({ hasText: "Details to add" }).first();
    await expect(clarificationReminder).toBeVisible();
    await clarificationReminder.getByRole("button", { name: "Open", exact: true }).click();

    await page.getByRole("button", { name: "Record", exact: true }).click();
    await page.getByLabel("Write down what happened…").fill("On 2026-08-20 Alex omitted my name from the report.");
    await page.locator(".record-submit").click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add time, people, or materials" }).click();

    await expect(page.getByRole("heading", { name: "Record details" })).toBeVisible();
    await page.locator("#event-asset-file-input").setInputFiles(fixture);
    await expect(page.getByText("phase-zero-demo.txt", { exact: true }).first()).toBeVisible();
    await page.getByPlaceholder("Person name").fill("Alex");
    await page.getByPlaceholder("Person name").locator("..").getByRole("button").click();
    await page.getByRole("checkbox", { name: "Alex", exact: true }).check();
    await page.getByText("More details", { exact: true }).click();
    const factsEditor = page.locator(".structured-editor").filter({ has: page.getByRole("heading", { name: "Facts", exact: true }) });
    await factsEditor.getByRole("button", { name: "Add", exact: true }).click();
    await factsEditor.getByLabel("Fact text").fill("The report omitted my name.");
    const interestsEditor = page.locator(".structured-editor").filter({ has: page.getByRole("heading", { name: "What matters to me", exact: true }) });
    await interestsEditor.getByRole("button", { name: "Add", exact: true }).click();
    await interestsEditor.getByPlaceholder("Interest").fill("Attribution");
    await interestsEditor.getByPlaceholder("Optional note").fill("Preserve accurate authorship.");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await page.getByText("Filter records", { exact: true }).click();
    await page.getByPlaceholder("Keywords, facts, emotions, or interests").fill("attribution");
    await page.locator(".filters select").nth(1).selectOption({ label: "Alex" });
    await page.locator(".filters").getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByText("On 2026-08-20 Alex omitted my name from the report", { exact: true }).first()).toBeVisible();

    await application.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [filePath] })
      });
    }, importFolder);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Data", exact: true }).click();
    await page.getByText("Automatic import settings", { exact: true }).click();
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    const latestImport = page.locator(".import-panel .run-list article").first();
    await expect(latestImport.locator(".status")).toHaveText("Completed", { timeout: 15_000 });
    await expect(latestImport).toContainText("+1");
    await page.getByText("Advanced organization options", { exact: true }).click();
    await page.getByRole("button", { name: "Start backfill", exact: true }).click();
    const importedTitle = "Synthetic journal entry for future importer development.";
    await expect(page.getByText(importedTitle, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await page.getByText(importedTitle, { exact: true }).first().click();
    await page.getByRole("button", { name: "Open record", exact: true }).click();
    await page.getByPlaceholder("Person name").fill("Alexander");
    await page.getByPlaceholder("Person name").locator("..").getByRole("button").click();
    await page.getByText("More details", { exact: true }).click();
    const importedFacts = page.locator(".structured-editor").filter({ has: page.getByRole("heading", { name: "Facts", exact: true }) });
    await importedFacts.getByRole("button", { name: "Add", exact: true }).click();
    await importedFacts.getByLabel("Fact text").fill("Approximate amount: CNY 500.");
    await importedFacts.getByLabel("Fact type").selectOption("fact.unknown");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Add to memory", exact: true }).click();

    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await page.getByRole("button", { name: "People", exact: true }).click();
    await page.locator(".people-index .event-list").getByText("Alexander", { exact: true }).click();
    await page.getByPlaceholder("Add an alias").fill("Alex");
    await page.getByRole("button", { name: "Add alias", exact: true }).click();
    const mergeSuggestion = page.locator(".suggestion-card").filter({ hasText: "Alex" }).first();
    await expect(mergeSuggestion).toBeVisible();
    await mergeSuggestion.getByRole("button", { name: "Confirm merge", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Linked names", exact: true })).toBeVisible();
    await expect(page.locator(".phase-three-panel").getByText("On 2026-08-20 Alex omitted my name from the report", { exact: true })).toBeVisible();
    await expect(page.locator(".phase-three-panel .memory-results strong").filter({ hasText: importedTitle })).toBeVisible();

    await page.getByRole("button", { name: "All records", exact: true }).click();
    await page.locator(".event-list-panel").getByText("On 2026-08-20 Alex omitted my name from the report", { exact: true }).click();
    await page.getByText("More details", { exact: true }).click();
    const relatedSection = page.locator(".subsection").filter({ has: page.getByRole("heading", { name: "Related events", exact: true }) });
    await relatedSection.getByRole("button", { name: "Detect again", exact: true }).click();
    const similarRelation = relatedSection.locator("article").filter({ hasText: "Similar" }).first();
    await expect(similarRelation).toBeVisible();
    await similarRelation.getByRole("button", { name: "Add to memory", exact: true }).click();
    const topicRelation = relatedSection.locator("article").filter({ hasText: "same_topic" }).first();
    if (await topicRelation.count()) await topicRelation.getByRole("button", { name: "Reject", exact: true }).click();

    await page.getByLabel("Search memory").fill("Synthetic journal");
    await page.locator(".global-search").getByRole("button", { name: "Search", exact: true }).click();
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

    await page.getByRole("button", { name: "Materials", exact: true }).click();
    await page.getByRole("button", { name: "Material details", exact: true }).click();
    await expect(page.locator(".evidence-view").getByText("phase-zero-demo.txt", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Check materials", exact: true }).click();
    await expect(page.locator(".evidence-view").getByText("phase-zero-demo.txt", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "Material packages", exact: true }).click();
    const casesView = page.locator(".cases-view");
    await casesView.getByLabel("Title").fill("Attribution Evidence Case");
    await casesView.getByLabel("Region (optional)").fill("CN-SH");
    await casesView.getByRole("checkbox", { name: "On 2026-08-20 Alex omitted my name from the report", exact: true }).check();
    await casesView.getByRole("checkbox", { name: "phase-zero-demo.txt", exact: true }).check();
    await casesView.getByRole("button", { name: "Create material package", exact: true }).click();
    await expect(casesView.getByText("Attribution Evidence Case", { exact: true }).first()).toBeVisible();
    await casesView.getByPlaceholder("Amount label").fill("Attribution claim");
    await casesView.getByPlaceholder("0.00").fill("500.00");
    await casesView.locator(".compact-form").getByRole("button", { name: "Add", exact: true }).click();
    await expect(casesView.getByText("CNY 500.00", { exact: false })).toBeVisible();
    await casesView.getByPlaceholder("Missing material").fill("Delivery receipt");
    await casesView.getByRole("button", { name: "Add gap", exact: true }).click();
    await expect(casesView.getByText("Delivery receipt", { exact: true })).toBeVisible();
    await casesView.getByRole("button", { name: "Generate verification questions", exact: true }).click();
    await expect(casesView.getByText("Needs external verification", { exact: true })).toBeVisible();
    await casesView.getByRole("button", { name: "Create explicit preview", exact: true }).click();
    await expect(casesView.getByText("Export preview", { exact: false })).toBeVisible();
    await expect(casesView.locator(".warning-copy").first()).toContainText("Original bytes are unchanged");
    const binderPath = join(root, "case-binder");
    await application.evaluate(({ dialog }, destination) => {
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true, value: async () => ({ canceled: false, filePath: destination })
      });
    }, binderPath);
    await casesView.getByRole("button", { name: "Choose directory and export", exact: true }).click();
    await expect.poll(async () => readFile(join(binderPath, "manifest.json"), "utf8").then((value) => value.length, () => 0),
      { timeout: 15_000 }).toBeGreaterThan(100);
    const binderSums = (await readFile(join(binderPath, "sha256sums.txt"), "utf8")).trim().split("\n");
    for (const line of binderSums) {
      const [expected, path] = line.split("  ", 2) as [string, string];
      expect(createHash("sha256").update(await readFile(join(binderPath, path))).digest("hex")).toBe(expected);
    }

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Data", exact: true }).click();
    await application.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true, value: async () => ({ canceled: false, filePaths: [filePath] })
      });
    }, dayOneFixture);
    await page.getByRole("button", { name: "Choose Day One export", exact: true }).click();
    await expect(page.locator(".import-panel .run-list article")).toHaveCount(2);
    const repeatedImport = page.locator(".import-panel .run-list article").first();
    await expect(repeatedImport.locator(".status")).toHaveText("Completed", { timeout: 15_000 });
    await expect(repeatedImport).toContainText("+0");
    await expect(repeatedImport).toContainText("=1");
    await expect(page.locator(".candidate-inbox").getByText("No records are waiting to be organized.", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Record", exact: true }).click();
    await page.getByText("Other options", { exact: true }).click();
    await page.getByRole("button", { name: "Ask assistant", exact: true }).first().click();
    await page.getByLabel("Write down what happened…").fill("What should I do about report attribution risks and options?");
    await page.locator(".record-submit").click();
    await page.getByText(/View topic history/).click();
    const privateTurn = page.locator(".agent-turn").last();
    await expect(privateTurn).toContainText("Action options");
    await expect(privateTurn).toContainText("Related records");
    await privateTurn.getByRole("button", { name: "On 2026-08-20 Alex omitted my name from the report", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Record details", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Record", exact: true }).click();
    await page.getByLabel("Write down what happened…").fill("Record: On 2026-08-24 I documented the attribution history.");
    await page.locator(".record-submit").click();
    await page.getByText(/View topic history/).click();
    const writeCard = page.locator(".agent-action.pending").last();
    await expect(writeCard).toBeVisible();
    await writeCard.getByRole("button", { name: "Approve save", exact: true }).click();
    await expect(page.locator(".agent-action.approved").last()).toBeVisible();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await page.getByLabel("Execution mode").selectOption("enhanced");
    await page.getByLabel("Model base URL").fill("https://model.example/v1");
    await page.getByLabel("Model name").fill("e2e-fake");
    await page.getByLabel("API key").fill("e2e-secret");
    await page.getByRole("button", { name: "Save assistant settings", exact: true }).click();
    await page.getByRole("button", { name: "Record", exact: true }).click();
    await page.getByLabel("Write down what happened…").fill("attribution");
    await page.locator(".record-submit").click();
    const consent = page.locator(".consent-modal");
    await expect(consent).toContainText("This conversation");
    await expect(consent).toContainText("Related records");
    await expect(consent).toContainText("Text from materials");
    await consent.getByRole("button", { name: "Allow and continue", exact: true }).click();
    await page.getByText(/View topic history/).click();
    await expect(page.getByText("Injected Enhanced answer with locally grounded citations.", { exact: true })).toBeVisible();
    const enhancedTurn = page.locator(".agent-turn").last();
    await enhancedTurn.getByRole("button", { name: "phase-six-demo.png · Material text", exact: true }).click();
    await expect(page.locator(".source-modal")).toContainText("E2E OCR attribution evidence");
    await page.locator(".source-modal").getByRole("button", { name: "×", exact: true }).click();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Lock now", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Journal locked", exact: true })).toBeVisible();
    await expect(page.getByText(workspace, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Unlock with OS key store", exact: true }).click();
    await expect(page.getByText("Automated Vault", { exact: true })).toBeVisible();

    const backupPath = join(root, "phase5.gvbackup");
    const restoredPath = join(root, "phase5-restored");
    await mkdir(restoredPath);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Data", exact: true }).click();
    await application.evaluate(({ dialog }, destination) => {
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true, value: async () => ({ canceled: false, filePath: destination })
      });
    }, backupPath);
    await page.getByRole("button", { name: "Create encrypted snapshot", exact: true }).click();
    await expect.poll(async () => readFile(join(backupPath, "manifest.json"), "utf8").then((value) => value.length, () => 0),
      { timeout: 15_000 }).toBeGreaterThan(100);
    await application.evaluate(({ dialog }, paths) => {
      let call = 0;
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [call++ === 0 ? paths.backup : paths.restore] })
      });
    }, { backup: backupPath, restore: restoredPath });
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Restore snapshot", exact: true }).click();
    await expect(page.getByText("Automated Vault", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Materials", exact: true }).click();
    await page.getByRole("button", { name: "Material packages", exact: true }).click();
    await expect(page.getByText("Attribution Evidence Case", { exact: true }).first()).toBeVisible();
    await application.close();

    application = await launch();
    page = await application.firstWindow();
    await expect(page.getByText("Automated Vault", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await expect(page.getByText("On 2026-08-20 Alex omitted my name from the report", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Materials", exact: true }).click();
    await expect(page.getByText("phase-zero-demo.txt", { exact: true })).toBeVisible();
    await expect(page.getByText(expectedHash)).toBeHidden();
    await page.getByRole("button", { name: "Record", exact: true }).click();
    await page.getByText(/View topic history/).click();
    await expect(page.getByText("Injected Enhanced answer with locally grounded citations.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "简体中文", exact: true }).click();
    await expect(page.getByLabel("搜索记忆")).toBeVisible();
    for (const label of ["记录", "记忆", "回顾", "材料", "设置"]) {
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect(page.locator("body")).not.toContainText(/FTS5|Embedding|Projection|Revision|GVOB|Epoch|Harness Agent|OCR|ASR/);
    }
    await application.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
