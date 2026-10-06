import { settingsGroup } from "./ui-helpers";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { _electron as electron, expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { ZipFile } from "yazl";

// Only descend into the synthetic paths created by this test, never aliases or user profiles.
async function assertNoMarkers(root: string, markers: Buffer[]): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    expect(entry.isSymbolicLink()).toBe(false);
    if (entry.isDirectory()) await assertNoMarkers(path, markers);
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      for (const marker of markers) expect(bytes.includes(marker)).toBe(false);
    }
  }
}

async function syntheticFileHashes(root: string): Promise<string[]> {
  const hashes: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    expect(entry.isSymbolicLink()).toBe(false);
    const path = join(root, entry.name);
    if (entry.isDirectory()) hashes.push(...await syntheticFileHashes(path));
    else if (entry.isFile()) hashes.push(createHash("sha256").update(await readFile(path)).digest("hex"));
  }
  return hashes;
}

test("cleans abandoned ZIP media after an abrupt process exit without inventing a batch receipt", async () => {
  test.skip(process.platform === "win32", "Requires POSIX SIGKILL of this test's own Electron child");
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-crash-recovery-e2e-"));
  const workspace = join(root, "workspace"), userData = join(root, "user-data");
  const archive = join(root, "synthetic-crash.zip"), neighbor = join(userData, "synthetic-user-kept.txt");
  const skippedId = `SKIPPED-${randomUUID()}`, interruptedId = `INTERRUPTED-${randomUUID()}`;
  const skippedText = `午饭后散步，下午工作顺利 ${randomUUID()}`;
  const interruptedText = `E2E导入进度暂停，午饭后散步，下午工作顺利 ${randomUUID()}`;
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=", "base64");
  const imageHash = createHash("sha256").update(image).digest("hex");
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ entries: [
    { uuid: "KEPT-SYNTHETIC-RECORD", creationDate: "2026-09-20T10:00:00Z", text: "合成崩溃前已保存的奖金记录" },
    { uuid: skippedId, creationDate: "2026-09-20T10:00:00Z", text: skippedText,
      photos: [{ identifier: "SYNTHETIC-IMAGE", type: "png" }] },
    { uuid: interruptedId, creationDate: "2026-09-20T10:00:00Z", text: interruptedText,
      photos: [{ identifier: "SYNTHETIC-IMAGE", type: "png" }] }
  ] })), "Journal.json");
  zip.addBuffer(image, "photos/SYNTHETIC-IMAGE.png");
  zip.end(); await pipeline(zip.outputStream as Readable, createWriteStream(archive));
  const archiveHash = createHash("sha256").update(await readFile(archive)).digest("hex");
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((item): item is [string, string] => item[1] !== undefined &&
      item[0] !== "ELECTRON_RUN_AS_NODE" && item[0] !== "ELECTRON_RENDERER_URL"));
  const launch = () => electron.launch({
    args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
    env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NO_NETWORK: "1" }
  });
  const transientRoot = join(userData, ".grudge-vault-redesign-transient-v1");
  let application: Awaited<ReturnType<typeof launch>> | undefined;
  const counts = () => {
    const database = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
    try {
      return ["redesign_records", "redesign_sources", "redesign_pending_reviews", "assets", "redesign_reports"]
        .map((table) => database.prepare(`SELECT count(*) FROM ${table}`).pluck().get());
    } finally { database.close(); }
  };
  try {
    application = await launch();
    let page = await application.firstWindow();
    await expect(page.locator(".new-record-button")).toBeVisible();
    // Keep this fixture open even if the host was already OS-idle when the test started.
    expect(await page.evaluate(() => window.grudgeVault.workspace.updateSecuritySettings({
      autoLockMinutes: 0, integrityScanIntervalDays: 30
    }))).toMatchObject({ ok: true });
    await writeFile(neighbor, "Synthetic neighboring file must survive startup cleanup.");
    expect(await page.evaluate(() => window.grudgeVault.llm.connect({ provider: "bailian", region: "cn-beijing",
      model: "qwen3.8-omni-flash", apiKey: "synthetic-crash-recovery-key" }))).toMatchObject({ ok: true });
    await application.evaluate(({ dialog }, selectedZip) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedZip] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      (globalThis as typeof globalThis & { __gvE2eZipProgressHold?: boolean }).__gvE2eZipProgressHold = true;
    }, archive);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsGroup(page, "导入");
    await page.getByRole("button", { name: "选择 Day One 导出 ZIP", exact: true }).click();
    await expect.poll(() => application!.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eZipProgressStarted?: boolean
    }).__gvE2eZipProgressStarted)).toBe(true);
    expect(await page.evaluate(() => window.grudgeVault.intake.dayOneImportProgress())).toMatchObject({
      ok: true, data: { phase: "screening", totalEntries: 3, included: 1, skipped: 1, review: 0, failed: 0 }
    });
    // Wait for the independent saved-record task, not a sleep; the interrupted entry remains in flight.
    await expect.poll(counts).toEqual([1, 1, 0, 0, 1]);
    await expect.poll(() => page.evaluate(async () => {
      const result = await window.grudgeVault.jobs.list();
      return result.ok ? result.data.filter(({ type }) => type === "record.analyze").map(({ state }) => state) : [];
    })).toEqual(["succeeded"]);
    const abandoned = (await readdir(transientRoot)).filter((name) => name.startsWith("screened-zip-"));
    expect(abandoned).toHaveLength(1);
    expect(await syntheticFileHashes(join(transientRoot, abandoned[0]!))).toContain(imageHash);
    expect(await page.evaluate(() => window.grudgeVault.intake.lastDayOneImportReceipt())).toEqual({ ok: true, data: null });
    expect(await application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eUnexpectedNetwork?: number
    }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);

    // Terminate only the child handle returned by this launch, never discover or kill installed apps.
    const child = application.process();
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
    const exited = new Promise<NodeJS.Signals | null>((resolveExit) => child.once("exit", (_code, signal) => resolveExit(signal)));
    expect(child.kill("SIGKILL")).toBe(true);
    expect(await exited).toBe("SIGKILL");
    application = undefined;
    // This proves shutdown cleanup did not run; the next process must perform recovery.
    expect((await readdir(transientRoot)).filter((name) => name.startsWith("screened-zip-"))).toEqual(abandoned);
    expect(counts()).toEqual([1, 1, 0, 0, 1]);

    application = await launch(); page = await application.firstWindow();
    await expect(page.locator(".record-card")).toHaveCount(1);
    await expect.poll(() => readdir(transientRoot)).toEqual([".owned-by-grudge-vault"]);
    expect(await readFile(neighbor, "utf8")).toBe("Synthetic neighboring file must survive startup cleanup.");
    expect(await page.evaluate(() => window.grudgeVault.intake.dayOneImportProgress())).toEqual({ ok: true, data: null });
    expect(await page.evaluate(() => window.grudgeVault.intake.lastDayOneImportReceipt())).toEqual({ ok: true, data: null });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsGroup(page, "导入");
    await expect(page.getByRole("button", { name: "选择 Day One 导出 ZIP", exact: true })).toBeEnabled();
    await expect(page.getByText("尚无已保存的批次摘要；旧版导入不会自动补记。这里不代表 Day One 全部历史已检查。", { exact: true })).toBeVisible();
    expect(counts()).toEqual([1, 1, 0, 0, 1]);
    expect(createHash("sha256").update(await readFile(archive)).digest("hex")).toBe(archiveHash);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eInferenceCalls?: number
    }).__gvE2eInferenceCalls ?? 0)).toBe(0);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eUnexpectedNetwork?: number
    }).__gvE2eUnexpectedNetwork ?? 0)).toBe(0);
    const markers = [skippedId, interruptedId, skippedText, interruptedText].map((text) => Buffer.from(text));
    markers.push(image);
    await assertNoMarkers(workspace, markers); await assertNoMarkers(userData, markers);
  } finally {
    // The root is exactly the random synthetic directory created above; no real workspace is removed.
    await application?.close(); await rm(root, { recursive: true, force: true });
  }
});
