import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { z, ZodError, type ZodType } from "zod";
import type { GrudgeVaultApplication, JobRunner, WorkspaceManagerPort } from "@grudge-vault/application";
import type { AgentHarness } from "@grudge-vault/agent-harness";
import type { EventSearchQuery, Person, TimelineQuery, UnifiedSearchQuery } from "@grudge-vault/domain";
import type {
  AgentSendInput, AgentSettingsUpdateInput, CandidateMergeInput, ClarificationAnswerInput, CreateEventInput,
  CreateCaseInput, CreateRelationInput, PersonAliasInput, PersonMergeInput, ReviewGenerateInput,
  SendMessageInput, StartBackfillInput, UpdateCaseInput, UpdateEventInput
} from "@grudge-vault/shared";
import { AppError, toSerializedError, type IpcResult, type LocalProcessorPathKind } from "@grudge-vault/shared";
import type { LocalMediaPipeline } from "@grudge-vault/media-pipeline";
import type { ImportFolderMonitor } from "./import-folder-monitor";

const emptySchema = z.undefined();
const titleSchema = z.string().trim().min(1).max(120);
const pathsSchema = z.array(z.string().min(1)).min(1).max(100);
const idSchema = z.string().uuid();
const idRevisionSchema = z.object({ id: idSchema, expectedRevision: z.number().int().positive() });

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
const agentEndpointSchema = z.object({
  baseUrl: z.string().trim().url().max(2_000), model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(1).max(10_000).optional(), clearCredential: z.boolean().optional()
});
const agentCategoriesSchema = z.array(z.enum([
  "conversation_text", "event_fields", "source_excerpt", "asset_metadata", "ocr_excerpt", "transcript_excerpt"
])).max(6);
const agentSettingsSchema = z.object({
  mode: z.enum(["private", "enhanced"]), privateEndpoint: agentEndpointSchema.optional(),
  enhancedEndpoint: agentEndpointSchema.optional(), consentedDataCategories: agentCategoriesSchema.optional()
});
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

interface IpcDependencies {
  window: BrowserWindow;
  application: GrudgeVaultApplication;
  agent: AgentHarness;
  workspaces: WorkspaceManagerPort;
  restartRunner(): void;
  lockWorkspace(): Promise<unknown>;
  getRunner(): JobRunner | undefined;
  localMediaPipeline?: LocalMediaPipeline;
  importFolder: ImportFolderMonitor;
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
  const add = <TInput, TOutput>(
    channel: string, schema: ZodType<TInput>, handler: (input: TInput) => Promise<TOutput> | TOutput
  ) => {
    channels.push(channel);
    register(channel, schema, dependencies, handler);
  };

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
    const workspace = await dependencies.application.createWorkspace(selection.filePaths[0], name);
    dependencies.restartRunner();
    return workspace;
  });
  add("workspace:open", emptySchema, async () => {
    const selection = await dialog.showOpenDialog(dependencies.window, {
      title: "Open a Grudge Vault workspace", properties: ["openDirectory"]
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const workspace = await dependencies.application.openWorkspace(selection.filePaths[0]);
    dependencies.restartRunner();
    return workspace;
  });
  add("workspace:lock", emptySchema, () => dependencies.lockWorkspace());
  add("workspace:unlock", emptySchema, async () => {
    const workspace = await dependencies.application.unlockWorkspace();
    dependencies.restartRunner();
    return workspace;
  });
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
    const workspace = await dependencies.application.recoverWorkspace(selection.filePaths[0], passphrase);
    dependencies.restartRunner();
    return workspace;
  });
  add("workspace:rotate-key", emptySchema, async () => {
    const status = await dependencies.application.rotateWorkspaceKey();
    dependencies.getRunner()?.wake();
    return status;
  });
  add("workspace:crypto-status", emptySchema, () => dependencies.application.getWorkspaceCryptoStatus());

  add("conversations:list", emptySchema, () => dependencies.application.listConversations());
  add("conversations:create", titleSchema, (title) => dependencies.application.createConversation(title));
  add("conversations:rename", z.object({ id: idSchema, title: titleSchema }), ({ id, title }) =>
    dependencies.application.renameConversation(id, title));
  add("conversations:delete", idSchema, (id) => dependencies.application.deleteConversation(id));
  add("conversations:messages", idSchema, (id) => dependencies.application.listMessages(id));
  add("conversations:send", z.object({
    conversationId: idSchema, content: z.string().trim().min(1).max(100_000), intent: z.enum(["record", "source"])
  }), (input) => dependencies.application.sendMessage(input as SendMessageInput));

  add("agent:send", z.object({
    conversationId: idSchema, content: z.string().trim().min(1).max(100_000)
  }), (input) => dependencies.agent.send(input as AgentSendInput));
  add("agent:resume", z.object({ runId: idSchema, disclosureId: idSchema }), ({ runId, disclosureId }) =>
    dependencies.agent.resume(runId, disclosureId));
  add("agent:cancel", idSchema, (id) => dependencies.agent.cancel(id));
  add("agent:list-runs", idSchema, (id) => dependencies.agent.listRuns(id));
  add("agent:get-run", idSchema, (id) => dependencies.agent.getRun(id));
  add("agent:approve-action", idSchema, (id) => dependencies.agent.approveAction(id));
  add("agent:reject-action", idSchema, (id) => dependencies.agent.rejectAction(id));
  add("agent:get-settings", emptySchema, () => dependencies.agent.getSettings());
  add("agent:update-settings", agentSettingsSchema, (input) =>
    dependencies.agent.updateSettings(input as AgentSettingsUpdateInput));
  add("agent:clear-credential", z.enum(["private", "enhanced"]), (mode) => dependencies.agent.clearCredential(mode));

  add("events:search", searchSchema, (query) => dependencies.application.searchEvents(query as EventSearchQuery));
  add("events:get", idSchema, (id) => dependencies.application.getEvent(id));
  add("events:create", createEventSchema, (input) => dependencies.application.createEvent(input as CreateEventInput));
  add("events:update", updateEventSchema, (input) => dependencies.application.updateEvent(input as UpdateEventInput));
  add("events:confirm", idRevisionSchema, ({ id, expectedRevision }) =>
    dependencies.application.confirmEvent(id, expectedRevision));
  add("events:archive", idRevisionSchema, ({ id, expectedRevision }) =>
    dependencies.application.archiveEvent(id, expectedRevision));
  add("events:revisions", idSchema, (id) => dependencies.application.listEventRevisions(id));

  add("people:list", z.boolean().optional(), (includeArchived) => dependencies.application.listPeople(includeArchived));
  add("people:list-identities", emptySchema, () => dependencies.application.listPersonIdentities());
  add("people:create", z.object({ displayName: titleSchema, notes: z.string().trim().max(5_000).optional() }),
    ({ displayName, notes }) => dependencies.application.createPerson(displayName, notes));
  add("people:update", z.object({ id: idSchema, displayName: titleSchema, notes: z.string().trim().max(5_000).optional() }),
    (person) => dependencies.application.updatePerson(person as Pick<Person, "id" | "displayName" | "notes">));
  add("people:archive", idSchema, (id) => dependencies.application.archivePerson(id));
  add("people:get", idSchema, (id) => dependencies.application.getPersonIdentity(id));
  add("people:add-alias", personAliasSchema, (input) => dependencies.application.addPersonAlias(input as PersonAliasInput));
  add("people:deactivate-alias", idSchema, (id) => dependencies.application.deactivatePersonAlias(id));
  add("people:merge-suggestions", emptySchema, () => dependencies.application.listPersonMergeSuggestions());
  add("people:reject-merge-suggestion", idSchema, (id) => dependencies.application.rejectPersonMergeSuggestion(id));
  add("people:merge", personMergeSchema, (input) => dependencies.application.mergePeople(input as PersonMergeInput));
  add("people:revert-merge", idSchema, (id) => dependencies.application.revertPersonMerge(id));

  add("relations:list", idSchema, (id) => dependencies.application.listEventRelations(id));
  add("relations:refresh", emptySchema, () => dependencies.application.refreshRelationSuggestions());
  add("relations:create", relationSchema, (input) => dependencies.application.createEventRelation(input as CreateRelationInput));
  add("relations:confirm", idSchema, (id) => dependencies.application.confirmEventRelation(id));
  add("relations:reject", idSchema, (id) => dependencies.application.rejectEventRelation(id));
  add("relations:remove", idSchema, (id) => dependencies.application.removeEventRelation(id));

  add("timeline:query", timelineSchema, (input) => dependencies.application.queryTimeline(input as TimelineQuery));
  add("search:query", unifiedSearchSchema, (input) => dependencies.application.unifiedSearch(input as UnifiedSearchQuery));
  add("search:embedding-status", emptySchema, () => dependencies.application.getEmbeddingStatus());
  add("search:semantic-enabled", z.boolean(), (enabled) => dependencies.application.setSemanticEnabled(enabled));
  add("search:rebuild-embeddings", emptySchema, () => {
    const job = dependencies.application.rebuildEmbeddings();
    dependencies.getRunner()?.wake();
    return job;
  });
  add("local-intelligence:status", emptySchema, () => dependencies.application.getLocalProcessorStatus());
  add("local-intelligence:choose-path", processorPathKindSchema, async (kind) => {
    if (!dependencies.localMediaPipeline) throw new AppError("LOCAL_PROCESSOR_UNAVAILABLE", "Local processor configuration is unavailable.");
    const selection = await dialog.showOpenDialog(dependencies.window, {
      title: kind === "whisper_model" ? "Choose a Whisper model" : `Choose ${kind} executable`, properties: ["openFile"]
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    await dependencies.localMediaPipeline.setPath(kind as LocalProcessorPathKind, selection.filePaths[0]);
    return dependencies.application.getLocalProcessorStatus();
  });
  add("local-intelligence:update-settings", mediaSettingsSchema, (settings) =>
    dependencies.application.updateMediaProcessingSettings(settings));
  add("local-intelligence:probe", emptySchema, () => dependencies.application.probeLocalProcessors());
  add("local-intelligence:process-asset", idSchema, async (assetId) => {
    const job = await dependencies.application.enqueueMediaProcessing(assetId);
    dependencies.getRunner()?.wake();
    return job;
  });
  add("local-intelligence:process-historical", emptySchema, async () => {
    const jobs = await dependencies.application.enqueueHistoricalMediaProcessing();
    dependencies.getRunner()?.wake();
    return jobs;
  });
  add("local-intelligence:get-artifact", idSchema, (artifactId) =>
    dependencies.application.getDerivedArtifactDetail(artifactId));
  add("reviews:list", emptySchema, () => dependencies.application.listReviews());
  add("reviews:get", idSchema, (id) => dependencies.application.getReview(id));
  add("reviews:generate", reviewSchema, (input) => dependencies.application.generateReview(input as ReviewGenerateInput));
  add("sources:get-reference", idSchema, (id) => dependencies.application.getSourceReference(id));

  add("clarifications:list", idSchema.optional(), (eventId) => dependencies.application.listClarifications(eventId));
  add("clarifications:answer", z.object({
    clarificationId: idSchema, answer: z.string().trim().min(1).max(10_000), expectedRevision: z.number().int().positive()
  }), (input) => dependencies.application.answerClarification(input as ClarificationAnswerInput));
  add("clarifications:dismiss", idRevisionSchema, ({ id, expectedRevision }) =>
    dependencies.application.dismissClarification(id, expectedRevision));
  add("clarifications:priority", z.object({
    id: idSchema, priority: z.enum(["normal", "important", "rights_related"])
  }), ({ id, priority }) => dependencies.application.setClarificationPriority(id, priority));

  add("assets:import-paths", pathsSchema, async (paths) => {
    const imported = [];
    for (const path of paths) imported.push(await dependencies.application.importAsset(path));
    dependencies.getRunner()?.wake();
    return imported;
  });
  add("assets:choose-and-import", emptySchema, async () => {
    const selection = await dialog.showOpenDialog(dependencies.window, {
      title: "Import files into the encrypted vault", properties: ["openFile", "multiSelections"]
    });
    if (selection.canceled) return [];
    const imported = [];
    for (const path of selection.filePaths) imported.push(await dependencies.application.importAsset(path));
    dependencies.getRunner()?.wake();
    return imported;
  });
  add("assets:import-for-event", z.object({ paths: pathsSchema, eventId: idSchema, expectedRevision: z.number().int().positive() }),
    async ({ paths, eventId, expectedRevision }) => {
      const event = await dependencies.application.importAssetsForEvent(paths, eventId, expectedRevision);
      dependencies.getRunner()?.wake();
      return event;
    });
  add("assets:choose-and-import-for-event", idRevisionSchema, async ({ id, expectedRevision }) => {
    const selection = await dialog.showOpenDialog(dependencies.window, {
      title: "Attach encrypted originals", properties: ["openFile", "multiSelections"]
    });
    if (selection.canceled || selection.filePaths.length === 0) return null;
    const event = await dependencies.application.importAssetsForEvent(selection.filePaths, id, expectedRevision);
    dependencies.getRunner()?.wake();
    return event;
  });
  add("assets:list", emptySchema, () => dependencies.application.listAssets());
  add("assets:verify", idSchema, (assetId) => {
    const job = dependencies.application.verifyAsset(assetId);
    dependencies.getRunner()?.wake();
    return job;
  });
  add("assets:preview", idSchema, (assetId) => dependencies.application.previewAsset(assetId));
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
  add("evidence:delete-original", z.object({ assetId: idSchema, confirmReferencedDeletion: z.boolean() }), (input) =>
    dependencies.application.deleteOriginal(input.assetId, input.confirmReferencedDeletion));
  add("evidence:supersede", z.object({ oldAssetId: idSchema, newAssetId: idSchema }), (input) =>
    dependencies.application.supersedeOriginal(input.oldAssetId, input.newAssetId));

  add("cases:list", emptySchema, () => dependencies.application.listCases());
  add("cases:get", idSchema, (id) => dependencies.application.getCase(id));
  add("cases:create", createCaseSchema, (input) => dependencies.application.createCase(input as CreateCaseInput));
  add("cases:update", updateCaseSchema, (input) => dependencies.application.updateCase(input as UpdateCaseInput));
  add("cases:archive", idRevisionSchema, ({ id, expectedRevision }) => dependencies.application.archiveCase(id, expectedRevision));
  add("cases:revisions", idSchema, (id) => dependencies.application.listCaseRevisions(id));
  add("cases:legal-check", idSchema, (id) => dependencies.application.runLegalCheck(id));
  add("cases:binder-preview", z.object({ id: idSchema, profile: binderProfileSchema }), ({ id, profile }) =>
    dependencies.application.previewCaseBinder(id, profile));
  add("cases:binder-export", idSchema, async (previewId) => {
    const selection = await dialog.showSaveDialog(dependencies.window, {
      title: "Export Case Binder to a new directory", defaultPath: "case-binder"
    });
    if (selection.canceled || !selection.filePath) return null;
    return dependencies.application.exportCaseBinder(previewId, selection.filePath);
  });

  add("imports:choose-dayone", emptySchema, async () => {
    const selection = await dialog.showOpenDialog(dependencies.window, {
      title: "Import a Day One JSON ZIP", properties: ["openFile"],
      filters: [{ name: "Day One JSON ZIP", extensions: ["zip"] }]
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const run = await dependencies.application.createDayOneImport(selection.filePaths[0]);
    dependencies.getRunner()?.wake();
    return run;
  });
  add("imports:list", emptySchema, () => dependencies.application.listImportRuns());
  add("imports:get", idSchema, (id) => dependencies.application.getImportRun(id));
  add("import-folder:status", emptySchema, () => dependencies.importFolder.status());
  add("import-folder:choose", emptySchema, async () => {
    const selection = await dialog.showOpenDialog(dependencies.window, {
      title: "Choose a Day One import folder", properties: ["openDirectory"]
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return dependencies.importFolder.choose(selection.filePaths[0]);
  });
  add("import-folder:set-enabled", z.boolean(), (enabled) => dependencies.importFolder.setEnabled(enabled));
  add("import-folder:scan", emptySchema, () => dependencies.importFolder.scanNow());
  add("reminders:list", emptySchema, () => dependencies.application.listReminders());
  add("reminders:settings", emptySchema, () => dependencies.application.getReviewAutomationSettings());
  add("reminders:update-settings", reviewAutomationSchema, (settings) =>
    dependencies.application.updateReviewAutomationSettings(settings));
  add("reminders:read", idSchema, (id) => dependencies.application.markReminderRead(id));
  add("reminders:dismiss", idSchema, (id) => dependencies.application.dismissReminder(id));

  add("backfill:list", emptySchema, () => dependencies.application.listBackfillRuns());
  add("backfill:start", startBackfillSchema, (input) => {
    const run = dependencies.application.startBackfill(input as StartBackfillInput);
    dependencies.getRunner()?.wake();
    return run;
  });
  add("backfill:pause", idSchema, (id) => dependencies.application.pauseBackfill(id));
  add("backfill:resume", idSchema, (id) => {
    const run = dependencies.application.resumeBackfill(id);
    dependencies.getRunner()?.wake();
    return run;
  });
  add("backfill:cancel", idSchema, (id) => dependencies.application.cancelBackfill(id));

  add("candidates:list", emptySchema, () => dependencies.application.listCandidates());
  add("candidates:get", idSchema, (eventId) => dependencies.application.getCandidate(eventId));
  add("candidates:confirm", idRevisionSchema, ({ id, expectedRevision }) =>
    dependencies.application.confirmCandidate(id, expectedRevision));
  add("candidates:ignore", idRevisionSchema, ({ id, expectedRevision }) =>
    dependencies.application.ignoreCandidate(id, expectedRevision));
  add("candidates:merge", candidateMergeSchema, (input) =>
    dependencies.application.mergeCandidate(input as CandidateMergeInput));

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
    const workspace = await dependencies.application.restoreBackup(backup.filePaths[0], destination.filePaths[0]);
    dependencies.restartRunner();
    return workspace;
  });

  add("jobs:list", emptySchema, () => dependencies.application.listJobs());
  add("jobs:retry", idSchema, (jobId) => {
    const job = dependencies.application.retryJob(jobId);
    dependencies.getRunner()?.wake();
    return job;
  });
  add("jobs:cancel", idSchema, (jobId) => {
    const runner = dependencies.getRunner();
    if (!runner) throw new AppError("JOB_STATE_CONFLICT", "The workspace job runner is not active.");
    return runner.cancel(jobId);
  });

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
