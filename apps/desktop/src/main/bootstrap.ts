import { join } from "node:path";
import { app, BrowserWindow, dialog, powerMonitor, protocol, session } from "electron";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  GrudgeVaultApplication, JobRunner, jobRetryDelayForError, type KeyProtectorPort, type LegalResearchPort, type MediaPipelinePort, type NativeMediaSegmentPort, type RecordEmbeddingPort, type NativeImageConversionPort
} from "@grudge-vault/application";
import {
  AgentHarness, BailianMultimodalEmbeddingAdapter, BailianNativeMediaQueryAdapter,
  BailianOfficialLegalResearchAdapter, type AgentModelAdapterPort
} from "@grudge-vault/agent-harness";
import { DayOneZipImporter } from "@grudge-vault/importer-dayone";
import { AppError } from "@grudge-vault/shared";
import { registerIpcHandlers } from "./ipc";
import { configuredBailianAuxiliary } from "./bailian-auxiliary";
import { ElectronCaseSummaryPdfRenderer } from "./case-summary-pdf";
import { SafeStorageKeyProtector } from "./key-protector";
import { LocalWorkspaceManager } from "./workspace-manager";
import { MacNativeMediaSegmenter } from "./native-media-segments";
import { MacNativeImageConverter } from "./native-image-conversion";
import { MEDIA_PREVIEW_SCHEME, MediaPreviewService, type MediaPreviewOptions } from "./media-preview";
import { nativeMediaPreviewInspector } from "./native-media-preview";

protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_PREVIEW_SCHEME, privileges: { standard: true, secure: true, stream: true } }]);

interface BootstrapOptions {
  keyProtector?: KeyProtectorPort;
  agentModelAdapter?: AgentModelAdapterPort;
  mediaPipeline?: MediaPipelinePort;
  nativeMediaSegments?: NativeMediaSegmentPort;
  nativeImageConversion?: NativeImageConversionPort;
  recordEmbedding?: RecordEmbeddingPort;
  legalResearch?: LegalResearchPort;
  initialWorkspacePath?: string;
  initialWorkspaceName?: string;
  onMediaPreviewRead?: MediaPreviewOptions["onRead"];
  onMediaPreviewAccess?(value: { status: number; origin: "absent" | "file" | "opaque" | "other" }): void;
}

const verifyPayloadSchema = z.object({ assetId: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const integrityPayloadSchema = z.object({ scanId: z.string().uuid() });
const cryptoMigrationPayloadSchema = z.object({ targetKeyId: z.string().uuid() });
const recordAnalysisPayloadSchema = z.object({ recordId: z.string().uuid(), recordRevision: z.number().int().positive() });
const recordSearchIndexPayloadSchema = z.object({ generationId: z.string().uuid() }).strict();

export async function bootstrap(options: BootstrapOptions = {}): Promise<void> {
  await app.whenReady();
  const workspaces = new LocalWorkspaceManager(
    options.keyProtector ?? new SafeStorageKeyProtector(),
    join(app.getPath("userData"), "state.json")
  );
  let startupCleanupError: AppError | undefined;
  try {
    await workspaces.prepareTransientStorage();
  } catch (error) {
    if (error instanceof AppError && error.code === "CLEANUP_FAILED") startupCleanupError = error;
    else throw error;
  }
  let application!: GrudgeVaultApplication;
  const getBailianCredentials = () => {
    return configuredBailianAuxiliary(application.getLlmSettings(), () => application.getLlmCredential("bailian"));
  };
  const getBailianOmniCredentials = () => configuredBailianAuxiliary(
    application.getLlmSettings(), () => application.getLlmCredential("bailian"), "qwen3.8-omni-flash"
  );
  const recordEmbedding = options.recordEmbedding ?? new BailianMultimodalEmbeddingAdapter(getBailianCredentials);
  const nativeMediaSegments = options.nativeMediaSegments ?? (process.platform === "darwin" ? new MacNativeMediaSegmenter({
    executable: app.isPackaged ? join(process.resourcesPath, "bin/grudge-vault-media") : join(__dirname, "../../build/native/grudge-vault-media"),
    createTemporaryDirectory: (prefix) => workspaces.createTransientDirectory(prefix)
  }) : undefined);
  const nativeImageConversion = options.nativeImageConversion ?? (process.platform === "darwin" ? new MacNativeImageConverter({
    executable: app.isPackaged ? join(process.resourcesPath, "bin/grudge-vault-media") : join(__dirname, "../../build/native/grudge-vault-media"),
    createTemporaryDirectory: (prefix) => workspaces.createTransientDirectory(prefix)
  }) : undefined);
  const mediaQueryDescription = new BailianNativeMediaQueryAdapter(
    getBailianOmniCredentials, options.agentModelAdapter, nativeMediaSegments, () => application.beginLlmOperation()
  );
  application = new GrudgeVaultApplication(
    workspaces,
    undefined,
    new DayOneZipImporter(),
    undefined,
    { pdf: new ElectronCaseSummaryPdfRenderer() },
    options.mediaPipeline,
    recordEmbedding,
    mediaQueryDescription,
    nativeImageConversion
  );
  const agent = new AgentHarness(application, {
    legalResearch: options.legalResearch ?? new BailianOfficialLegalResearchAdapter(getBailianOmniCredentials),
    ...(nativeMediaSegments ? { nativeMediaSegments } : {}),
    ...(nativeImageConversion ? { nativeImageConversion } : {}),
    ...(options.agentModelAdapter ? { modelAdapter: options.agentModelAdapter } : {})
  });

  if (options.initialWorkspacePath) {
    try {
      await workspaces.open(options.initialWorkspacePath);
    } catch (error) {
      if (!(error instanceof AppError && error.code === "WORKSPACE_PASSWORD_REQUIRED")) {
        await workspaces.create(options.initialWorkspacePath, options.initialWorkspaceName ?? "E2E Workspace");
      }
    }
  } else {
    try {
      await workspaces.openRecent();
    } catch (error) {
      if (error instanceof AppError && error.code === "CLEANUP_FAILED") startupCleanupError = error;
      else throw error;
    }
  }

  const rendererSession = session.fromPartition(`grudge-vault-main-${randomUUID()}`);
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    backgroundColor: "#f6f7f9",
    webPreferences: {
      session: rendererSession,
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  rendererSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  rendererSession.setPermissionCheckHandler(() => false);
  const mediaPreviews = new MediaPreviewService({
    getSource: (assetId) => application.openMediaSourceForPreview(assetId),
    createTemporaryDirectory: (prefix) => workspaces.createTransientDirectory(prefix),
    isTrustedOrigin: (origin) => {
      if (window.isDestroyed()) return false;
      const current = window.webContents.getURL();
      if (process.env.ELECTRON_RENDERER_URL) return current === new URL(process.env.ELECTRON_RENDERER_URL).href && origin === new URL(current).origin;
      return current === pathToFileURL(join(__dirname, "../renderer/index.html")).href && ["null", "file://"].includes(origin ?? "");
    },
    ...(process.platform === "darwin" ? { inspect: nativeMediaPreviewInspector(app.isPackaged
      ? join(process.resourcesPath, "bin/grudge-vault-media") : join(__dirname, "../../build/native/grudge-vault-media")) } : {}),
    ...(options.onMediaPreviewRead ? { onRead: options.onMediaPreviewRead } : {}),
    onCleanupFailure: () => {
      if (!window.isDestroyed()) void dialog.showMessageBox(window, { type: "error", title: "原件预览清理失败",
        message: "私有预览副本未能安全清理。请检查本机临时存储并重新启动，恢复前不会继续打开预览。" });
    }
  });
  rendererSession.protocol.handle(MEDIA_PREVIEW_SCHEME, async (request) => {
    const response = await mediaPreviews.handle(request);
    const origin = (request as import("./media-preview").MediaPreviewRequest).initiatorOrigin;
    options.onMediaPreviewAccess?.({ status: response.status,
      origin: origin === undefined ? "absent" : origin === "null" ? "opaque" : origin.startsWith("file:") ? "file" : "other" });
    return response;
  });
  window.webContents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
    if (mainFrame) void mediaPreviews.closeAll().catch(() => {});
  });
  window.webContents.on("did-finish-load", () => mediaPreviews.resume());
  window.webContents.on("render-process-gone", () => { void mediaPreviews.closeAll().catch(() => {}); });

  let runner: JobRunner | undefined;
  const notifyJobsChanged = () => {
    if (!window.isDestroyed()) window.webContents.send("jobs:changed");
  };
  const restartRunner = () => {
    runner?.stop();
    const current = workspaces.current();
    if (!current) {
      runner = undefined;
      return;
    }
    mediaPreviews.resume();
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
      "vault.integrity-scan": async (job, context) => {
        await application.runIntegrityScan(integrityPayloadSchema.parse(job.payload).scanId, context);
      },
      "workspace.crypto-migrate": async (job, context) => {
        await application.runWorkspaceCryptoMigration(cryptoMigrationPayloadSchema.parse(job.payload).targetKeyId, context);
      },
      "record.analyze": async (job, context) => {
        if (context.signal.aborted) throw new Error("Record analysis interrupted.");
        const payload = recordAnalysisPayloadSchema.parse(job.payload);
        try {
          await application.runRecordAnalysis(payload.recordId, payload.recordRevision, agent, true, job.id, context.signal, (value) => {
            // Pipeline progress, not an assertion that all media have been understood.
            const fraction = value.sourceDurationMs ? value.checkedDurationMs / value.sourceDurationMs : 0;
            context.reportProgress(value.stage === "summarizing" ? 0.9 : 0.85 * (value.mediaNumber - 1 + fraction) / value.mediaCount);
          });
          context.reportProgress(1);
        } catch (error) {
          if (!context.signal.aborted &&
            (job.attempts >= job.maxAttempts || jobRetryDelayForError(error, job.attempts) === undefined)) {
            application.failRecordAnalysis(
              payload.recordId,
              payload.recordRevision,
              error instanceof AppError ? error.code : "INTERNAL_ERROR"
            );
          }
          throw error;
        }
      },
      "record.search-index-rebuild": async (job, context) => {
        const payload = recordSearchIndexPayloadSchema.parse(job.payload);
        if (context.signal.aborted) throw new Error("Search index rebuild interrupted.");
        await application.rebuildRecordSearchIndex(payload.generationId, context.signal);
        context.reportProgress(1);
      },
      "record.search-index-check": async (job, context) => {
        z.object({}).strict().parse(job.payload);
        await application.ensureRecordSearchIndex(context.signal, false);
        context.reportProgress(1);
      }
    }, { concurrency: 2, onChanged: notifyJobsChanged });
    application.ensureWorkspaceCryptoMigration();
    const indexingRunner = runner;
    void application.ensureRecordSearchIndex().then(() => {
      if (runner === indexingRunner) indexingRunner.wake();
    }, () => { /* Derived checks cannot prevent opening a workspace; their own state remains retryable. */ });
    runner.start();

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
      await mediaPreviews.closeAll();
      await runner?.stopAndWait();
      runner = undefined;
      const state = await application.lockWorkspace();
      return state;
    } finally {
      if (application.getWorkspaceStatus().status !== "open" && !window.isDestroyed()) {
        window.webContents.send("workspace:locked");
      }
      locking = false;
    }
  };
  const lockForPowerEvent = () => { void lockWorkspace(); };
  powerMonitor.on("suspend", lockForPowerEvent);
  powerMonitor.on("lock-screen", lockForPowerEvent);
  const idleTimer = setInterval(() => {
    void mediaPreviews.expire().catch(() => {});
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
    mediaPreviews
  });

  window.once("ready-to-show", () => {
    window.show();
    if (startupCleanupError) {
      void dialog.showMessageBox(window, {
        type: "error", title: "工作区恢复失败", message: startupCleanupError.message,
        detail: "上次中断留下的临时文件或加密对象尚未安全清理。请检查应用数据与工作区目录权限，修复后重新启动；相关导入任务暂不可继续。"
      });
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    clearInterval(idleTimer);
    powerMonitor.removeListener("suspend", lockForPowerEvent);
    powerMonitor.removeListener("lock-screen", lockForPowerEvent);
    removeIpcHandlers();
    void (async () => {
      try {
        await mediaPreviews.closeAll();
        await runner?.stopAndWait();
      } finally {
        runner = undefined;
        rendererSession.protocol.unhandle(MEDIA_PREVIEW_SCHEME);
        await workspaces.close();
      }
    })().finally(() => app.quit());
  });
  app.on("window-all-closed", () => app.quit());
}
