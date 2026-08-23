import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, rename, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lookup as lookupMimeType } from "mime-types";
import type {
  Asset, Clarification, Conversation, Event, EventRevision, EventSearchQuery,
  Job, Message, Person, Source, SourceItem, Workspace
} from "@grudge-vault/domain";
import {
  AppError, toSerializedError, type AssetImportResult, type AssetPreview,
  type BackupSummary, type ClarificationAnswerInput, type CreateEventInput,
  type EventWriteFields, type SendMessageInput, type SendMessageResult, type UpdateEventInput
} from "@grudge-vault/shared";
import {
  DeterministicEventDraftGenerator, type EventCommitExtras,
  type EventDraftGeneratorPort, type EventDraftProposal, type MemoryRepositoryPort
} from "./memory";

export * from "./memory";

export interface StoredObject {
  sha256: string;
  byteSize: number;
  vaultFormat: number;
  deduplicated: boolean;
}

export interface ObjectVaultPort {
  put(inputPath: string, key: Buffer): Promise<StoredObject>;
  open(sha256: string, key: Buffer): Promise<Readable>;
  verify(sha256: string, key: Buffer, onProgress?: (progress: number) => void): Promise<boolean>;
  cleanupTempFiles(): Promise<void>;
}

export interface AssetRepositoryPort {
  list(): Asset[];
  findById(id: string): Asset | undefined;
  upsert(asset: Asset): { asset: Asset; deduplicated: boolean };
  setIntegrity(id: string, status: Asset["integrityStatus"], verifiedAt?: string): Asset;
}

export interface JobRepositoryPort {
  list(): Job[];
  enqueue(type: string, payload: unknown, now: string, maxAttempts?: number): Job;
  claimNext(now: string, leaseUntil: string): Job | undefined;
  heartbeat(id: string, leaseUntil: string, now: string): void;
  updateProgress(id: string, progress: number, now: string): void;
  succeed(id: string, now: string): Job;
  fail(id: string, error: string, now: string, retryAt?: string): Job;
  retry(id: string, now: string): Job;
}

export interface WorkspaceSession {
  workspace: Workspace;
  key: Buffer;
  assets: AssetRepositoryPort;
  jobs: JobRepositoryPort;
  memory: MemoryRepositoryPort;
  vault: ObjectVaultPort;
  backupDatabase(destinationPath: string): Promise<void>;
  close(): Promise<void>;
}

export interface WorkspaceManagerPort {
  current(): WorkspaceSession | undefined;
  create(rootPath: string, name: string): Promise<WorkspaceSession>;
  open(rootPath: string): Promise<WorkspaceSession>;
  createBackup(destinationPath: string): Promise<BackupSummary>;
  restoreBackup(backupPath: string, destinationPath: string): Promise<WorkspaceSession>;
  close(): Promise<void>;
}

export interface KeyProtectorPort {
  assertAvailable(): Promise<void>;
  protect(key: Buffer): Promise<string>;
  unprotect(envelope: string): Promise<{ key: Buffer; refreshedEnvelope?: string }>;
}

export class GrudgeVaultApplication {
  constructor(
    private readonly workspaces: WorkspaceManagerPort,
    private readonly draftGenerator: EventDraftGeneratorPort = new DeterministicEventDraftGenerator()
  ) {}

  getCurrentWorkspace(): Workspace | null {
    return this.workspaces.current()?.workspace ?? null;
  }

  async createWorkspace(rootPath: string, name: string): Promise<Workspace> {
    return (await this.workspaces.create(rootPath, name)).workspace;
  }

  async openWorkspace(rootPath: string): Promise<Workspace> {
    return (await this.workspaces.open(rootPath)).workspace;
  }

  async createBackup(destinationPath: string): Promise<BackupSummary> {
    this.requireSession();
    return this.workspaces.createBackup(destinationPath);
  }

  async restoreBackup(backupPath: string, destinationPath: string): Promise<Workspace> {
    return (await this.workspaces.restoreBackup(backupPath, destinationPath)).workspace;
  }

  listConversations(): Conversation[] {
    return this.requireSession().memory.listConversations();
  }

  createConversation(title: string): Conversation {
    const now = new Date().toISOString();
    const normalizedTitle = title.trim();
    const source: Source = { id: randomUUID(), kind: "chat", name: normalizedTitle, createdAt: now };
    const conversation: Conversation = {
      id: randomUUID(), sourceId: source.id, title: normalizedTitle, createdAt: now, updatedAt: now
    };
    return this.requireSession().memory.createConversation(conversation, source);
  }

  renameConversation(id: string, title: string): Conversation {
    return this.requireSession().memory.renameConversation(id, title.trim(), new Date().toISOString());
  }

  deleteConversation(id: string): Conversation {
    return this.requireSession().memory.deleteConversation(id, new Date().toISOString());
  }

  listMessages(conversationId: string): Message[] {
    return this.requireSession().memory.listMessages(conversationId);
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const memory = this.requireSession().memory;
    const now = new Date().toISOString();
    const sourceItemId = randomUUID();
    const content = input.content.trim();
    const message: Message = {
      id: randomUUID(), conversationId: input.conversationId, sourceItemId,
      role: "user", content, createdAt: now
    };
    const sourceItem: SourceItem = {
      id: sourceItemId, sourceId: "", externalId: message.id, content,
      recordedAt: now, assetRefs: []
    };
    const savedMessage = memory.appendMessage(message, sourceItem);
    if (!input.createDraft) return { message: savedMessage };
    try {
      const proposal = await this.draftGenerator.generate(input.content, sourceItemId);
      if (!proposal) return { message: savedMessage };
      return { message: savedMessage, draft: this.createProposedEvent(proposal) };
    } catch (error) {
      return { message: savedMessage, draftError: toSerializedError(error) };
    }
  }

  searchEvents(query: EventSearchQuery): Event[] {
    return this.requireSession().memory.searchEvents(query);
  }

  getEvent(id: string) {
    const detail = this.requireSession().memory.getEventDetail(id);
    if (!detail) throw new AppError("ENTITY_NOT_FOUND", "The event no longer exists.");
    return detail;
  }

  listEventRevisions(id: string): EventRevision[] {
    return this.requireSession().memory.listEventRevisions(id);
  }

  createEvent(input: CreateEventInput): Event {
    const now = new Date().toISOString();
    const extras: EventCommitExtras = {};
    let fields: EventWriteFields = input;
    if (input.sourceRefs.length === 0 && input.narrative?.trim()) {
      const manual = this.manualSource(input.narrative, now);
      fields = { ...input, sourceRefs: [manual.item.id] };
      extras.sources = [manual.source];
      extras.sourceItems = [manual.item];
    }
    return this.commitNewEvent(fields, input.reason, now, extras);
  }

  updateEvent(input: UpdateEventInput): Event {
    const current = this.getCurrentEvent(input.eventId);
    this.assertRevision(current, input.expectedRevision);
    return this.commitRevision(current, input, input.reason);
  }

  confirmEvent(id: string, expectedRevision: number): Event {
    return this.changeEventStatus(id, expectedRevision, "confirmed", "Confirmed by user");
  }

  archiveEvent(id: string, expectedRevision: number): Event {
    return this.changeEventStatus(id, expectedRevision, "archived", "Archived by user");
  }

  listPeople(includeArchived = false): Person[] {
    return this.requireSession().memory.listPeople(includeArchived);
  }

  createPerson(displayName: string, notes?: string): Person {
    const now = new Date().toISOString();
    const person: Person = {
      id: randomUUID(), displayName: displayName.trim(), status: "active", createdAt: now, updatedAt: now
    };
    if (notes?.trim()) person.notes = notes.trim();
    return this.requireSession().memory.createPerson(person);
  }

  updatePerson(input: Pick<Person, "id" | "displayName" | "notes">): Person {
    const memory = this.requireSession().memory;
    const current = memory.getPerson(input.id);
    if (!current) throw new AppError("ENTITY_NOT_FOUND", "The person no longer exists.");
    const next: Person = {
      id: current.id, displayName: input.displayName.trim(), status: current.status,
      createdAt: current.createdAt, updatedAt: new Date().toISOString()
    };
    if (input.notes?.trim()) next.notes = input.notes.trim();
    return memory.updatePerson(next);
  }

  archivePerson(id: string): Person {
    const memory = this.requireSession().memory;
    const current = memory.getPerson(id);
    if (!current) throw new AppError("ENTITY_NOT_FOUND", "The person no longer exists.");
    return memory.updatePerson({ ...current, status: "archived", updatedAt: new Date().toISOString() });
  }

  listClarifications(eventId?: string): Clarification[] {
    return this.requireSession().memory.listClarifications(eventId);
  }

  answerClarification(input: ClarificationAnswerInput): Event {
    const memory = this.requireSession().memory;
    const clarification = memory.getClarification(input.clarificationId);
    if (!clarification) throw new AppError("ENTITY_NOT_FOUND", "The clarification no longer exists.");
    if (clarification.status !== "open") throw new AppError("VALIDATION_FAILED", "The clarification is already closed.");
    const current = this.getCurrentEvent(clarification.eventId);
    this.assertRevision(current, input.expectedRevision);
    const now = new Date().toISOString();
    const manual = this.manualSource(input.answer.trim(), now);
    const updatedClarification: Clarification = {
      ...clarification, status: "answered", answerSourceRef: manual.item.id, updatedAt: now
    };
    const next = this.eventWithFields(current, {
      ...current, sourceRefs: [...new Set([...current.sourceRefs, manual.item.id])]
    }, now, -1);
    return memory.commitEvent(next, this.revisionFor(current, next, "Clarification answered", [manual.item.id], now), {
      sources: [manual.source], sourceItems: [manual.item], clarifications: [updatedClarification]
    });
  }

  dismissClarification(id: string, expectedRevision: number): Event {
    const memory = this.requireSession().memory;
    const clarification = memory.getClarification(id);
    if (!clarification) throw new AppError("ENTITY_NOT_FOUND", "The clarification no longer exists.");
    if (clarification.status !== "open") throw new AppError("VALIDATION_FAILED", "The clarification is already closed.");
    const current = this.getCurrentEvent(clarification.eventId);
    this.assertRevision(current, expectedRevision);
    const now = new Date().toISOString();
    const next = this.eventWithFields(current, current, now, -1);
    return memory.commitEvent(next, this.revisionFor(current, next, "Clarification dismissed", [], now), {
      clarifications: [{ ...clarification, status: "dismissed", updatedAt: now }]
    });
  }

  async importAsset(filePath: string): Promise<AssetImportResult> {
    const session = this.requireSession();
    const stat = await lstat(filePath).catch((cause: unknown) => {
      throw new AppError("FILE_NOT_REGULAR", "The selected file cannot be read.", false, { cause });
    });
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new AppError("FILE_NOT_REGULAR", "Only regular files can be imported.");
    }
    try {
      const stored = await session.vault.put(filePath, session.key);
      const now = new Date().toISOString();
      const candidate: Asset = {
        id: randomUUID(), sha256: stored.sha256, byteSize: stored.byteSize,
        mimeType: lookupMimeType(filePath) || "application/octet-stream",
        originalFileName: basename(filePath), vaultFormat: stored.vaultFormat,
        integrityStatus: "pending", createdAt: now
      };
      const result = session.assets.upsert(candidate);
      if (!result.deduplicated) {
        session.jobs.enqueue("asset.verify", { assetId: result.asset.id, sha256: result.asset.sha256 }, now);
      }
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("ASSET_IMPORT_FAILED", "The file could not be stored in the vault.", true, { cause: error });
    }
  }

  async importAssetsForEvent(filePaths: string[], eventId: string, expectedRevision: number): Promise<Event> {
    const current = this.getCurrentEvent(eventId);
    this.assertRevision(current, expectedRevision);
    const imported: AssetImportResult[] = [];
    for (const filePath of filePaths) imported.push(await this.importAsset(filePath));
    const now = new Date().toISOString();
    const sources: Source[] = [];
    const sourceItems: SourceItem[] = [];
    for (const result of imported) {
      const source: Source = {
        id: randomUUID(), kind: "manual-file", name: result.asset.originalFileName, createdAt: now
      };
      const item: SourceItem = {
        id: randomUUID(), sourceId: source.id, externalId: result.asset.id,
        recordedAt: now, assetRefs: [result.asset.id]
      };
      sources.push(source);
      sourceItems.push(item);
    }
    const next = this.eventWithFields(current, {
      ...current,
      assetRefs: [...new Set([...current.assetRefs, ...imported.map(({ asset }) => asset.id)])],
      sourceRefs: [...new Set([...current.sourceRefs, ...sourceItems.map(({ id }) => id)])]
    }, now);
    return this.requireSession().memory.commitEvent(
      next,
      this.revisionFor(current, next, "Attached encrypted originals", sourceItems.map(({ id }) => id), now),
      { sources, sourceItems }
    );
  }

  listAssets(): Asset[] {
    return this.requireSession().assets.list();
  }

  async previewAsset(assetId: string): Promise<AssetPreview> {
    const session = this.requireSession();
    const asset = session.assets.findById(assetId);
    if (!asset) throw new AppError("ASSET_NOT_FOUND", "The asset no longer exists.");
    if (asset.byteSize > 64 * 1024 * 1024 || !PREVIEW_MIME_TYPES.has(asset.mimeType)) {
      throw new AppError("ASSET_PREVIEW_UNAVAILABLE", "This file must be exported before it can be viewed.");
    }
    try {
      const chunks: Buffer[] = [];
      let byteSize = 0;
      for await (const chunk of await session.vault.open(asset.sha256, session.key)) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteSize += buffer.length;
        if (byteSize > 64 * 1024 * 1024) {
          throw new AppError("ASSET_PREVIEW_UNAVAILABLE", "This file is too large for an in-app preview.");
        }
        chunks.push(buffer);
      }
      if (byteSize !== asset.byteSize) throw new AppError("ASSET_CORRUPT", "The decrypted object size does not match its metadata.");
      return {
        assetId, fileName: asset.originalFileName, mimeType: asset.mimeType,
        bytes: new Uint8Array(Buffer.concat(chunks))
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("ASSET_CORRUPT", "The encrypted object could not be authenticated.", false, { cause: error });
    }
  }

  async exportAsset(assetId: string, outputPath: string): Promise<string> {
    const session = this.requireSession();
    const asset = session.assets.findById(assetId);
    if (!asset) throw new AppError("ASSET_NOT_FOUND", "The asset no longer exists.");
    const temporary = `${outputPath}.${randomUUID()}.tmp`;
    try {
      await pipeline(await session.vault.open(asset.sha256, session.key), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      await rename(temporary, outputPath);
      return outputPath;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new AppError("ASSET_EXPORT_FAILED", "The decrypted copy could not be exported.", true, { cause: error });
    }
  }

  verifyAsset(assetId: string): Job {
    const session = this.requireSession();
    const asset = session.assets.findById(assetId);
    if (!asset) throw new AppError("ASSET_NOT_FOUND", "The asset no longer exists.");
    session.assets.setIntegrity(asset.id, "pending");
    return session.jobs.enqueue(
      "asset.verify", { assetId: asset.id, sha256: asset.sha256 }, new Date().toISOString()
    );
  }

  listJobs(): Job[] {
    return this.requireSession().jobs.list();
  }

  retryJob(jobId: string): Job {
    return this.requireSession().jobs.retry(jobId, new Date().toISOString());
  }

  private createProposedEvent(proposal: EventDraftProposal): Event {
    const now = new Date().toISOString();
    const clarifications: Clarification[] = proposal.clarification ? [{
      id: randomUUID(), eventId: "", ...proposal.clarification, status: "open",
      sourceRefs: proposal.sourceRefs, createdAt: now, updatedAt: now
    }] : [];
    return this.commitNewEvent(proposal, "Created from chat message", now, { clarifications });
  }

  private commitNewEvent(fields: EventWriteFields, reason: string, now: string, extras: EventCommitExtras = {}): Event {
    const id = randomUUID();
    const clarifications = (extras.clarifications ?? []).map((item) => ({ ...item, eventId: id }));
    const normalized = normalizeEventFields(fields);
    const event: Event = {
      id, ...normalized, recordedAt: now, updatedAt: now, currentRevision: 1,
      completeness: completenessFor(normalized, clarifications.filter(({ status }) => status === "open").length)
    };
    const revision: EventRevision = {
      id: randomUUID(), eventId: id, revision: 1, previousRevision: 0, snapshot: event,
      actor: "user", reason: reason.trim() || "Event created", sourceRefs: event.sourceRefs, createdAt: now
    };
    return this.requireSession().memory.commitEvent(event, revision, { ...extras, clarifications });
  }

  private commitRevision(current: Event, fields: EventWriteFields, reason: string): Event {
    const now = new Date().toISOString();
    const next = this.eventWithFields(current, fields, now);
    return this.requireSession().memory.commitEvent(next, this.revisionFor(current, next, reason, next.sourceRefs, now));
  }

  private eventWithFields(current: Event, fields: EventWriteFields, now: string, clarificationDelta = 0): Event {
    const normalized = normalizeEventFields(fields);
    const openCount = Math.max(0, current.completeness.openClarificationCount + clarificationDelta);
    return {
      id: current.id, ...normalized, recordedAt: current.recordedAt, updatedAt: now,
      currentRevision: current.currentRevision + 1,
      completeness: completenessFor(normalized, openCount)
    };
  }

  private revisionFor(current: Event, next: Event, reason: string, sourceRefs: string[], now: string): EventRevision {
    return {
      id: randomUUID(), eventId: next.id, revision: next.currentRevision,
      previousRevision: current.currentRevision, snapshot: next, actor: "user",
      reason: reason.trim() || "Event updated", sourceRefs: [...new Set(sourceRefs)], createdAt: now
    };
  }

  private changeEventStatus(id: string, expectedRevision: number, status: Event["status"], reason: string): Event {
    const current = this.getCurrentEvent(id);
    this.assertRevision(current, expectedRevision);
    return this.commitRevision(current, { ...current, status }, reason);
  }

  private getCurrentEvent(id: string): Event {
    const event = this.requireSession().memory.getEvent(id);
    if (!event) throw new AppError("ENTITY_NOT_FOUND", "The event no longer exists.");
    return event;
  }

  private assertRevision(event: Event, expectedRevision: number): void {
    if (event.currentRevision !== expectedRevision) {
      throw new AppError("EVENT_REVISION_CONFLICT", "The event changed after it was opened. Reload it before saving.", true);
    }
  }

  private manualSource(content: string, now: string): { source: Source; item: SourceItem } {
    const source: Source = { id: randomUUID(), kind: "manual", name: "Manual entry", createdAt: now };
    return { source, item: { id: randomUUID(), sourceId: source.id, content, recordedAt: now, assetRefs: [] } };
  }

  private requireSession(): WorkspaceSession {
    const session = this.workspaces.current();
    if (!session) throw new AppError("NO_ACTIVE_WORKSPACE", "Create or open a workspace first.");
    return session;
  }
}

function normalizeEventFields(fields: EventWriteFields): EventWriteFields {
  return {
    title: fields.title.trim(), status: fields.status, occurredAt: fields.occurredAt,
    ...(fields.narrative?.trim() ? { narrative: fields.narrative.trim() } : {}),
    facts: fields.facts.map((item) => ({ ...item, text: item.text.trim(), sourceRefs: [...new Set(item.sourceRefs)] })),
    interpretations: fields.interpretations.map((item) => ({ ...item, text: item.text.trim(), sourceRefs: [...new Set(item.sourceRefs)] })),
    emotions: fields.emotions.map((item) => ({ ...item, label: item.label.trim(), sourceRefs: [...new Set(item.sourceRefs)] })),
    interests: fields.interests.map((item) => {
      const next = { ...item, label: item.label.trim(), sourceRefs: [...new Set(item.sourceRefs)] };
      if (item.description?.trim()) next.description = item.description.trim();
      else delete next.description;
      return next;
    }),
    participants: fields.participants.map((item) => {
      const participant = { ...item };
      if (item.role?.trim()) participant.role = item.role.trim();
      else delete participant.role;
      return participant;
    }),
    sourceRefs: [...new Set(fields.sourceRefs)], assetRefs: [...new Set(fields.assetRefs)]
  };
}

function completenessFor(fields: Pick<EventWriteFields, "title" | "occurredAt">, openClarificationCount: number) {
  const missingFields: string[] = [];
  if (!fields.title.trim()) missingFields.push("title");
  if (fields.occurredAt.kind === "unknown" || fields.occurredAt.kind === "relative") missingFields.push("occurredAt");
  return { missingFields, openClarificationCount };
}

const PREVIEW_MIME_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/webm",
  "video/mp4", "video/webm", "application/pdf", "application/json",
  "text/plain", "text/csv", "text/markdown"
]);

export interface JobHandlerContext {
  signal: AbortSignal;
  reportProgress(progress: number): void;
}

export type JobHandler = (job: Job, context: JobHandlerContext) => Promise<void>;

export interface JobRunnerOptions {
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  now?: () => Date;
  onChanged?: () => void;
}

export class JobRunner {
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly now: () => Date;
  private readonly onChanged: () => void;
  private pollTimer: NodeJS.Timeout | undefined;
  private runningAbort: AbortController | undefined;
  private draining = false;
  private stopped = true;

  constructor(
    private readonly repository: JobRepositoryPort,
    private readonly handlers: Readonly<Record<string, JobHandler>>,
    options: JobRunnerOptions = {}
  ) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.pollMs = options.pollMs ?? 1_000;
    this.now = options.now ?? (() => new Date());
    this.onChanged = options.onChanged ?? (() => undefined);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.pollTimer = setInterval(() => void this.drain(), this.pollMs);
    void this.drain();
  }

  wake(): void {
    if (!this.stopped) void this.drain();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.runningAbort?.abort();
  }

  private async drain(): Promise<void> {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped) {
        const now = this.now();
        const job = this.repository.claimNext(now.toISOString(), new Date(now.getTime() + this.leaseMs).toISOString());
        if (!job) break;
        this.onChanged();
        await this.run(job);
      }
    } finally {
      this.draining = false;
    }
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers[job.type];
    const abort = new AbortController();
    this.runningAbort = abort;
    const heartbeat = setInterval(() => {
      const now = this.now();
      this.repository.heartbeat(job.id, new Date(now.getTime() + this.leaseMs).toISOString(), now.toISOString());
    }, this.heartbeatMs);

    try {
      if (!handler) throw new Error(`No handler registered for ${job.type}`);
      await handler(job, {
        signal: abort.signal,
        reportProgress: (progress) => {
          this.repository.updateProgress(job.id, Math.min(1, Math.max(0, progress)), this.now().toISOString());
          this.onChanged();
        }
      });
      if (!this.stopped) this.repository.succeed(job.id, this.now().toISOString());
    } catch (error) {
      if (!this.stopped) {
        const now = this.now();
        const retryDelays = [1_000, 5_000];
        const attemptWithinCycle = (job.attempts - 1) % 3;
        const delay = retryDelays[attemptWithinCycle];
        const retryAt = delay === undefined ? undefined : new Date(now.getTime() + delay).toISOString();
        this.repository.fail(job.id, error instanceof Error ? error.message : "Job failed", now.toISOString(), retryAt);
      }
    } finally {
      clearInterval(heartbeat);
      this.runningAbort = undefined;
      this.onChanged();
    }
  }
}
