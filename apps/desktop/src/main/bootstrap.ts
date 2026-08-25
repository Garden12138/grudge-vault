import { join } from "node:path";
import { app, BrowserWindow, Notification, powerMonitor, session } from "electron";
import { z } from "zod";
import { GrudgeVaultApplication, JobRunner, type KeyProtectorPort, type MediaPipelinePort } from "@grudge-vault/application";
import { AgentHarness, type AgentModelAdapterPort } from "@grudge-vault/agent-harness";
import { DayOneZipImporter } from "@grudge-vault/importer-dayone";
import { LocalMediaPipeline } from "@grudge-vault/media-pipeline";
import { AppError } from "@grudge-vault/shared";
import { registerIpcHandlers } from "./ipc";
import { ElectronCaseSummaryPdfRenderer } from "./case-summary-pdf";
import { SafeStorageKeyProtector } from "./key-protector";
import { LocalWorkspaceManager } from "./workspace-manager";
import { LocalIntelligenceStateStore } from "./local-intelligence-state";
import { ImportFolderMonitor } from "./import-folder-monitor";
import { ContinuousMemoryScheduler } from "./continuous-memory-scheduler";

interface BootstrapOptions {
  keyProtector?: KeyProtectorPort;
  agentModelAdapter?: AgentModelAdapterPort;
  mediaPipeline?: MediaPipelinePort;
  initialWorkspacePath?: string;
  initialWorkspaceName?: string;
  continuousScheduler?: boolean;
}

const verifyPayloadSchema = z.object({ assetId: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const importPayloadSchema = z.object({ importRunId: z.string().uuid() });
const backfillPayloadSchema = z.object({ backfillRunId: z.string().uuid() });
const embeddingPayloadSchema = z.object({ generationId: z.string().uuid() });
const integrityPayloadSchema = z.object({ scanId: z.string().uuid() });
const cryptoMigrationPayloadSchema = z.object({ targetKeyId: z.string().uuid() });
const mediaPayloadSchema = z.object({
  assetId: z.string().uuid(), kind: z.enum(["ocr", "transcript"]), inputHash: z.string().regex(/^[a-f0-9]{64}$/)
});

export async function bootstrap(options: BootstrapOptions = {}): Promise<void> {
  await app.whenReady();
  const workspaces = new LocalWorkspaceManager(
    options.keyProtector ?? new SafeStorageKeyProtector(),
    join(app.getPath("userData"), "state.json")
  );
  const intelligenceState = new LocalIntelligenceStateStore(join(app.getPath("userData"), "local-intelligence.json"));
  await intelligenceState.load();
  const localMediaPipeline = options.mediaPipeline ? undefined : new LocalMediaPipeline(
    intelligenceState.getMedia(), (value) => intelligenceState.setMedia(value)
  );
  const mediaPipeline = options.mediaPipeline ?? localMediaPipeline;
  const application = new GrudgeVaultApplication(
    workspaces,
    undefined,
    new DayOneZipImporter(),
    undefined,
    { pdf: new ElectronCaseSummaryPdfRenderer() },
    mediaPipeline
  );
  const agent = new AgentHarness(application, {
    ...(options.agentModelAdapter ? { modelAdapter: options.agentModelAdapter } : {})
  });

  if (options.initialWorkspacePath) {
    try {
      await workspaces.open(options.initialWorkspacePath);
    } catch {
      await workspaces.create(options.initialWorkspacePath, options.initialWorkspaceName ?? "E2E Workspace");
    }
  } else {
    await workspaces.openRecent();
  }

  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    backgroundColor: "#f4efe6",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  let runner: JobRunner | undefined;
  const importFolder = new ImportFolderMonitor(application, workspaces, intelligenceState, () => runner);
  const scheduler = new ContinuousMemoryScheduler(application, (reminder) => {
    if (!window.isDestroyed()) window.webContents.send("reminders:due", reminder.id, false);
    if (!application.getReviewAutomationSettings().systemNotifications || !Notification.isSupported()) return;
    const notification = new Notification({
      title: "Grudge Vault",
      body: reminder.kind === "clarification_digest"
        ? "You have local records that need review."
        : "A local memory review is ready."
    });
    notification.on("click", () => {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      window.webContents.send("reminders:due", reminder.id, true);
    });
    notification.show();
  });
  const notifyJobsChanged = () => {
    if (!window.isDestroyed()) window.webContents.send("jobs:changed");
  };
  const restartRunner = () => {
    runner?.stop();
    importFolder.stop();
    scheduler.stop();
    const current = workspaces.current();
    if (!current) {
      runner = undefined;
      return;
    }
    runner = new JobRunner(current.jobs, {
      "asset.verify": async (job, context) => {
        const payload = verifyPayloadSchema.parse(job.payload);
        if (context.signal.aborted) throw new Error("Verification interrupted.");
        const asset = current.assets.findById(payload.assetId);
        if (!asset || asset.sha256 !== payload.sha256) {
          throw new AppError("ASSET_NOT_FOUND", "The asset for this verification job no longer exists.");
        }
        const valid = await current.vault.verify(payload.sha256, current.keyRing ?? current.key, context.reportProgress, asset.byteSize);
        if (!valid) {
          current.assets.setIntegrity(asset.id, "corrupt");
          throw new AppError("ASSET_CORRUPT", "The encrypted object failed integrity verification.");
        }
        current.assets.setIntegrity(asset.id, "verified", new Date().toISOString());
      },
      "dayone.import": async (job, context) => {
        await application.runDayOneImport(importPayloadSchema.parse(job.payload).importRunId, context);
      },
      "dayone.backfill": async (job, context) => {
        await application.runBackfill(backfillPayloadSchema.parse(job.payload).backfillRunId, context);
      },
      "search.embedding-rebuild": async (job, context) => {
        await application.runEmbeddingRebuild(embeddingPayloadSchema.parse(job.payload).generationId, context);
      },
      "vault.integrity-scan": async (job, context) => {
        await application.runIntegrityScan(integrityPayloadSchema.parse(job.payload).scanId, context);
      },
      "workspace.crypto-migrate": async (job, context) => {
        await application.runWorkspaceCryptoMigration(cryptoMigrationPayloadSchema.parse(job.payload).targetKeyId, context);
      },
      "media.process": async (job, context) => {
        const payload = mediaPayloadSchema.parse(job.payload);
        await application.runMediaProcessing(payload.assetId, payload.inputHash, context);
      }
    }, { onChanged: notifyJobsChanged });
    application.ensureWorkspaceCryptoMigration();
    runner.start();
    void importFolder.start();
    if (options.continuousScheduler !== false) scheduler.start();

    const scans = application.listIntegrityScans();
    const hasActiveScan = scans.some(({ state }) => state === "queued" || state === "running");
    const lastSuccess = scans.filter(({ state }) => state === "succeeded").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const intervalDays = application.getWorkspaceSecuritySettings().integrityScanIntervalDays;
    if (!hasActiveScan && (!lastSuccess || Date.now() - Date.parse(lastSuccess.updatedAt) >= intervalDays * 86_400_000)) {
      application.startIntegrityScan();
      runner.wake();
    }
  };
  restartRunner();

  let locking = false;
  const lockWorkspace = async () => {
    if (locking || application.getWorkspaceStatus().status !== "open") return application.getWorkspaceStatus();
    locking = true;
    try {
      importFolder.stop();
      scheduler.stop();
      await runner?.stopAndWait();
      runner = undefined;
      const state = await application.lockWorkspace();
      if (!window.isDestroyed()) window.webContents.send("workspace:locked");
      return state;
    } finally {
      locking = false;
    }
  };
  const lockForPowerEvent = () => { void lockWorkspace(); };
  powerMonitor.on("suspend", lockForPowerEvent);
  powerMonitor.on("lock-screen", lockForPowerEvent);
  const idleTimer = setInterval(() => {
    if (application.getWorkspaceStatus().status !== "open") return;
    const minutes = application.getWorkspaceSecuritySettings().autoLockMinutes;
    if (minutes > 0 && powerMonitor.getSystemIdleTime() >= minutes * 60) void lockWorkspace();
  }, 30_000);

  const removeIpcHandlers = registerIpcHandlers({
    window,
    application,
    agent,
    workspaces,
    restartRunner,
    lockWorkspace,
    getRunner: () => runner,
    ...(localMediaPipeline ? { localMediaPipeline } : {}),
    importFolder
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }
  window.once("ready-to-show", () => window.show());

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    clearInterval(idleTimer);
    powerMonitor.removeListener("suspend", lockForPowerEvent);
    powerMonitor.removeListener("lock-screen", lockForPowerEvent);
    importFolder.stop();
    scheduler.stop();
    removeIpcHandlers();
    void (async () => {
      await runner?.stopAndWait();
      runner = undefined;
      await workspaces.close();
    })().finally(() => app.quit());
  });
  app.on("window-all-closed", () => app.quit());
}
