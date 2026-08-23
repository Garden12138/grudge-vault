import { contextBridge, ipcRenderer, webUtils } from "electron";
import { AppError, toSerializedError, type GrudgeVaultApi, type IpcResult } from "@grudge-vault/shared";

const invoke = <T>(channel: string, input?: unknown) => ipcRenderer.invoke(channel, input) as Promise<IpcResult<T>>;

const api: GrudgeVaultApi = {
  workspace: {
    current: () => invoke("workspace:current"),
    create: (name) => invoke("workspace:create", name),
    open: () => invoke("workspace:open")
  },
  assets: {
    importDropped: async (files) => {
      try {
        const paths = files.map((file) => webUtils.getPathForFile(file));
        if (paths.length === 0 || paths.some((path) => !path)) {
          throw new AppError("FILE_NOT_REGULAR", "Only files selected from the local device can be imported.");
        }
        return await invoke("assets:import-paths", paths);
      } catch (error) {
        return { ok: false, error: toSerializedError(error) };
      }
    },
    chooseAndImport: () => invoke("assets:choose-and-import"),
    list: () => invoke("assets:list"),
    verify: (assetId) => invoke("assets:verify", assetId)
  },
  jobs: {
    list: () => invoke("jobs:list"),
    retry: (jobId) => invoke("jobs:retry", jobId),
    onChanged: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("jobs:changed", listener);
      return () => ipcRenderer.removeListener("jobs:changed", listener);
    }
  }
};

contextBridge.exposeInMainWorld("grudgeVault", api);
