import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { z, ZodError, type ZodType } from "zod";
import type { GrudgeVaultApplication, JobRunner } from "@grudge-vault/application";
import type { WorkspaceManagerPort } from "@grudge-vault/application";
import { AppError, toSerializedError, type IpcResult } from "@grudge-vault/shared";

const emptySchema = z.undefined();
const workspaceNameSchema = z.string().trim().min(1).max(120);
const pathsSchema = z.array(z.string().min(1)).min(1).max(100);
const idSchema = z.string().uuid();

interface IpcDependencies {
  window: BrowserWindow;
  application: GrudgeVaultApplication;
  workspaces: WorkspaceManagerPort;
  restartRunner(): void;
  getRunner(): JobRunner | undefined;
}

function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (event.sender.id !== window.webContents.id || event.senderFrame !== window.webContents.mainFrame) {
    throw new AppError("VALIDATION_FAILED", "Untrusted IPC sender.");
  }
}

function register<TInput, TOutput>(
  channel: string,
  schema: ZodType<TInput>,
  dependencies: IpcDependencies,
  handler: (input: TInput) => Promise<TOutput> | TOutput
): void {
  ipcMain.handle(channel, async (event, rawInput): Promise<IpcResult<TOutput>> => {
    try {
      assertTrustedSender(event, dependencies.window);
      const input = schema.parse(rawInput);
      return { ok: true, data: await handler(input) };
    } catch (error) {
      if (error instanceof ZodError) {
        return { ok: false, error: toSerializedError(new AppError("VALIDATION_FAILED", "The request was invalid.")) };
      }
      return { ok: false, error: toSerializedError(error) };
    }
  });
}

export function registerIpcHandlers(dependencies: IpcDependencies): () => void {
  const channels: string[] = [];
  const add = <TInput, TOutput>(
    channel: string,
    schema: ZodType<TInput>,
    handler: (input: TInput) => Promise<TOutput> | TOutput
  ) => {
    channels.push(channel);
    register(channel, schema, dependencies, handler);
  };

  add("workspace:current", emptySchema, () => dependencies.application.getCurrentWorkspace());
  add("workspace:create", workspaceNameSchema, async (name) => {
    const selection = await dialog.showOpenDialog(dependencies.window, {
      title: "Choose an empty folder for the workspace",
      properties: ["openDirectory", "createDirectory"]
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const workspace = await dependencies.application.createWorkspace(selection.filePaths[0], name);
    dependencies.restartRunner();
    return workspace;
  });
  add("workspace:open", emptySchema, async () => {
    const selection = await dialog.showOpenDialog(dependencies.window, {
      title: "Open a Grudge Vault workspace",
      properties: ["openDirectory"]
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const workspace = await dependencies.application.openWorkspace(selection.filePaths[0]);
    dependencies.restartRunner();
    return workspace;
  });
  add("assets:import-paths", pathsSchema, async (paths) => {
    const imported = [];
    for (const path of paths) imported.push(await dependencies.application.importAsset(path));
    dependencies.getRunner()?.wake();
    return imported;
  });
  add("assets:choose-and-import", emptySchema, async () => {
    const selection = await dialog.showOpenDialog(dependencies.window, {
      title: "Import files into the encrypted vault",
      properties: ["openFile", "multiSelections"]
    });
    if (selection.canceled) return [];
    const imported = [];
    for (const path of selection.filePaths) imported.push(await dependencies.application.importAsset(path));
    dependencies.getRunner()?.wake();
    return imported;
  });
  add("assets:list", emptySchema, () => dependencies.application.listAssets());
  add("assets:verify", idSchema, (assetId) => {
    const job = dependencies.application.verifyAsset(assetId);
    dependencies.getRunner()?.wake();
    return job;
  });
  add("jobs:list", emptySchema, () => dependencies.application.listJobs());
  add("jobs:retry", idSchema, (jobId) => {
    const job = dependencies.application.retryJob(jobId);
    dependencies.getRunner()?.wake();
    return job;
  });

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
