import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("stores an encrypted asset and restores it after restart", async () => {
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
    await expect(page.getByRole("heading", { name: "Automated Vault" })).toBeVisible();
    await page.locator("#asset-file-input").setInputFiles(fixture);
    await expect(page.getByText(expectedHash)).toBeVisible();
    await expect(page.getByText("verified", { exact: true }).first()).toBeVisible();
    await application.close();

    application = await launch();
    page = await application.firstWindow();
    await expect(page.getByRole("heading", { name: "Automated Vault" })).toBeVisible();
    await expect(page.getByText("phase-zero-demo.txt")).toBeVisible();
    await expect(page.getByText(expectedHash)).toBeVisible();
    await application.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
