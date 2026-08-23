import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { z, ZodError, type ZodType } from "zod";
import type { GrudgeVaultApplication, JobRunner, WorkspaceManagerPort } from "@grudge-vault/application";
import type { EventSearchQuery, Person } from "@grudge-vault/domain";
import type {
  ClarificationAnswerInput, CreateEventInput, SendMessageInput, UpdateEventInput
} from "@grudge-vault/shared";
import { AppError, toSerializedError, type IpcResult } from "@grudge-vault/shared";

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

  add("conversations:list", emptySchema, () => dependencies.application.listConversations());
  add("conversations:create", titleSchema, (title) => dependencies.application.createConversation(title));
  add("conversations:rename", z.object({ id: idSchema, title: titleSchema }), ({ id, title }) =>
    dependencies.application.renameConversation(id, title));
  add("conversations:delete", idSchema, (id) => dependencies.application.deleteConversation(id));
  add("conversations:messages", idSchema, (id) => dependencies.application.listMessages(id));
  add("conversations:send", z.object({
    conversationId: idSchema, content: z.string().trim().min(1).max(100_000), createDraft: z.boolean()
  }), (input) => dependencies.application.sendMessage(input as SendMessageInput));

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
  add("people:create", z.object({ displayName: titleSchema, notes: z.string().trim().max(5_000).optional() }),
    ({ displayName, notes }) => dependencies.application.createPerson(displayName, notes));
  add("people:update", z.object({ id: idSchema, displayName: titleSchema, notes: z.string().trim().max(5_000).optional() }),
    (person) => dependencies.application.updatePerson(person as Pick<Person, "id" | "displayName" | "notes">));
  add("people:archive", idSchema, (id) => dependencies.application.archivePerson(id));

  add("clarifications:list", idSchema.optional(), (eventId) => dependencies.application.listClarifications(eventId));
  add("clarifications:answer", z.object({
    clarificationId: idSchema, answer: z.string().trim().min(1).max(10_000), expectedRevision: z.number().int().positive()
  }), (input) => dependencies.application.answerClarification(input as ClarificationAnswerInput));
  add("clarifications:dismiss", idRevisionSchema, ({ id, expectedRevision }) =>
    dependencies.application.dismissClarification(id, expectedRevision));

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

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
