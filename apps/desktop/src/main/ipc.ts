import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { stat } from "node:fs/promises";
import { z, ZodError, type ZodType } from "zod";
import type { GrudgeVaultApplication, JobRunner, WorkspaceManagerPort, ScreeningPort } from "@grudge-vault/application";
import type { AgentHarness } from "@grudge-vault/agent-harness";
import type { EventSearchQuery, TimelineQuery, UnifiedSearchQuery, TimelineFilter, RecordSearchQuery } from "@grudge-vault/domain";
import type {
  LlmConnectInput, LlmListModelsInput,
  PatchRecordFieldsInput
} from "@grudge-vault/shared";
import { AppError, RECORD_QUERY_TEXT_LIMIT, RECORD_TEXT_LIMIT, toSerializedError, type IpcResult } from "@grudge-vault/shared";
import { llmConnectSchema, llmListModelsSchema, llmProviderSchema, redesignLlmSettings } from "./llm-ipc-validation";
import type { MediaPreviewService } from "./media-preview";
import { DayOneImportProgress } from "./dayone-import-progress";
import { DayOneImportPause } from "./dayone-import-pause";
import { boundedTextSchema } from "./text-ipc-validation";
import { recordTimeZoneSchema } from "./record-date-ipc-validation";

const emptySchema = z.undefined();
const titleSchema = z.string().trim().min(1).max(120);
const pathsSchema = z.array(z.string().min(1)).min(1).max(100);
const idSchema = z.string().uuid();
const idRevisionSchema = z.object({ id: idSchema, expectedRevision: z.number().int().positive() });
const legalJurisdictionSchema = z.string().trim().min(1).max(200).refine(
  (value) => !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127),
  { message: "Invalid legal jurisdiction." }
);
const externalUrlSchema = z.string().trim().max(2_048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}, { message: "Only credential-free HTTPS links can be opened." });

const temporalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("instant"), value: z.iso.datetime() }),
  z.object({ kind: z.literal("date"), value: z.iso.date() }),
  z.object({ kind: z.literal("month"), value: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
  z.object({ kind: z.literal("range"), from: z.string().optional(), to: z.string().optional() }),
  z.object({ kind: z.literal("relative"), text: z.string().trim().min(1).max(200), anchorRef: idSchema.optional() }),
  z.object({ kind: z.literal("unknown") })
]);
const sourceRefsSchema = z.array(idSchema).max(500);
const statementSchema = z.object({
  id: idSchema,
  kind: z.enum(["fact.confirmed", "fact.disputed", "fact.unknown", "interpretation.user", "interpretation.agent", "emotion"]),
  text: z.string().trim().min(1).max(10_000),
  sourceRefs: sourceRefsSchema
});
const emotionSchema = z.object({
  id: idSchema, label: z.string().trim().min(1).max(120),
  intensity: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
  sourceRefs: sourceRefsSchema
});
const interestSchema = z.object({
  id: idSchema, label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).optional(), sourceRefs: sourceRefsSchema
});
const participantSchema = z.object({ personId: idSchema, role: z.string().trim().max(120).optional() });
const eventFields = {
  title: z.string().trim().min(1).max(200),
  status: z.enum(["candidate", "confirmed", "archived"]),
  occurredAt: temporalSchema,
  narrative: z.string().trim().max(100_000).optional(),
  facts: z.array(statementSchema).max(500),
  interpretations: z.array(statementSchema).max(500),
  emotions: z.array(emotionSchema).max(100),
  interests: z.array(interestSchema).max(100),
  participants: z.array(participantSchema).max(100),
  sourceRefs: sourceRefsSchema,
  assetRefs: z.array(idSchema).max(500)
};
const createEventSchema = z.object({ ...eventFields, reason: z.string().trim().min(1).max(500) });
const updateEventSchema = z.object({
  ...eventFields, eventId: idSchema, expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500)
});
const searchSchema = z.object({
  text: z.string().trim().max(500).optional(),
  status: z.enum(["candidate", "confirmed", "archived"]).optional(),
  personId: idSchema.optional(), from: z.iso.date().optional(), to: z.iso.date().optional(),
  limit: z.number().int().min(1).max(200).optional()
});
const startBackfillSchema = z.object({
  importRunId: idSchema.optional(), from: z.iso.date().optional(), to: z.iso.date().optional(),
  tags: z.array(z.string().trim().min(1).max(120)).max(100),
  batchSize: z.number().int().min(1).max(100).optional()
}).refine((value) => !value.from || !value.to || value.from <= value.to, { message: "Invalid date range." });
const candidateMergeSchema = z.object({
  candidateEventId: idSchema, candidateExpectedRevision: z.number().int().positive(),
  targetEventId: idSchema, targetExpectedRevision: z.number().int().positive()
}).refine((value) => value.candidateEventId !== value.targetEventId, { message: "A candidate cannot merge into itself." });
const personAliasSchema = z.object({ personId: idSchema, value: z.string().trim().min(1).max(120), sourceRefs: sourceRefsSchema.optional() });
const personMergeSchema = z.object({
  sourcePersonId: idSchema, targetPersonId: idSchema, suggestionId: idSchema.optional()
}).refine((value) => value.sourcePersonId !== value.targetPersonId, { message: "A person cannot merge into itself." });
const relationSchema = z.object({
  sourceEventId: idSchema, targetEventId: idSchema,
  kind: z.enum(["similar", "precedes", "same_topic", "same_case"])
}).refine((value) => value.sourceEventId !== value.targetEventId, { message: "An event cannot relate to itself." });
const timelineSchema = z.object({
  personId: idSchema.optional(), status: z.enum(["candidate", "confirmed", "archived"]).optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(), includeArchived: z.boolean().optional()
}).refine((value) => !value.from || !value.to || value.from <= value.to, { message: "Invalid date range." });
const unifiedSearchSchema = z.object({
  text: z.string().trim().max(500), kinds: z.array(z.enum(["event", "journal_entry", "ocr", "transcript"])).max(4).optional(),
  personId: idSchema.optional(), status: z.enum(["candidate", "confirmed", "archived"]).optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(), semantic: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional()
}).refine((value) => !value.from || !value.to || value.from <= value.to, { message: "Invalid date range." });
const reviewSchema = z.object({ from: z.iso.date(), to: z.iso.date() })
  .refine((value) => value.from <= value.to, { message: "Invalid date range." });
const securitySettingsSchema = z.object({
  autoLockMinutes: z.union([z.literal(0), z.literal(5), z.literal(15), z.literal(30), z.literal(60)]),
  integrityScanIntervalDays: z.number().int().min(1).max(365)
});
const mediaSettingsSchema = z.object({
  autoProcessNew: z.boolean(), ocrLanguages: z.array(z.string().trim().min(1).max(80)).min(1).max(16),
  resourceProfile: z.enum(["conservative", "balanced", "performance"]), whisperGpu: z.enum(["auto", "cpu"])
});
const reviewAutomationSchema = z.object({
  monthly: z.boolean(), quarterly: z.boolean(), clarificationWeekly: z.boolean(), systemNotifications: z.boolean()
});
const processorPathKindSchema = z.enum(["tesseract", "poppler", "ffmpeg", "whisper", "whisper_model"]);
const passphraseSchema = z.object({ passphrase: z.string().min(12).max(10_000) });
const caseAmountSchema = z.object({
  id: idSchema, label: z.string().trim().min(1).max(500), currency: z.string().regex(/^[A-Z]{3}$/),
  amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).optional(),
  minimum: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).optional(),
  maximum: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).optional(),
  precision: z.enum(["exact", "approximate", "range", "unknown"]),
  certainty: z.enum(["observed", "documented", "recalled", "inferred", "unknown"]),
  sourceRefs: sourceRefsSchema
});
const caseFields = {
  title: z.string().trim().min(1).max(200), status: z.enum(["draft", "active", "archived"]),
  summary: z.string().trim().max(100_000).optional(), jurisdiction: z.string().trim().min(1).max(500),
  asOfDate: z.iso.date(), eventRefs: z.array(idSchema).max(1_000), personRefs: z.array(idSchema).max(1_000),
  sourceRefs: sourceRefsSchema, assetRefs: z.array(idSchema).max(1_000), amounts: z.array(caseAmountSchema).max(1_000),
  disputePoints: z.array(z.object({ id: idSchema, text: z.string().trim().min(1).max(20_000), sourceRefs: sourceRefsSchema })).max(1_000),
  questions: z.array(z.object({
    id: idSchema, question: z.string().trim().min(1).max(20_000), reason: z.string().trim().min(1).max(20_000),
    status: z.enum(["open", "answered", "dismissed"]), answer: z.string().trim().max(100_000).optional(), sourceRefs: sourceRefsSchema
  })).max(1_000),
  materialGaps: z.array(z.object({
    id: idSchema, label: z.string().trim().min(1).max(500), reason: z.string().trim().min(1).max(20_000),
    priority: z.enum(["normal", "important", "rights_related"]), status: z.enum(["open", "resolved", "dismissed"]),
    resolvedByAssetId: idSchema.optional()
  })).max(1_000),
  evidenceLinks: z.array(z.object({
    id: idSchema, assetId: idSchema, eventId: idSchema.optional(), statementIds: z.array(idSchema).max(1_000),
    sourceRefs: sourceRefsSchema, notes: z.string().trim().max(20_000).optional()
  })).max(2_000)
};
const createCaseSchema = z.object({ ...caseFields, reason: z.string().trim().min(1).max(1_000) });
const updateCaseSchema = z.object({
  ...caseFields, caseId: idSchema, expectedRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(1_000)
});
const binderProfileSchema = z.object({
  caseRevision: z.number().int().positive(), eventIds: z.array(idSchema).max(1_000), sourceItemIds: z.array(idSchema).max(1_000),
  assetIds: z.array(idSchema).max(1_000), derivedArtifactIds: z.array(idSchema).max(1_000),
  includeOriginals: z.boolean(), includeDerivedArtifacts: z.boolean(), locale: z.enum(["zh-CN", "en"]),
  redactions: z.object({
    personIds: z.array(idSchema).max(1_000), maskAmounts: z.boolean(), maskContacts: z.boolean(),
    maskAccounts: z.boolean(), maskFileNames: z.boolean(), omitSourceExcerpts: z.boolean()
  })
});

const intakePrepareSchema = z.object({
  requestId: idSchema, text: boundedTextSchema(RECORD_TEXT_LIMIT), paths: z.array(z.string().min(1)).max(20),
  fileNames: z.array(z.string().trim().min(1).max(255)).max(20),
  inlineMedia: z.array(z.object({
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/heic"]),
    bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= 20 * 1024 * 1024)
  }).strict()).max(20)
}).refine(({ text, paths, inlineMedia }) => Boolean(text.trim()) || paths.length + inlineMedia.length > 0,
  { message: "Text or media is required." })
  .refine(({ paths, fileNames, inlineMedia }) => paths.length === fileNames.length && paths.length + inlineMedia.length <= 20,
    { message: "Invalid attachment list." })
  .refine(({ inlineMedia }) => inlineMedia.reduce((sum, item) => sum + item.bytes.byteLength, 0) <= 64 * 1024 * 1024,
    { message: "Pasted images exceed the in-memory limit." });
const operationSchema = z.object({ sessionId: idSchema, operationId: idSchema });
const categorySchema = z.enum(["grudge", "rights", "danger"]);
const originSchema = z.enum(["manual", "dayone", "zip", "migration"]);
const recordFilterFields = {
  cursor: z.string().max(1_000).optional(), limit: z.number().int().min(1).max(100).optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(), timeZone: recordTimeZoneSchema.optional(),
  category: categorySchema.optional(), origin: originSchema.optional()
};
const recordTimelineSchema = z.object(recordFilterFields)
  .refine((value) => !value.from || !value.to || value.from <= value.to, { message: "Invalid date range." });
const recordSearchSchema = z.object({ text: boundedTextSchema(RECORD_QUERY_TEXT_LIMIT).transform((value) => value.trim()), ...recordFilterFields })
  .refine((value) => !value.from || !value.to || value.from <= value.to, { message: "Invalid date range." });
const recordSearchPrepareSchema = z.object({
  requestId: idSchema, text: boundedTextSchema(RECORD_QUERY_TEXT_LIMIT), paths: z.array(z.string().min(1)).max(4),
  fileNames: z.array(z.string().trim().min(1).max(500)).max(4)
}).refine(({ text, paths, fileNames }) => (Boolean(text.trim()) || paths.length > 0) && paths.length === fileNames.length, {
  message: "Search text or media is required and file metadata must match."
});
const recordSearchFiltersSchema = z.object(recordFilterFields)
  .refine((value) => !value.from || !value.to || value.from <= value.to, { message: "Invalid date range." });
const recordSearchExecuteSchema = z.object({ sessionId: idSchema, filters: recordSearchFiltersSchema });
const patchRecordSchema = z.object({
  recordId: idSchema, expectedRevision: z.number().int().positive(),
  patch: z.object({
    title: z.string().trim().min(1).max(200).optional(), occurredAt: temporalSchema.optional(),
    location: z.string().trim().min(1).max(500).optional(), jurisdiction: z.string().trim().min(1).max(500).optional(),
    clarifications: z.array(z.object({
      kind: z.enum(["unknown", "dispute", "speculation"]), topic: z.string().trim().min(1).max(1_000),
      response: z.string().trim().min(1).max(2_000)
    }).strict()).min(1).max(100).refine((items) =>
      new Set(items.map(({ kind, topic }) => `${kind}\0${topic}`)).size === items.length,
    { message: "Clarification topics must be unique." }).refine((items) =>
      items.reduce((total, { topic, response }) => total + topic.length + response.length, 0) <= 50_000,
    { message: "Clarifications exceed the input limit." }).optional()
  }).refine((value) => Object.keys(value).length > 0, { message: "At least one field is required." })
});
const pendingResolveSchema = z.object({ id: idSchema, action: z.enum(["keep", "ignore"]), operationId: idSchema });
const pendingManualSchema = z.object({ id: idSchema, sessionId: idSchema });
const pendingZipSchema = z.object({ id: idSchema, operationId: idSchema });
const recordAnalysisJobPayloadSchema = z.object({ recordId: idSchema, recordRevision: z.number().int().positive() });

interface IpcDependencies {
  window: BrowserWindow;
  application: GrudgeVaultApplication;
  agent: AgentHarness;
  workspaces: WorkspaceManagerPort;
  restartRunner(): void;
  lockWorkspace(): Promise<unknown>;
  getRunner(): JobRunner | undefined;
  mediaPreviews: MediaPreviewService;
}

function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (event.sender.id !== window.webContents.id || event.senderFrame !== window.webContents.mainFrame) {
    throw new AppError("VALIDATION_FAILED", "Untrusted IPC sender.");
  }
}

function legacyWriteDisabled(): never {
  throw new AppError(
    "VALIDATION_FAILED",
    "This legacy write path is disabled in the redesigned app. Use the screened intake flow."
  );
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
      return { ok: true, data: await handler(schema.parse(rawInput)) };
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
  let activeDayOneImport: AbortController | undefined;
  let activeDayOneImportId: string | undefined;
  let activeDayOnePause: DayOneImportPause | undefined;
  const dayOneProgress = new DayOneImportProgress();
  let activeLegacyMigration: AbortController | undefined;
  const activeManualScreenings = new Map<string, AbortController>();
  const add = <TInput, TOutput>(
    channel: string, schema: ZodType<TInput>, handler: (input: TInput) => Promise<TOutput> | TOutput
  ) => {
    channels.push(channel);
    register(channel, schema, dependencies, handler);
  };
  const changeWorkspace = async <T>(action: () => Promise<T>): Promise<T> => {
    await dependencies.mediaPreviews.closeAll();
    try {
      // A running handler must settle before its repository and keys can be closed.
      await dependencies.getRunner()?.stopAndWait();
      return await action();
    }
    finally {
      // Rebind even on failure: the old session may be preserved, or may have failed closed.
      dependencies.restartRunner();
      if (dependencies.application.getWorkspaceStatus().status !== "open" && !dependencies.window.isDestroyed()) {
        dependencies.window.webContents.send("workspace:locked");
      }
    }
  };

  add("external:open", externalUrlSchema, async (url) => {
    await shell.openExternal(url);
    return true;
  });

  add("workspace:current", emptySchema, () => dependencies.application.getCurrentWorkspace());
  add("workspace:status", emptySchema, () => dependencies.application.getWorkspaceStatus());
  add("workspace:reveal", emptySchema, () => {
    const workspace = dependencies.application.getCurrentWorkspace();
    if (!workspace) throw new AppError("NO_ACTIVE_WORKSPACE", "Open a workspace before revealing its location.");
    shell.showItemInFolder(workspace.rootPath);
    return true;
  });
  add("workspace:create", titleSchema, async (name) => {
    const selection = await dialog.showOpenDialog(dependencies.window, {
      title: "Choose an empty folder for the workspace", properties: ["openDirectory", "createDirectory"]
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const workspace = await changeWorkspace(() => dependencies.application.createWorkspace(selection.filePaths[0]!, name));
    return workspace;
  });
  add("workspace:open", emptySchema, async () => {
    const selection = await dialog.showOpenDialog(dependencies.window, {
      title: "Open a Grudge Vault workspace", properties: ["openDirectory"]
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const workspace = await changeWorkspace(() => dependencies.application.openWorkspace(selection.filePaths[0]!));
    return workspace;
  });
  add("workspace:lock", emptySchema, () => dependencies.lockWorkspace());
  add("workspace:unlock", z.object({ password: z.string().max(128).optional(), newPassword: z.string().min(8).max(128).optional() }).strict().optional(), async (input) => {
    const workspace = await dependencies.application.unlockWorkspace(input);
    dependencies.restartRunner();
    return workspace;
  });
  add("workspace:password-status", emptySchema, () => dependencies.application.getWorkspacePasswordStatus());
  add("workspace:set-password", z.object({ currentPassword: z.string().max(128).optional(), newPassword: z.string().min(8).max(128) }).strict(),
    (input) => dependencies.application.setWorkspacePassword(input));
  add("workspace:security-settings", emptySchema, () => dependencies.application.getWorkspaceSecuritySettings());
  add("workspace:update-security-settings", securitySettingsSchema, (settings) =>
    dependencies.application.updateWorkspaceSecuritySettings(settings));
  add("workspace:export-recovery", passphraseSchema, async ({ passphrase }) => {
    const workspace = dependencies.application.getCurrentWorkspace();
    if (!workspace) throw new AppError("NO_ACTIVE_WORKSPACE", "Unlock the workspace before exporting recovery material.");
    const selection = await dialog.showSaveDialog(dependencies.window, {
      title: "Export passphrase recovery package", defaultPath: `${workspace.name}.gvrecovery`,
      filters: [{ name: "Grudge Vault Recovery", extensions: ["gvrecovery"] }]
    });
    if (selection.canceled || !selection.filePath) return null;
    const path = selection.filePath.endsWith(".gvrecovery") ? selection.filePath : `${selection.filePath}.gvrecovery`;
    return dependencies.application.exportWorkspaceRecovery(path, passphrase);
  });
  add("workspace:recover", passphraseSchema, async ({ passphrase }) => {
    const selection = await dialog.showOpenDialog(dependencies.window, {
      title: "Choose a recovery package", properties: ["openFile"],
      filters: [{ name: "Grudge Vault Recovery", extensions: ["gvrecovery"] }]
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const workspace = await changeWorkspace(() => dependencies.application.recoverWorkspace(selection.filePaths[0]!, passphrase));
    return workspace;
  });
  add("workspace:rotate-key", emptySchema, async () => {
    const status = await dependencies.application.rotateWorkspaceKey();
    dependencies.getRunner()?.wake();
    return status;
  });
  add("workspace:crypto-status", emptySchema, () => dependencies.application.getWorkspaceCryptoStatus());

  add("conversations:list", emptySchema, () => dependencies.application.listConversations());
  add("conversations:create", titleSchema, () => legacyWriteDisabled());
  add("conversations:rename", z.object({ id: idSchema, title: titleSchema }), () => legacyWriteDisabled());
  add("conversations:delete", idSchema, () => legacyWriteDisabled());
  add("conversations:messages", idSchema, (id) => dependencies.application.listMessages(id));
  add("conversations:send", z.object({
    conversationId: idSchema, content: z.string().trim().min(1).max(100_000), intent: z.enum(["record", "source"])
  }), () => legacyWriteDisabled());

  add("agent:send", z.object({
    conversationId: idSchema, content: z.string().trim().min(1).max(100_000)
  }), () => legacyWriteDisabled());
  add("agent:resume", z.object({ runId: idSchema, disclosureId: idSchema }), () => legacyWriteDisabled());
  add("agent:cancel", idSchema, (id) => dependencies.agent.cancel(id));
  add("agent:list-runs", idSchema, (id) => dependencies.agent.listRuns(id));
  add("agent:get-run", idSchema, (id) => dependencies.agent.getRun(id));
  add("agent:approve-action", idSchema, () => legacyWriteDisabled());
  add("agent:reject-action", idSchema, () => legacyWriteDisabled());
  add("llm:get-settings", emptySchema, () => redesignLlmSettings(dependencies.agent.getLlmSettings()));
  add("llm:list-models", llmListModelsSchema, (input) =>
    dependencies.agent.listLlmModels(input as LlmListModelsInput));
  add("llm:save", llmConnectSchema, (input) => redesignLlmSettings(dependencies.agent.saveLlm(input as LlmConnectInput)));
  add("llm:connect", llmConnectSchema, async (input) => redesignLlmSettings(await dependencies.agent.connectLlm(input as LlmConnectInput)));
  add("llm:activate", llmProviderSchema, async (provider) => redesignLlmSettings(await dependencies.agent.activateLlm(provider)));
  add("llm:pause", emptySchema, () => {
    const settings = dependencies.agent.pauseLlm();
    const search = dependencies.application.setRecordSearchIndexEnabled(false);
    const runner = dependencies.getRunner();
    if (runner) search.jobIds.forEach((jobId) => runner.cancel(jobId));
    return redesignLlmSettings(settings);
  });
  add("llm:disconnect", llmProviderSchema, (provider) => redesignLlmSettings(dependencies.agent.disconnectLlm(provider)));

  add("intake:prepare", intakePrepareSchema, (input) => dependencies.application.prepareIntake(input));
  add("intake:abandon-prepare", idSchema, (requestId) => dependencies.application.abandonIntakePreparation(requestId));
  add("intake:abandon", idSchema, (sessionId) => {
    activeManualScreenings.get(sessionId)?.abort(new AppError("SOURCE_UNAVAILABLE", "输入已取消，未建立正式记录。", true));
    dependencies.application.abandonIntake(sessionId);
  });
  add("intake:screen-and-save", operationSchema, async ({ sessionId, operationId }) => {
    if (activeManualScreenings.has(sessionId)) throw new AppError("INVALID_INPUT", "这份输入正在筛选，请等待或取消。", true);
    const controller = new AbortController();
    activeManualScreenings.set(sessionId, controller);
    try {
      const screening: ScreeningPort = { screen: (input, signal) => dependencies.agent.screen(input, signal, (value) => {
        if (!controller.signal.aborted && !dependencies.window.isDestroyed()) dependencies.window.webContents.send("intake:media-progress", { sessionId, ...value });
      }) };
      const result = await dependencies.application.screenAndSaveIntake(
        sessionId, operationId, screening, controller.signal
      );
      if (result.kind === "saved") dependencies.getRunner()?.wake();
      return result;
    } finally {
      activeManualScreenings.delete(sessionId);
    }
  });
  add("intake:choose-dayone-zip", emptySchema, async () => {
    if (activeDayOneImport) throw new AppError("IMPORT_RUN_STATE_CONFLICT", "已有 Day One ZIP 正在导入。");
    const context = dependencies.workspaces.current();
    if (!context) throw new AppError("NO_ACTIVE_WORKSPACE", "请先打开工作区。");
    const operationId = dayOneProgress.begin(context);
    const controller = new AbortController();
    activeDayOneImport = controller;
    activeDayOneImportId = operationId;
    let pause: DayOneImportPause | undefined;
    let screeningStarted = false;
    const saveReceipt = () => {
      if (!screeningStarted || dependencies.workspaces.current() !== context) return;
      const value = dayOneProgress.read(context);
      if (!value || value.operationId !== operationId ||
          value.phase !== "completed" && value.phase !== "cancelled" && value.phase !== "failed") return;
      try {
        dependencies.application.saveDayOneImportReceipt(context, {
          finishedAt: value.updatedAt, outcome: value.phase, totalEntries: value.totalEntries,
          included: value.included, skipped: value.skipped, review: value.review, failed: value.failed, issueCount: value.issueCount,
          ...(value.summary ? { mediaEntries: value.summary.mediaEntries, missingMedia: value.summary.missingMedia } : {}),
          ...(value.usage ? { usage: value.usage } : {}), ...(value.errorCode ? { errorCode: value.errorCode } : {})
        });
        dayOneProgress.markReceiptSaved(operationId, true);
      } catch { dayOneProgress.markReceiptSaved(operationId, false); }
    };
    try {
      const selection = await dialog.showOpenDialog(dependencies.window, {
        title: "选择 Day One JSON ZIP 并逐条筛选",
        properties: ["openFile"],
        filters: [{ name: "Day One JSON ZIP", extensions: ["zip"] }]
      });
      if (selection.canceled || !selection.filePaths[0]) {
        dayOneProgress.finish(operationId, "cancelled"); return null;
      }
      const archivePath = selection.filePaths[0];
      dayOneProgress.phase(operationId, "previewing");
      const before = await stat(archivePath);
      const preview = await dependencies.application.previewScreenedDayOneZip(archivePath, controller.signal);
      const unchanged = async () => {
        const current = await stat(archivePath);
        return current.dev === before.dev && current.ino === before.ino && current.size === before.size &&
          current.mtimeMs === before.mtimeMs && current.ctimeMs === before.ctimeMs;
      };
      if (!await unchanged()) throw new AppError("SOURCE_UNAVAILABLE", "所选 ZIP 在预检时发生变化，请重新选择。", true);
      if (controller.signal.aborted) throw new AppError("IMPORT_CANCELLED", "已停止本次 Day One 导入。", true);
      dayOneProgress.phase(operationId, "confirming", preview.totalEntries);
      const autoLockMinutes = dependencies.application.getWorkspaceSecuritySettings().autoLockMinutes;
      const idleLockNotice = autoLockMinutes === 0
        ? "当前工作区已关闭空闲自动锁定；Mac 锁屏或休眠、手动锁定和退出应用仍会停止导入。"
        : `当前工作区在 Mac 空闲 ${autoLockMinutes} 分钟后会自动锁定；锁屏或休眠、手动锁定和退出应用也会停止导入。可在设置中调整空闲自动锁定时间。`;
      const confirmation = await dialog.showMessageBox(dependencies.window, {
        type: "question",
        title: "确认导入所选 Day One ZIP",
        message: `包内 ${preview.totalEntries} 条日记，${preview.validEntries} 条可筛选`,
        detail: `无效条目 ${preview.invalidEntries} 条；媒体引用 ${preview.mediaReferences} 个，可匹配且当前格式可检查的媒体文件 ${preview.matchedMediaFiles} 个（去重后约 ${(preview.mediaBytes / 1024 / 1024).toFixed(1)} MiB），缺失或暂不支持的引用 ${preview.missingOrUnsupportedMedia} 个。\n\n确认后将逐条把日记文字及可检查媒体发送到已启用的模型筛选；共享媒体可能随不同日记多次发送，收录后的报告分析也可能产生额外调用。重复导入可能重新筛选已修改的日记及旧指纹格式的媒体，费用取决于实际调用。只有通过筛选的内容会写入工作区。\n\n${idleLockNotice} 已保存的记录会保留；重新选择 ZIP 不是断点继续，部分条目可能重新调用模型并产生费用。`,
        buttons: ["取消", "开始筛选"],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      if (confirmation.response !== 1) { dayOneProgress.finish(operationId, "cancelled"); return null; }
      if (controller.signal.aborted) throw new AppError("IMPORT_CANCELLED", "已停止本次 Day One 导入。", true);
      if (!await unchanged()) throw new AppError("SOURCE_UNAVAILABLE", "所选 ZIP 在确认后发生变化，请重新选择。", true);
      screeningStarted = true;
      dayOneProgress.phase(operationId, "screening");
      pause = new DayOneImportPause((phase) => dayOneProgress.phase(operationId, phase), () => {
        dayOneProgress.phase(operationId, "stopping");
        controller.abort(new AppError("IMPORT_CANCELLED", "暂停已超过四小时，本次导入已停止。", true));
      });
      activeDayOnePause = pause;
      const screening: ScreeningPort = { screen: (input, signal, onProgress) => dependencies.agent.screen(input, signal, onProgress,
        (event) => dayOneProgress.observeUsage(operationId, event)) };
      const summary = await dependencies.application.importScreenedDayOneZip(archivePath, screening, controller.signal,
        (counts) => dayOneProgress.update(operationId, counts), (signal) => pause!.beforeItem(signal));
      dayOneProgress.finish(operationId, "completed", summary);
      saveReceipt();
      return summary;
    } catch (cause) {
      const code = toSerializedError(cause).code;
      const cancelled = (controller.signal.aborted || code === "IMPORT_CANCELLED") && code !== "CLEANUP_FAILED";
      dayOneProgress.finish(operationId, cancelled ? "cancelled" : "failed", undefined, cancelled ? "IMPORT_CANCELLED" : code);
      saveReceipt();
      throw cause;
    } finally {
      pause?.dispose();
      if (activeDayOnePause === pause) activeDayOnePause = undefined;
      activeDayOneImport = undefined;
      activeDayOneImportId = undefined;
      dependencies.getRunner()?.wake();
    }
  });
  add("intake:dayone-import-progress", emptySchema, () => dayOneProgress.read(dependencies.workspaces.current()));
  add("intake:last-dayone-import-receipt", emptySchema, () => dependencies.application.getLastDayOneImportReceipt());
  const controlDayOnePause = (operationId: string, resume: boolean): boolean => {
    const progress = dayOneProgress.read(dependencies.workspaces.current());
    if (!progress || progress.operationId !== operationId || activeDayOneImportId !== operationId ||
      !activeDayOneImport || activeDayOneImport.signal.aborted || !activeDayOnePause) return false;
    if (resume) return ["pausing", "paused"].includes(progress.phase) && activeDayOnePause.resume();
    return progress.phase === "screening" && activeDayOnePause.pause();
  };
  add("intake:pause-dayone-zip", idSchema, (operationId) => controlDayOnePause(operationId, false));
  add("intake:resume-dayone-zip", idSchema, (operationId) => controlDayOnePause(operationId, true));
  add("intake:cancel-dayone-zip", emptySchema, () => {
    if (!activeDayOneImport) return false;
    if (activeDayOneImportId) dayOneProgress.phase(activeDayOneImportId, "stopping");
    activeDayOneImport.abort();
    return true;
  });
  add("intake:choose-legacy-workspace", emptySchema, async () => {
    if (!dependencies.workspaces.createLegacyMigrationSource) {
      throw new AppError("INTERNAL_ERROR", "旧工作区迁移能力不可用。");
    }
    if (activeLegacyMigration) throw new AppError("IMPORT_RUN_STATE_CONFLICT", "已有旧工作区正在迁移或核对。");
    const controller = new AbortController();
    activeLegacyMigration = controller;
    try {
      const selection = await dialog.showOpenDialog(dependencies.window, {
        title: "选择只读扫描的旧版 Grudge Vault 工作区",
        properties: ["openDirectory"]
      });
      if (selection.canceled || !selection.filePaths[0]) return null;
      const source = await dependencies.workspaces.createLegacyMigrationSource(selection.filePaths[0]);
      const summary = await dependencies.application.migrateLegacyWorkspace(source, dependencies.agent, controller.signal);
      dependencies.getRunner()?.wake();
      return summary;
    } finally {
      activeLegacyMigration = undefined;
    }
  });
  add("intake:cancel-legacy-workspace", emptySchema, () => {
    if (!activeLegacyMigration) return false;
    activeLegacyMigration.abort(new AppError("IMPORT_CANCELLED", "已停止本次旧工作区迁移；此前完成筛选的正式记录仍保留。", true));
    return true;
  });
  add("records:timeline", recordTimelineSchema, (filter) => dependencies.application.listRecordTimeline(filter as TimelineFilter));
  add("records:get", idSchema, (id) => dependencies.application.getRecordDetail(id));
  add("records:patch-fields", patchRecordSchema, async (input) => {
    const detail = await dependencies.application.patchRecordFields(
      input.recordId, input.expectedRevision, input.patch as PatchRecordFieldsInput["patch"]
    );
    dependencies.getRunner()?.wake();
    return detail;
  });
  add("records:reanalyze", idRevisionSchema, ({ id, expectedRevision }) => {
    const jobId = dependencies.application.reanalyzeRecord(id, expectedRevision);
    dependencies.getRunner()?.wake();
    return jobId;
  });
  add("records:search", recordSearchSchema, (query) => dependencies.application.searchRecords(query as RecordSearchQuery));
  add("records:search-prepare", recordSearchPrepareSchema, (input) => dependencies.application.prepareRecordSearchQuery(input));
  add("records:search-abandon-prepare", idSchema, (requestId) => dependencies.application.abandonRecordSearchPreparation(requestId));
  add("records:search-execute", recordSearchExecuteSchema, ({ sessionId, filters }) =>
    dependencies.application.executeRecordSearchQuery(sessionId, filters as Omit<RecordSearchQuery, "text">, (value) => {
      if (!dependencies.window.isDestroyed()) dependencies.window.webContents.send("records:search-media-progress", { sessionId, ...value });
    }));
  add("records:search-abandon", idSchema, (sessionId) => dependencies.application.abandonRecordSearchQuery(sessionId));
  add("records:search-index-status", emptySchema, () => dependencies.application.getRecordSearchIndexStatus());
  add("records:search-index-enabled", z.boolean(), async (enabled) => {
    const result = dependencies.application.setRecordSearchIndexEnabled(enabled);
    const runner = dependencies.getRunner();
    if (!enabled && runner) result.jobIds.forEach((jobId) => runner.cancel(jobId));
    if (enabled) {
      await dependencies.application.ensureRecordSearchIndex();
      runner?.wake();
    }
    return dependencies.application.getRecordSearchIndexStatus();
  });
  add("records:search-index-rebuild", emptySchema, () => {
    const status = dependencies.application.requestRecordSearchIndexRebuild();
    dependencies.getRunner()?.wake();
    return status;
  });
  add("legal:default-jurisdiction", emptySchema, () => dependencies.application.getDefaultLegalJurisdiction());
  add("legal:set-default-jurisdiction", legalJurisdictionSchema, (jurisdiction) =>
    dependencies.application.setDefaultLegalJurisdiction(jurisdiction));
  add("pending:list", emptySchema, () => dependencies.application.listPendingReviews());
  add("pending:resolve", pendingResolveSchema, async ({ id, action, operationId }) => {
    const result = await dependencies.application.resolvePendingReview(id, action, operationId);
    if (result?.kind === "saved") dependencies.getRunner()?.wake();
    return result;
  });
  add("pending:rescreen-manual", pendingManualSchema, async ({ id, sessionId }) => {
    if (activeManualScreenings.has(sessionId)) throw new AppError("INVALID_INPUT", "这份输入正在筛选，请等待或取消。", true);
    const controller = new AbortController();
    activeManualScreenings.set(sessionId, controller);
    try {
      const screening: ScreeningPort = { screen: (input, signal) => dependencies.agent.screen(input, signal, (value) => {
        if (!controller.signal.aborted && !dependencies.window.isDestroyed()) dependencies.window.webContents.send("intake:media-progress", { sessionId, ...value });
      }) };
      const result = await dependencies.application.rescreenManualPendingReview(
        id, sessionId, screening, controller.signal
      );
      if (result.kind === "saved") dependencies.getRunner()?.wake();
      return result;
    } finally {
      activeManualScreenings.delete(sessionId);
    }
  });
  add("pending:choose-dayone-zip", pendingZipSchema, async ({ id, operationId }) => {
    if (activeDayOneImport) throw new AppError("IMPORT_RUN_STATE_CONFLICT", "已有 Day One ZIP 正在处理。");
    const controller = new AbortController();
    activeDayOneImport = controller;
    try {
      const selection = await dialog.showOpenDialog(dependencies.window, {
        title: "重新选择包含这条待确认日记的 Day One JSON ZIP",
        properties: ["openFile"],
        filters: [{ name: "Day One JSON ZIP", extensions: ["zip"] }]
      });
      if (selection.canceled || !selection.filePaths[0]) return null;
      const result = await dependencies.application.resolvePendingReviewFromDayOneZip(
        id, selection.filePaths[0], dependencies.agent, operationId, controller.signal
      );
      if (result.kind === "saved") dependencies.getRunner()?.wake();
      return result;
    } finally {
      activeDayOneImport = undefined;
    }
  });
  add("pending:choose-legacy-workspace", pendingZipSchema, async ({ id, operationId }) => {
    if (!dependencies.workspaces.createLegacyMigrationSource) {
      throw new AppError("INTERNAL_ERROR", "旧工作区迁移能力不可用。");
    }
    if (activeLegacyMigration) throw new AppError("IMPORT_RUN_STATE_CONFLICT", "已有旧工作区正在迁移或核对。");
    const controller = new AbortController();
    activeLegacyMigration = controller;
    try {
      const selection = await dialog.showOpenDialog(dependencies.window, {
        title: "重新选择包含这条待确认记录的旧版 Grudge Vault 工作区",
        properties: ["openDirectory"]
      });
      if (selection.canceled || !selection.filePaths[0]) return null;
      const source = await dependencies.workspaces.createLegacyMigrationSource(selection.filePaths[0]);
      const result = await dependencies.application.resolvePendingReviewFromLegacyWorkspace(
        id, source, dependencies.agent, operationId, controller.signal
      );
      if (result.kind === "saved") dependencies.getRunner()?.wake();
      return result;
    } finally {
      activeLegacyMigration = undefined;
    }
  });

  add("events:search", searchSchema, (query) => dependencies.application.searchEvents(query as EventSearchQuery));
  add("events:get", idSchema, (id) => dependencies.application.getEvent(id));
  add("events:create", createEventSchema, () => legacyWriteDisabled());
  add("events:update", updateEventSchema, () => legacyWriteDisabled());
  add("events:confirm", idRevisionSchema, () => legacyWriteDisabled());
  add("events:archive", idRevisionSchema, () => legacyWriteDisabled());
  add("events:revisions", idSchema, (id) => dependencies.application.listEventRevisions(id));

  add("people:list", z.boolean().optional(), (includeArchived) => dependencies.application.listPeople(includeArchived));
  add("people:list-identities", emptySchema, () => dependencies.application.listPersonIdentities());
  add("people:create", z.object({ displayName: titleSchema, notes: z.string().trim().max(5_000).optional() }),
    () => legacyWriteDisabled());
  add("people:update", z.object({ id: idSchema, displayName: titleSchema, notes: z.string().trim().max(5_000).optional() }),
    () => legacyWriteDisabled());
  add("people:archive", idSchema, () => legacyWriteDisabled());
  add("people:get", idSchema, (id) => dependencies.application.getPersonIdentity(id));
  add("people:add-alias", personAliasSchema, () => legacyWriteDisabled());
  add("people:deactivate-alias", idSchema, () => legacyWriteDisabled());
  add("people:merge-suggestions", emptySchema, () => dependencies.application.listPersonMergeSuggestions());
  add("people:reject-merge-suggestion", idSchema, () => legacyWriteDisabled());
  add("people:merge", personMergeSchema, () => legacyWriteDisabled());
  add("people:revert-merge", idSchema, () => legacyWriteDisabled());

  add("relations:list", idSchema, (id) => dependencies.application.listEventRelations(id));
  add("relations:refresh", emptySchema, () => legacyWriteDisabled());
  add("relations:create", relationSchema, () => legacyWriteDisabled());
  add("relations:confirm", idSchema, () => legacyWriteDisabled());
  add("relations:reject", idSchema, () => legacyWriteDisabled());
  add("relations:remove", idSchema, () => legacyWriteDisabled());

  add("timeline:query", timelineSchema, (input) => dependencies.application.queryTimeline(input as TimelineQuery));
  add("search:query", unifiedSearchSchema, (input) => dependencies.application.unifiedSearch(input as UnifiedSearchQuery));
  add("search:embedding-status", emptySchema, () => dependencies.application.getEmbeddingStatus());
  add("search:semantic-enabled", z.boolean(), () => legacyWriteDisabled());
  add("search:rebuild-embeddings", emptySchema, () => legacyWriteDisabled());
  add("local-intelligence:status", emptySchema, () => dependencies.application.getLocalProcessorStatus());
  add("local-intelligence:choose-path", processorPathKindSchema, () => legacyWriteDisabled());
  add("local-intelligence:update-settings", mediaSettingsSchema, () => legacyWriteDisabled());
  add("local-intelligence:probe", emptySchema, () => legacyWriteDisabled());
  add("local-intelligence:process-asset", idSchema, () => legacyWriteDisabled());
  add("local-intelligence:process-historical", emptySchema, () => legacyWriteDisabled());
  add("local-intelligence:get-artifact", idSchema, (artifactId) =>
    dependencies.application.getDerivedArtifactDetail(artifactId));
  add("reviews:list", emptySchema, () => dependencies.application.listReviews());
  add("reviews:get", idSchema, (id) => dependencies.application.getReview(id));
  add("reviews:generate", reviewSchema, () => legacyWriteDisabled());
  add("sources:get-reference", idSchema, (id) => dependencies.application.getSourceReference(id));

  add("clarifications:list", idSchema.optional(), (eventId) => dependencies.application.listClarifications(eventId));
  add("clarifications:answer", z.object({
    clarificationId: idSchema, answer: z.string().trim().min(1).max(10_000), expectedRevision: z.number().int().positive()
  }), () => legacyWriteDisabled());
  add("clarifications:dismiss", idRevisionSchema, () => legacyWriteDisabled());
  add("clarifications:priority", z.object({
    id: idSchema, priority: z.enum(["normal", "important", "rights_related"])
  }), () => legacyWriteDisabled());

  add("assets:import-paths", pathsSchema, () => legacyWriteDisabled());
  add("assets:choose-and-import", emptySchema, () => legacyWriteDisabled());
  add("assets:import-for-event", z.object({ paths: pathsSchema, eventId: idSchema, expectedRevision: z.number().int().positive() }),
    () => legacyWriteDisabled());
  add("assets:choose-and-import-for-event", idRevisionSchema, () => legacyWriteDisabled());
  add("assets:list", emptySchema, () => dependencies.application.listAssets());
  add("assets:verify", idSchema, () => legacyWriteDisabled());
  add("assets:preview", idSchema, (assetId) => dependencies.application.previewAsset(assetId));
  add("assets:open-media-preview", z.object({ requestId: idSchema, assetId: idSchema }).strict(), ({ requestId, assetId }) =>
    dependencies.mediaPreviews.open(requestId, assetId));
  add("assets:close-media-preview", idSchema, (requestId) => dependencies.mediaPreviews.close(requestId));
  add("assets:export", idSchema, async (assetId) => {
    const asset = dependencies.application.listAssets().find(({ id }) => id === assetId);
    if (!asset) throw new AppError("ASSET_NOT_FOUND", "The asset no longer exists.");
    const selection = await dialog.showSaveDialog(dependencies.window, { defaultPath: asset.originalFileName });
    if (selection.canceled || !selection.filePath) return null;
    return dependencies.application.exportAsset(assetId, selection.filePath);
  });

  add("evidence:list", emptySchema, () => dependencies.application.listEvidence());
  add("evidence:get", idSchema, (assetId) => dependencies.application.getEvidence(assetId));
  add("evidence:start-scan", emptySchema, () => {
    const scan = dependencies.application.startIntegrityScan();
    dependencies.getRunner()?.wake();
    return scan;
  });
  add("evidence:list-scans", emptySchema, () => dependencies.application.listIntegrityScans());
  add("evidence:delete-impact", idSchema, (assetId) => dependencies.application.getEvidenceImpact(assetId));
  add("evidence:delete-original", z.object({ assetId: idSchema, confirmReferencedDeletion: z.boolean() }), () => legacyWriteDisabled());
  add("evidence:supersede", z.object({ oldAssetId: idSchema, newAssetId: idSchema }), () => legacyWriteDisabled());

  add("cases:list", emptySchema, () => dependencies.application.listCases());
  add("cases:get", idSchema, (id) => dependencies.application.getCase(id));
  add("cases:create", createCaseSchema, () => legacyWriteDisabled());
  add("cases:update", updateCaseSchema, () => legacyWriteDisabled());
  add("cases:archive", idRevisionSchema, () => legacyWriteDisabled());
  add("cases:revisions", idSchema, (id) => dependencies.application.listCaseRevisions(id));
  add("cases:legal-check", idSchema, () => legacyWriteDisabled());
  add("cases:binder-preview", z.object({ id: idSchema, profile: binderProfileSchema }), ({ id, profile }) =>
    dependencies.application.previewCaseBinder(id, profile));
  add("cases:binder-export", idSchema, async (previewId) => {
    const selection = await dialog.showSaveDialog(dependencies.window, {
      title: "Export Case Binder to a new directory", defaultPath: "case-binder"
    });
    if (selection.canceled || !selection.filePath) return null;
    return dependencies.application.exportCaseBinder(previewId, selection.filePath);
  });

  add("imports:choose-dayone", emptySchema, () => legacyWriteDisabled());
  add("imports:list", emptySchema, () => dependencies.application.listImportRuns());
  add("imports:get", idSchema, (id) => dependencies.application.getImportRun(id));
  // The redesigned app never resumes an old watched-folder setting or reads its configured path.
  add("import-folder:status", emptySchema, () => ({
    configured: false, enabled: false, watching: false, importedCount: 0, failedCount: 0
  }));
  add("import-folder:choose", emptySchema, () => legacyWriteDisabled());
  add("import-folder:set-enabled", z.boolean(), () => legacyWriteDisabled());
  add("import-folder:scan", emptySchema, () => legacyWriteDisabled());
  add("reminders:list", emptySchema, () => dependencies.application.listReminders());
  add("reminders:settings", emptySchema, () => legacyWriteDisabled());
  add("reminders:update-settings", reviewAutomationSchema, () => legacyWriteDisabled());
  add("reminders:request-system-notifications", z.enum(["zh-CN", "en"]), () => legacyWriteDisabled());
  add("reminders:read", idSchema, () => legacyWriteDisabled());
  add("reminders:dismiss", idSchema, () => legacyWriteDisabled());

  add("backfill:list", emptySchema, () => dependencies.application.listBackfillRuns());
  add("backfill:start", startBackfillSchema, () => legacyWriteDisabled());
  add("backfill:pause", idSchema, () => legacyWriteDisabled());
  add("backfill:resume", idSchema, () => legacyWriteDisabled());
  add("backfill:cancel", idSchema, () => legacyWriteDisabled());

  add("candidates:list", emptySchema, () => dependencies.application.listCandidates());
  add("candidates:get", idSchema, (eventId) => dependencies.application.getCandidate(eventId));
  add("candidates:confirm", idRevisionSchema, () => legacyWriteDisabled());
  add("candidates:ignore", idRevisionSchema, () => legacyWriteDisabled());
  add("candidates:merge", candidateMergeSchema, () => legacyWriteDisabled());

  add("backups:create", emptySchema, async () => {
    const workspace = dependencies.application.getCurrentWorkspace();
    if (!workspace) throw new AppError("NO_ACTIVE_WORKSPACE", "Open a workspace before creating a backup.");
    const selection = await dialog.showSaveDialog(dependencies.window, {
      title: "Create encrypted workspace snapshot", defaultPath: `${workspace.name}.gvbackup`
    });
    if (selection.canceled || !selection.filePath) return null;
    const path = selection.filePath.endsWith(".gvbackup") ? selection.filePath : `${selection.filePath}.gvbackup`;
    return dependencies.application.createBackup(path);
  });
  add("backups:restore", emptySchema, async () => {
    const backup = await dialog.showOpenDialog(dependencies.window, {
      title: "Choose a Grudge Vault backup", properties: ["openDirectory"]
    });
    if (backup.canceled || !backup.filePaths[0]) return null;
    const destination = await dialog.showOpenDialog(dependencies.window, {
      title: "Choose an empty restore folder", properties: ["openDirectory", "createDirectory"]
    });
    if (destination.canceled || !destination.filePaths[0]) return null;
    const workspace = await changeWorkspace(() => dependencies.application.restoreBackup(backup.filePaths[0]!, destination.filePaths[0]!));
    return workspace;
  });

  add("jobs:list", emptySchema, () => dependencies.application.listJobs());
  add("jobs:retry", idSchema, (jobId) => {
    const runner = dependencies.getRunner();
    if (!runner) throw new AppError("JOB_STATE_CONFLICT", "工作区任务运行器尚未启动。");
    const existingJob = dependencies.application.listJobs().find(({ id }) => id === jobId);
    if (existingJob && !runner.canRun(existingJob.type)) {
      throw new AppError("JOB_STATE_CONFLICT", "旧版任务不会在新版应用中执行；请保留原工作区供回退。");
    }
    const job = dependencies.application.retryJob(jobId);
    runner.wake();
    return job;
  });
  add("jobs:cancel", idSchema, (jobId) => {
    const runner = dependencies.getRunner();
    if (!runner) throw new AppError("JOB_STATE_CONFLICT", "The workspace job runner is not active.");
    const activeJob = dependencies.application.listJobs().find(({ id }) => id === jobId);
    if (activeJob && !runner.canRun(activeJob.type)) {
      throw new AppError("JOB_STATE_CONFLICT", "旧版任务不会在新版应用中执行；请保留原工作区供回退。");
    }
    const analysisPayload = activeJob?.type === "record.analyze"
      ? recordAnalysisJobPayloadSchema.parse(activeJob.payload) : undefined;
    if (analysisPayload && dependencies.application.getRecordDetail(analysisPayload.recordId).report?.analysisRunId === jobId) {
      throw new AppError("JOB_STATE_CONFLICT", "报告已经发布，不能再取消这个分析任务。");
    }
    const job = runner.cancel(jobId);
    if (analysisPayload) {
      dependencies.application.failRecordAnalysis(analysisPayload.recordId, analysisPayload.recordRevision, "JOB_CANCELLED");
    }
    return job;
  });

  return () => {
    activeDayOneImport?.abort();
    activeDayOnePause?.dispose();
    activeLegacyMigration?.abort();
    for (const controller of activeManualScreenings.values()) {
      controller.abort(new AppError("SOURCE_UNAVAILABLE", "输入会话已结束，未建立正式记录。", true));
    }
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
