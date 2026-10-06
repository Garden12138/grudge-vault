import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { IpcRendererEvent } from "electron";
import { AppError, toSerializedError, type GrudgeVaultApi, type IpcResult } from "@grudge-vault/shared";
import { readPastedImage } from "./pasted-image";
import { subscribeMediaProgress } from "./media-progress";

const invoke = <T>(channel: string, input?: unknown) => ipcRenderer.invoke(channel, input) as Promise<IpcResult<T>>;
const pendingIntakePreparations = new Map<string, AbortController>();

const api: GrudgeVaultApi = {
  external: {
    open: (url) => invoke("external:open", url)
  },
  workspace: {
    current: () => invoke("workspace:current"),
    status: () => invoke("workspace:status"),
    create: (name) => invoke("workspace:create", name),
    open: () => invoke("workspace:open"),
    lock: () => invoke("workspace:lock"),
    unlock: (input) => invoke("workspace:unlock", input),
    passwordStatus: () => invoke("workspace:password-status"),
    setPassword: (input) => invoke("workspace:set-password", input),
    getSecuritySettings: () => invoke("workspace:security-settings"),
    updateSecuritySettings: (settings) => invoke("workspace:update-security-settings", settings),
    exportRecovery: (input) => invoke("workspace:export-recovery", input),
    recover: (input) => invoke("workspace:recover", input),
    rotateKey: () => invoke("workspace:rotate-key"),
    cryptoStatus: () => invoke("workspace:crypto-status"),
    reveal: () => invoke("workspace:reveal"),
    onLocked: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("workspace:locked", listener);
      return () => ipcRenderer.removeListener("workspace:locked", listener);
    }
  },
  conversations: {
    list: () => invoke("conversations:list"),
    create: (title) => invoke("conversations:create", title),
    rename: (id, title) => invoke("conversations:rename", { id, title }),
    delete: (id) => invoke("conversations:delete", id),
    listMessages: (id) => invoke("conversations:messages", id),
    send: (input) => invoke("conversations:send", input)
  },
  agent: {
    send: (input) => invoke("agent:send", input),
    resume: (runId, disclosureId) => invoke("agent:resume", { runId, disclosureId }),
    cancel: (runId) => invoke("agent:cancel", runId),
    listRuns: (conversationId) => invoke("agent:list-runs", conversationId),
    getRun: (runId) => invoke("agent:get-run", runId),
    approveAction: (actionId) => invoke("agent:approve-action", actionId),
    rejectAction: (actionId) => invoke("agent:reject-action", actionId)
  },
  llm: {
    getSettings: () => invoke("llm:get-settings"),
    listModels: (input) => invoke("llm:list-models", input),
    save: (input) => invoke("llm:save", input),
    connect: (input) => invoke("llm:connect", input),
    activate: (provider) => invoke("llm:activate", provider),
    pause: () => invoke("llm:pause"),
    disconnect: (provider) => invoke("llm:disconnect", provider)
  },
  intake: {
    onMediaProgress: (callback) => subscribeMediaProgress(ipcRenderer, "intake:media-progress", callback),
    prepare: async ({ requestId, text, files }) => {
      if (pendingIntakePreparations.has(requestId)) {
        return { ok: false, error: toSerializedError(new AppError("INVALID_INPUT", "这份输入正在准备中。", true)) };
      }
      const controller = new AbortController();
      pendingIntakePreparations.set(requestId, controller);
      try {
        const paths: string[] = [];
        const fileNames: string[] = [];
        const inlineMedia: Array<{ fileName: string; mimeType: string; bytes: Uint8Array }> = [];
        let inlineByteSize = 0;
        const imageExtensions: Record<string, string> = {
          "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic"
        };
        for (const [index, file] of files.entries()) {
          if (controller.signal.aborted) throw controller.signal.reason;
          let path = "";
          try { path = webUtils.getPathForFile(file); } catch { /* Clipboard Files do not have a local path. */ }
          if (path) {
            paths.push(path);
            fileNames.push(file.name || path.split(/[\\/]/).at(-1) || "attachment");
            continue;
          }
          const extension = imageExtensions[file.type];
          if (!extension || file.size === 0 || file.size > 20 * 1024 * 1024) {
            throw new AppError("INVALID_INPUT", "直接粘贴只支持单张不超过 20 MB 的图片；其他媒体请从本机选择文件。", true);
          }
          inlineByteSize += file.size;
          if (inlineByteSize > 64 * 1024 * 1024) {
            throw new AppError("INVALID_INPUT", "粘贴图片合计不能超过 64 MB，请改用文件选择。", true);
          }
          const fileName = file.name || `pasted-image-${index + 1}${extension}`;
          inlineMedia.push({ fileName, mimeType: file.type, bytes: await readPastedImage(file, controller.signal) });
        }
        if (controller.signal.aborted) throw controller.signal.reason;
        return await invoke("intake:prepare", { requestId, text, paths, fileNames, inlineMedia });
      } catch (error) {
        return { ok: false, error: toSerializedError(error) };
      } finally {
        if (pendingIntakePreparations.get(requestId) === controller) pendingIntakePreparations.delete(requestId);
      }
    },
    abandonPreparation: (requestId) => {
      pendingIntakePreparations.get(requestId)?.abort(
        new AppError("SOURCE_UNAVAILABLE", "输入准备已取消，未建立正式记录。", true)
      );
      return invoke("intake:abandon-prepare", requestId);
    },
    abandon: (sessionId) => invoke("intake:abandon", sessionId),
    screenAndSave: (sessionId, operationId) => invoke("intake:screen-and-save", { sessionId, operationId }),
    chooseDayOneZip: () => invoke("intake:choose-dayone-zip"),
    dayOneImportProgress: () => invoke("intake:dayone-import-progress"),
    lastDayOneImportReceipt: () => invoke("intake:last-dayone-import-receipt"),
    pauseDayOneZip: (operationId) => invoke("intake:pause-dayone-zip", operationId),
    resumeDayOneZip: (operationId) => invoke("intake:resume-dayone-zip", operationId),
    cancelDayOneZip: () => invoke("intake:cancel-dayone-zip"),
    chooseLegacyWorkspace: () => invoke("intake:choose-legacy-workspace"),
    cancelLegacyWorkspace: () => invoke("intake:cancel-legacy-workspace")
  },
  records: {
    onSearchMediaProgress: (callback) => subscribeMediaProgress(ipcRenderer, "records:search-media-progress", callback),
    timeline: (filter) => invoke("records:timeline", filter),
    get: (id) => invoke("records:get", id),
    patchFields: (input) => invoke("records:patch-fields", input),
    reanalyze: (id, expectedRevision) => invoke("records:reanalyze", { id, expectedRevision }),
    search: (query) => invoke("records:search", query),
    prepareSearch: async ({ requestId, text, files }) => {
      try {
        const paths = files.map((file) => webUtils.getPathForFile(file));
        if (paths.some((path) => !path)) throw new AppError("FILE_NOT_REGULAR", "Only local files selected by the system can be used.");
        return await invoke("records:search-prepare", { requestId, text, paths, fileNames: files.map(({ name }) => name) });
      } catch (error) {
        return { ok: false, error: toSerializedError(error) };
      }
    },
    abandonSearchPreparation: (requestId) => invoke("records:search-abandon-prepare", requestId),
    executeSearch: (sessionId, filters) => invoke("records:search-execute", { sessionId, filters }),
    abandonSearch: (sessionId) => invoke("records:search-abandon", sessionId),
    searchIndexStatus: () => invoke("records:search-index-status"),
    rebuildSearchIndex: () => invoke("records:search-index-rebuild"),
    setSearchIndexEnabled: (enabled) => invoke("records:search-index-enabled", enabled)
  },
  pending: {
    list: () => invoke("pending:list"),
    resolve: (id, action, operationId) => invoke("pending:resolve", { id, action, operationId }),
    rescreenManual: (id, sessionId) => invoke("pending:rescreen-manual", { id, sessionId }),
    chooseDayOneZip: (id, operationId) => invoke("pending:choose-dayone-zip", { id, operationId }),
    chooseLegacyWorkspace: (id, operationId) => invoke("pending:choose-legacy-workspace", { id, operationId })
  },
  legal: {
    getDefaultJurisdiction: () => invoke("legal:default-jurisdiction"),
    setDefaultJurisdiction: (jurisdiction) => invoke("legal:set-default-jurisdiction", jurisdiction)
  },
  events: {
    search: (query) => invoke("events:search", query),
    get: (id) => invoke("events:get", id),
    create: (input) => invoke("events:create", input),
    update: (input) => invoke("events:update", input),
    confirm: (id, expectedRevision) => invoke("events:confirm", { id, expectedRevision }),
    archive: (id, expectedRevision) => invoke("events:archive", { id, expectedRevision }),
    listRevisions: (id) => invoke("events:revisions", id)
  },
  people: {
    list: (includeArchived) => invoke("people:list", includeArchived),
    listIdentities: () => invoke("people:list-identities"),
    create: (displayName, notes) => invoke("people:create", { displayName, ...(notes === undefined ? {} : { notes }) }),
    update: (person) => invoke("people:update", person),
    archive: (id) => invoke("people:archive", id),
    get: (id) => invoke("people:get", id),
    addAlias: (input) => invoke("people:add-alias", input),
    deactivateAlias: (id) => invoke("people:deactivate-alias", id),
    listMergeSuggestions: () => invoke("people:merge-suggestions"),
    rejectMergeSuggestion: (id) => invoke("people:reject-merge-suggestion", id),
    merge: (input) => invoke("people:merge", input),
    revertMerge: (id) => invoke("people:revert-merge", id)
  },
  relations: {
    listForEvent: (eventId) => invoke("relations:list", eventId),
    refreshSuggestions: () => invoke("relations:refresh"),
    create: (input) => invoke("relations:create", input),
    confirm: (id) => invoke("relations:confirm", id),
    reject: (id) => invoke("relations:reject", id),
    remove: (id) => invoke("relations:remove", id)
  },
  timeline: {
    query: (input) => invoke("timeline:query", input)
  },
  search: {
    query: (input) => invoke("search:query", input),
    getEmbeddingStatus: () => invoke("search:embedding-status"),
    setSemanticEnabled: (enabled) => invoke("search:semantic-enabled", enabled),
    rebuildEmbeddings: () => invoke("search:rebuild-embeddings")
  },
  localIntelligence: {
    status: () => invoke("local-intelligence:status"),
    choosePath: (kind) => invoke("local-intelligence:choose-path", kind),
    updateSettings: (settings) => invoke("local-intelligence:update-settings", settings),
    probe: () => invoke("local-intelligence:probe"),
    processAsset: (assetId) => invoke("local-intelligence:process-asset", assetId),
    processHistorical: () => invoke("local-intelligence:process-historical"),
    getArtifact: (artifactId) => invoke("local-intelligence:get-artifact", artifactId)
  },
  reviews: {
    list: () => invoke("reviews:list"),
    get: (id) => invoke("reviews:get", id),
    generate: (input) => invoke("reviews:generate", input)
  },
  sources: {
    getReference: (sourceItemId) => invoke("sources:get-reference", sourceItemId)
  },
  clarifications: {
    list: (eventId) => invoke("clarifications:list", eventId),
    answer: (input) => invoke("clarifications:answer", input),
    dismiss: (id, expectedRevision) => invoke("clarifications:dismiss", { id, expectedRevision }),
    setPriority: (id, priority) => invoke("clarifications:priority", { id, priority })
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
    importForEvent: async (files, eventId, expectedRevision) => {
      try {
        const paths = files.map((file) => webUtils.getPathForFile(file));
        if (paths.length === 0 || paths.some((path) => !path)) {
          throw new AppError("FILE_NOT_REGULAR", "Only files selected from the local device can be imported.");
        }
        return await invoke("assets:import-for-event", { paths, eventId, expectedRevision });
      } catch (error) {
        return { ok: false, error: toSerializedError(error) };
      }
    },
    chooseAndImportForEvent: (eventId, expectedRevision) =>
      invoke("assets:choose-and-import-for-event", { id: eventId, expectedRevision }),
    list: () => invoke("assets:list"),
    verify: (assetId) => invoke("assets:verify", assetId),
    preview: (assetId) => invoke("assets:preview", assetId),
    openMediaPreview: (input) => invoke("assets:open-media-preview", input),
    closeMediaPreview: (requestId) => invoke("assets:close-media-preview", requestId),
    exportCopy: (assetId) => invoke("assets:export", assetId)
  },
  evidence: {
    list: () => invoke("evidence:list"),
    get: (assetId) => invoke("evidence:get", assetId),
    startScan: () => invoke("evidence:start-scan"),
    listScans: () => invoke("evidence:list-scans"),
    deleteImpact: (assetId) => invoke("evidence:delete-impact", assetId),
    deleteOriginal: (input) => invoke("evidence:delete-original", input),
    supersede: (input) => invoke("evidence:supersede", input)
  },
  cases: {
    list: () => invoke("cases:list"),
    get: (id) => invoke("cases:get", id),
    create: (input) => invoke("cases:create", input),
    update: (input) => invoke("cases:update", input),
    archive: (id, expectedRevision) => invoke("cases:archive", { id, expectedRevision }),
    listRevisions: (id) => invoke("cases:revisions", id),
    runLegalCheck: (id) => invoke("cases:legal-check", id),
    previewBinder: (id, profile) => invoke("cases:binder-preview", { id, profile }),
    exportBinder: (previewId) => invoke("cases:binder-export", previewId)
  },
  imports: {
    chooseDayOneZip: () => invoke("imports:choose-dayone"),
    list: () => invoke("imports:list"),
    get: (id) => invoke("imports:get", id)
  },
  importFolder: {
    status: () => invoke("import-folder:status"),
    choose: () => invoke("import-folder:choose"),
    setEnabled: (enabled) => invoke("import-folder:set-enabled", enabled),
    scanNow: () => invoke("import-folder:scan")
  },
  reminders: {
    list: () => invoke("reminders:list"),
    getSettings: () => invoke("reminders:settings"),
    updateSettings: (settings) => invoke("reminders:update-settings", settings),
    requestSystemNotifications: (locale) => invoke("reminders:request-system-notifications", locale),
    markRead: (id) => invoke("reminders:read", id),
    dismiss: (id) => invoke("reminders:dismiss", id),
    onDue: (callback) => {
      const listener = (_event: IpcRendererEvent, reminderId: string, shouldOpen = false) => callback(reminderId, shouldOpen);
      ipcRenderer.on("reminders:due", listener);
      return () => ipcRenderer.removeListener("reminders:due", listener);
    }
  },
  backfill: {
    list: () => invoke("backfill:list"),
    start: (input) => invoke("backfill:start", input),
    pause: (id) => invoke("backfill:pause", id),
    resume: (id) => invoke("backfill:resume", id),
    cancel: (id) => invoke("backfill:cancel", id)
  },
  candidates: {
    list: () => invoke("candidates:list"),
    get: (eventId) => invoke("candidates:get", eventId),
    confirm: (eventId, expectedRevision) => invoke("candidates:confirm", { id: eventId, expectedRevision }),
    ignore: (eventId, expectedRevision) => invoke("candidates:ignore", { id: eventId, expectedRevision }),
    merge: (input) => invoke("candidates:merge", input)
  },
  backups: {
    createSnapshot: () => invoke("backups:create"),
    restoreSnapshot: () => invoke("backups:restore")
  },
  jobs: {
    list: () => invoke("jobs:list"),
    retry: (jobId) => invoke("jobs:retry", jobId),
    cancel: (jobId) => invoke("jobs:cancel", jobId),
    onChanged: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("jobs:changed", listener);
      return () => ipcRenderer.removeListener("jobs:changed", listener);
    }
  }
};

contextBridge.exposeInMainWorld("grudgeVault", api);
