import { join } from "node:path";
import { app, BrowserWindow, session } from "electron";
import { z } from "zod";
import { GrudgeVaultApplication, JobRunner, type KeyProtectorPort } from "@grudge-vault/application";
import { DayOneZipImporter } from "@grudge-vault/importer-dayone";
import { AppError } from "@grudge-vault/shared";
import { registerIpcHandlers } from "./ipc";
import { SafeStorageKeyProtector } from "./key-protector";
import { LocalWorkspaceManager } from "./workspace-manager";

interface BootstrapOptions {
  keyProtector?: KeyProtectorPort;
  initialWorkspacePath?: string;
  initialWorkspaceName?: string;
}

const verifyPayloadSchema = z.object({ assetId: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const importPayloadSchema = z.object({ importRunId: z.string().uuid() });
const backfillPayloadSchema = z.object({ backfillRunId: z.string().uuid() });

export async function bootstrap(options: BootstrapOptions = {}): Promise<void> {
  await app.whenReady();
  const workspaces = new LocalWorkspaceManager(
    options.keyProtector ?? new SafeStorageKeyProtector(),
    join(app.getPath("userData"), "state.json")
  );
  const application = new GrudgeVaultApplication(workspaces, undefined, new DayOneZipImporter());

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
    runner = new JobRunner(current.jobs, {
      "asset.verify": async (job, context) => {
        const payload = verifyPayloadSchema.parse(job.payload);
        if (context.signal.aborted) throw new Error("Verification interrupted.");
        const asset = current.assets.findById(payload.assetId);
        if (!asset || asset.sha256 !== payload.sha256) {
          throw new AppError("ASSET_NOT_FOUND", "The asset for this verification job no longer exists.");
        }
        const valid = await current.vault.verify(payload.sha256, current.key, context.reportProgress);
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
      }
    }, { onChanged: notifyJobsChanged });
    runner.start();
  };
  restartRunner();

  const removeIpcHandlers = registerIpcHandlers({
    window,
    application,
    workspaces,
    restartRunner,
    getRunner: () => runner
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }
  window.once("ready-to-show", () => window.show());

  app.on("before-quit", () => {
    runner?.stop();
    removeIpcHandlers();
    void workspaces.close();
  });
  app.on("window-all-closed", () => app.quit());
}
