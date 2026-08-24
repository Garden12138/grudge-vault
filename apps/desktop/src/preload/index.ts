import { contextBridge, ipcRenderer, webUtils } from "electron";
import { AppError, toSerializedError, type GrudgeVaultApi, type IpcResult } from "@grudge-vault/shared";

const invoke = <T>(channel: string, input?: unknown) => ipcRenderer.invoke(channel, input) as Promise<IpcResult<T>>;

const api: GrudgeVaultApi = {
  workspace: {
    current: () => invoke("workspace:current"),
    create: (name) => invoke("workspace:create", name),
    open: () => invoke("workspace:open")
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
    rejectAction: (actionId) => invoke("agent:reject-action", actionId),
    getSettings: () => invoke("agent:get-settings"),
    updateSettings: (input) => invoke("agent:update-settings", input),
    clearCredential: (mode) => invoke("agent:clear-credential", mode)
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
    exportCopy: (assetId) => invoke("assets:export", assetId)
  },
  imports: {
    chooseDayOneZip: () => invoke("imports:choose-dayone"),
    list: () => invoke("imports:list"),
    get: (id) => invoke("imports:get", id)
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
    onChanged: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("jobs:changed", listener);
      return () => ipcRenderer.removeListener("jobs:changed", listener);
    }
  }
};

contextBridge.exposeInMainWorld("grudgeVault", api);
