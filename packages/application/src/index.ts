import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate } from "node:timers";
import { lookup as lookupMimeType } from "mime-types";
import type {
  AgentExecutionMode, AgentModelCallAudit, AgentModelSettings, AgentRun, Asset, BackfillRun, CandidateDetail,
  Case, CaseBinderExportResult, CaseBinderPreview, CaseBinderProfile, CaseDetail, CaseRevision,
  CandidateExtraction, CandidateSummary, Clarification, Conversation, EmbeddingGeneration,
  EmbeddingIndexStatus, Event, EventRelation, EventRevision,
  DerivedArtifactDetail, EventSearchQuery, EvidenceDetail, EvidenceReferenceImpact, ImportIssue, ImportRun, ImportRunDetail, IntegrityScan, Job,
  LegalVerificationResult, Message, Person, PersonAlias,
  PersonIdentityDetail, PersonMergeRecord, PersonMergeSuggestion, ReviewRun, Source,
  SourceItem, SourceReferenceDetail, SourceVersion, TimelineQuery, TimelineResult,
  RecoveryPackageSummary, UnifiedSearchHit, UnifiedSearchQuery, Workspace, WorkspaceCryptoStatus,
  LocalProcessorStatus, MediaProcessingSettings, MediaProcessorKind, Reminder, ReviewAutomationSettings,
  WorkspaceLockState, WorkspaceSecuritySettings
} from "@grudge-vault/domain";
import {
  AppError, toSerializedError, type AssetImportResult, type AssetPreview,
  type BackupSummary, type ClarificationAnswerInput, type CreateEventInput,
  type AgentSettingsUpdateInput, type CandidateMergeInput, type CandidateMergeResult, type CreateRelationInput, type EventWriteFields,
  type CaseWriteFields, type CreateCaseInput, type UpdateCaseInput,
  type PersonAliasInput, type PersonMergeInput, type ReviewGenerateInput, type SendMessageInput,
  type SendMessageResult, type StartBackfillInput, type UpdateEventInput
} from "@grudge-vault/shared";
import {
  DeterministicEventDraftGenerator, parseConservativeTemporalValue, type EventCommitExtras,
  type AgentRepositoryPort, type EventDraftGeneratorPort, type EventDraftProposal, type MemoryRepositoryPort
} from "./memory";
import type { DayOneImporterPort, NormalizedDayOneEntry, NormalizedDayOneMedia } from "./dayone";
import {
  buildReviewPatterns, buildTimeline, cosineSimilarity, normalizeIdentity, personSuggestionScore,
  reciprocalRankFusion, relationSuggestions, REVIEW_GENERATOR_IDENTITY, REVIEW_GENERATOR_VERSION,
  type EmbeddingAdapterPort
} from "./phase3";
import {
  PhaseFiveService, type CaseSummaryPdfPort, type CryptoMigrationRecord,
  type LegalInformationAdapterPort, type PhaseFiveRepositoryPort
} from "./phase5";
import {
  DEFAULT_MEDIA_PROCESSING_SETTINGS, DEFAULT_REVIEW_AUTOMATION_SETTINGS,
  isoWeekScheduleKey, latestCompletedMonth, latestCompletedQuarter,
  type MediaPipelinePort, type PhaseSixRepositoryPort
} from "./phase6";

export * from "./memory";
export * from "./dayone";
export * from "./phase3";
export * from "./phase5";
export * from "./phase6";

export interface StoredObject {
  sha256: string;
  byteSize: number;
  vaultFormat: number;
  deduplicated: boolean;
}

export interface WorkspaceKeyRing {
  activeKeyId: string;
  legacyKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export type VaultKey = Buffer | WorkspaceKeyRing;

export interface ObjectVaultPort {
  put(inputPath: string, key: VaultKey): Promise<StoredObject>;
  putStream(input: Readable, key: VaultKey, expectedByteSize?: number, onProgress?: (progress: number) => void): Promise<StoredObject>;
  open(sha256: string, key: VaultKey): Promise<Readable>;
  verify(sha256: string, key: VaultKey, onProgress?: (progress: number) => void, expectedByteSize?: number): Promise<boolean>;
  migrate?(sha256: string, key: WorkspaceKeyRing, targetKeyId: string, onProgress?: (progress: number) => void): Promise<void>;
  keyId?(sha256: string, key: WorkspaceKeyRing): Promise<string>;
  exists(sha256: string): Promise<boolean>;
  remove(sha256: string): Promise<void>;
  cleanupTempFiles(): Promise<void>;
}

export interface AssetRepositoryPort {
  list(): Asset[];
  findById(id: string): Asset | undefined;
  upsert(asset: Asset): { asset: Asset; deduplicated: boolean };
  setIntegrity(id: string, status: Asset["integrityStatus"], verifiedAt?: string): Asset;
  setVaultFormat?(id: string, vaultFormat: number): Asset;
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
  cancel(id: string, now: string): Job;
  interrupt(id: string, error: string, now: string): Job;
}

export interface WorkspaceSession {
  workspace: Workspace;
  key: Buffer;
  keyRing?: WorkspaceKeyRing;
  assets: AssetRepositoryPort;
  jobs: JobRepositoryPort;
  memory: MemoryRepositoryPort;
  agents: AgentRepositoryPort;
  phase5?: PhaseFiveRepositoryPort;
  phase6?: PhaseSixRepositoryPort;
  dayOne: import("./dayone").DayOneRepositoryPort;
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
  status?(): WorkspaceLockState;
  lock?(): Promise<WorkspaceLockState>;
  unlock?(): Promise<WorkspaceSession>;
  getSecuritySettings?(): WorkspaceSecuritySettings;
  updateSecuritySettings?(settings: WorkspaceSecuritySettings): Promise<WorkspaceSecuritySettings>;
  exportRecovery?(path: string, passphrase: string): Promise<RecoveryPackageSummary>;
  recover?(path: string, passphrase: string): Promise<WorkspaceSession>;
  prepareKeyRotation?(): Promise<WorkspaceCryptoStatus>;
  completeKeyRotation?(targetKeyId: string): Promise<WorkspaceCryptoStatus>;
  getCryptoStatus?(): WorkspaceCryptoStatus;
  close(): Promise<void>;
}

export interface KeyProtectorPort {
  assertAvailable(): Promise<void>;
  protect(key: Buffer): Promise<string>;
  unprotect(envelope: string): Promise<{ key: Buffer; refreshedEnvelope?: string }>;
}

const AGENT_CONSENT_POLICY_VERSION = 1;

function normalizeCaseWriteFields(value: CaseWriteFields): CaseWriteFields {
  return {
    title: value.title, status: value.status, ...(value.summary !== undefined ? { summary: value.summary } : {}),
    jurisdiction: value.jurisdiction, asOfDate: value.asOfDate, eventRefs: value.eventRefs,
    personRefs: value.personRefs, sourceRefs: value.sourceRefs, assetRefs: value.assetRefs,
    amounts: value.amounts, disputePoints: value.disputePoints, questions: value.questions,
    materialGaps: value.materialGaps, evidenceLinks: value.evidenceLinks
  };
}

function normalizeAgentEndpoint(mode: AgentExecutionMode, baseUrl: string): string {
  const input = baseUrl.trim();
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new AppError("AGENT_MODEL_CONFIGURATION_INVALID", "The model base URL is invalid.", false, { cause });
  }
  if (url.username || url.password || url.search || url.hash || input.includes("?") || input.includes("#")) {
    throw new AppError("AGENT_MODEL_CONFIGURATION_INVALID", "Model URLs cannot contain credentials, query strings, or fragments.");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (mode === "private" && (!loopback.has(url.hostname) || !["http:", "https:"].includes(url.protocol))) {
    throw new AppError("AGENT_MODEL_CONFIGURATION_INVALID", "Private model endpoints must use HTTP(S) on loopback.");
  }
  if (mode === "enhanced" && url.protocol !== "https:") {
    throw new AppError("AGENT_MODEL_CONFIGURATION_INVALID", "Enhanced model endpoints must use HTTPS.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function encryptAgentCredential(value: string, key: Buffer, workspaceId: string, mode: AgentExecutionMode) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`grudge-vault:agent:${workspaceId}:${mode}:v1`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm" as const, version: 1 as const, iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64")
  };
}

function decryptAgentCredential(
  envelope: import("./memory").AgentCredentialEnvelope,
  key: Buffer,
  workspaceId: string,
  mode: AgentExecutionMode
): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(`grudge-vault:agent:${workspaceId}:${mode}:v1`, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()
    ]).toString("utf8");
  } catch (cause) {
    throw new AppError("AGENT_MODEL_CONFIGURATION_INVALID", "The stored model credential could not be decrypted.", false, { cause });
  }
}

export class GrudgeVaultApplication {
  private readonly phaseFive: PhaseFiveService;

  constructor(
    private readonly workspaces: WorkspaceManagerPort,
    private readonly draftGenerator: EventDraftGeneratorPort = new DeterministicEventDraftGenerator(),
    private readonly dayOneImporter?: DayOneImporterPort,
    private readonly embeddingAdapter?: EmbeddingAdapterPort,
    phaseFiveOptions: { pdf?: CaseSummaryPdfPort; legal?: LegalInformationAdapterPort } = {},
    private readonly mediaPipeline?: MediaPipelinePort
  ) {
    this.phaseFive = new PhaseFiveService(() => {
      const session = this.requireSession();
      if (!session.phase5) throw new AppError("INTERNAL_ERROR", "Phase 5 storage is unavailable.");
      return {
        workspaceId: session.workspace.id, workspaceRoot: session.workspace.rootPath,
        key: session.keyRing ?? session.key,
        assets: session.assets, memory: session.memory, phase5: session.phase5, vault: session.vault
      };
    }, phaseFiveOptions.pdf, phaseFiveOptions.legal);
  }

  getCurrentWorkspace(): Workspace | null {
    return this.workspaces.current()?.workspace ?? null;
  }

  getWorkspaceStatus(): WorkspaceLockState {
    return this.workspaces.status?.() ?? (this.getCurrentWorkspace() ? { status: "open", workspace: this.getCurrentWorkspace()! } : { status: "closed" });
  }

  lockWorkspace(): Promise<WorkspaceLockState> {
    if (!this.workspaces.lock) throw new AppError("INTERNAL_ERROR", "Workspace locking is unavailable.");
    return this.workspaces.lock();
  }

  async unlockWorkspace(): Promise<Workspace> {
    if (!this.workspaces.unlock) throw new AppError("INTERNAL_ERROR", "Workspace unlocking is unavailable.");
    return (await this.workspaces.unlock()).workspace;
  }

  getWorkspaceSecuritySettings(): WorkspaceSecuritySettings {
    return this.workspaces.getSecuritySettings?.() ?? { autoLockMinutes: 15, integrityScanIntervalDays: 30 };
  }

  updateWorkspaceSecuritySettings(settings: WorkspaceSecuritySettings): Promise<WorkspaceSecuritySettings> {
    if (!this.workspaces.updateSecuritySettings) throw new AppError("INTERNAL_ERROR", "Workspace security settings are unavailable.");
    return this.workspaces.updateSecuritySettings(settings);
  }

  exportWorkspaceRecovery(path: string, passphrase: string): Promise<RecoveryPackageSummary> {
    if (!this.workspaces.exportRecovery) throw new AppError("INTERNAL_ERROR", "Workspace recovery export is unavailable.");
    return this.workspaces.exportRecovery(path, passphrase);
  }

  async recoverWorkspace(path: string, passphrase: string): Promise<Workspace> {
    if (!this.workspaces.recover) throw new AppError("INTERNAL_ERROR", "Workspace recovery is unavailable.");
    return (await this.workspaces.recover(path, passphrase)).workspace;
  }

  getWorkspaceCryptoStatus(): WorkspaceCryptoStatus {
    if (!this.workspaces.getCryptoStatus) throw new AppError("INTERNAL_ERROR", "Workspace crypto status is unavailable.");
    const status = this.workspaces.getCryptoStatus();
    const migration = this.workspaces.current()?.phase5?.getActiveCryptoMigration();
    return migration ? {
      ...status, migrationState: migration.state === "succeeded" ? "idle" : migration.state, processedObjects: migration.processedObjects,
      totalObjects: migration.totalObjects, ...(migration.lastError ? { lastError: migration.lastError } : {})
    } : status;
  }

  async rotateWorkspaceKey(): Promise<WorkspaceCryptoStatus> {
    if (!this.workspaces.prepareKeyRotation) throw new AppError("INTERNAL_ERROR", "Workspace Key rotation is unavailable.");
    const status = await this.workspaces.prepareKeyRotation();
    const session = this.requireSession();
    const now = new Date().toISOString();
    const totalObjects = session.assets.list().filter(({ availabilityStatus }) => availabilityStatus !== "deleted").length
      + (session.phase5?.listDerivedArtifacts().length ?? 0);
    session.phase5?.saveCryptoMigration({
      id: randomUUID(), fromKeyId: status.retiringKeyIds[0] ?? status.activeKeyId, toKeyId: status.activeKeyId,
      state: "queued", processedObjects: 0,
      totalObjects,
      createdAt: now, updatedAt: now
    });
    session.jobs.enqueue("workspace.crypto-migrate", { targetKeyId: status.activeKeyId }, new Date().toISOString(), 10);
    return status;
  }

  ensureWorkspaceCryptoMigration(): Job | undefined {
    const session = this.requireSession();
    const status = this.getWorkspaceCryptoStatus();
    if (status.migrationState === "idle") return undefined;
    if (session.jobs.list().some(({ type, state }) => type === "workspace.crypto-migrate" && (state === "queued" || state === "running"))) {
      return undefined;
    }
    const now = new Date().toISOString();
    if (!session.phase5?.getActiveCryptoMigration()) {
      const totalObjects = session.assets.list().filter(({ availabilityStatus }) => availabilityStatus !== "deleted").length
        + (session.phase5?.listDerivedArtifacts().length ?? 0);
      session.phase5?.saveCryptoMigration({
        id: randomUUID(), fromKeyId: status.retiringKeyIds[0] ?? status.activeKeyId, toKeyId: status.activeKeyId,
        state: "queued", processedObjects: 0, totalObjects, createdAt: now, updatedAt: now
      });
    }
    return session.jobs.enqueue("workspace.crypto-migrate", { targetKeyId: status.activeKeyId }, now, 10);
  }

  async runWorkspaceCryptoMigration(targetKeyId: string, context: JobHandlerContext): Promise<void> {
    const session = this.requireSession();
    const ring = session.keyRing;
    const repository = session.phase5;
    if (!ring || !session.vault.migrate || !repository) throw new AppError("CRYPTO_MIGRATION_CONFLICT", "The versioned Object Vault is unavailable.");
    const objects: Array<{ cursorId: string; sha256: string; assetId?: string }> = [
      ...session.assets.list().filter(({ availabilityStatus }) => availabilityStatus !== "deleted")
        .map(({ id, sha256 }) => ({ cursorId: `asset:${id}`, sha256, assetId: id })),
      ...repository.listDerivedArtifacts().map(({ id, sha256 }) => ({ cursorId: `derived:${id}`, sha256 }))
    ].sort((a, b) => a.cursorId.localeCompare(b.cursorId));
    const now = new Date().toISOString();
    let migration: CryptoMigrationRecord = repository.getActiveCryptoMigration() ?? {
      id: randomUUID(), fromKeyId: ring.legacyKeyId, toKeyId: targetKeyId, state: "queued",
      processedObjects: 0, totalObjects: objects.length, createdAt: now, updatedAt: now
    };
    if (migration.toKeyId !== targetKeyId) throw new AppError("CRYPTO_MIGRATION_CONFLICT", "Another key migration is active.");
    migration = repository.saveCryptoMigration({ ...migration, state: "running", totalObjects: objects.length, updatedAt: now, lastError: undefined });
    const start = migration.cursor ? Math.max(0, objects.findIndex(({ cursorId }) => cursorId === migration.cursor) + 1) : 0;
    try {
      for (let index = start; index < objects.length; index += 1) {
        if (context.signal.aborted) throw new Error("Workspace crypto migration interrupted.");
        const object = objects[index]!;
        await session.vault.migrate(object.sha256, ring, targetKeyId, (progress) =>
          context.reportProgress((index + progress) / Math.max(1, objects.length)));
        if (object.assetId) session.assets.setVaultFormat?.(object.assetId, 2);
        migration = repository.saveCryptoMigration({ ...migration, cursor: object.cursorId, processedObjects: index + 1, updatedAt: new Date().toISOString() });
      }
      if (session.vault.keyId) {
        for (const object of objects) {
          if (await session.vault.keyId(object.sha256, ring) !== targetKeyId) {
            throw new AppError("CRYPTO_MIGRATION_CONFLICT", "An object still uses a retiring Workspace Key.");
          }
        }
      }
      this.reencryptAgentCredentials(targetKeyId);
      if (!this.workspaces.completeKeyRotation) throw new AppError("CRYPTO_MIGRATION_CONFLICT", "Workspace Key finalization is unavailable.");
      await this.workspaces.completeKeyRotation(targetKeyId);
      const finishedAt = new Date().toISOString();
      repository.saveCryptoMigration({ ...migration, state: "succeeded", processedObjects: objects.length,
        totalObjects: objects.length, updatedAt: finishedAt, finishedAt });
      context.reportProgress(1);
    } catch (error) {
      repository.saveCryptoMigration({ ...migration, state: "failed", lastError: error instanceof Error ? error.message : "Migration failed",
        updatedAt: new Date().toISOString() });
      throw error;
    }
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

  recordConversationMessage(conversationId: string, role: Message["role"], content: string): Message {
    const normalized = content.trim();
    if (!normalized) throw new AppError("VALIDATION_FAILED", "Message content is required.");
    const now = new Date().toISOString();
    const message: Message = {
      id: randomUUID(), conversationId, sourceItemId: randomUUID(), role, content: normalized, createdAt: now
    };
    return this.requireSession().memory.appendMessage(message, {
      id: message.sourceItemId, sourceId: "", externalId: message.id, content: normalized, recordedAt: now, assetRefs: []
    });
  }

  listAgentRuns(conversationId: string): AgentRun[] {
    return this.requireSession().agents.listRuns(conversationId);
  }

  getAgentRun(id: string): AgentRun {
    const run = this.requireSession().agents.getRun(id);
    if (!run) throw new AppError("ENTITY_NOT_FOUND", "The Agent run no longer exists.");
    return run;
  }

  saveAgentRun(run: AgentRun): AgentRun {
    return this.requireSession().agents.saveRun(run);
  }

  listAgentModelCallAudits(runId: string): AgentModelCallAudit[] {
    return this.requireSession().agents.listModelCallAudits(runId);
  }

  saveAgentModelCallAudit(audit: AgentModelCallAudit): AgentModelCallAudit {
    return this.requireSession().agents.saveModelCallAudit(audit);
  }

  getAgentSettings(): AgentModelSettings {
    const repository = this.requireSession().agents;
    const stored = repository.getSettings() ?? {
      mode: "private" as const, consentPolicyVersion: AGENT_CONSENT_POLICY_VERSION, consentedDataCategories: []
    };
    const withCredential = (mode: AgentExecutionMode, endpoint: AgentModelSettings["privateEndpoint"]) => endpoint
      ? { ...endpoint, credentialConfigured: Boolean(repository.getCredential(mode)) }
      : undefined;
    const privateEndpoint = withCredential("private", stored.privateEndpoint);
    const enhancedEndpoint = withCredential("enhanced", stored.enhancedEndpoint);
    return {
      mode: stored.mode, consentPolicyVersion: AGENT_CONSENT_POLICY_VERSION,
      consentedDataCategories: stored.consentPolicyVersion === AGENT_CONSENT_POLICY_VERSION
        ? stored.consentedDataCategories : [],
      ...(privateEndpoint ? { privateEndpoint } : {}),
      ...(enhancedEndpoint ? { enhancedEndpoint } : {})
    };
  }

  updateAgentSettings(input: AgentSettingsUpdateInput): AgentModelSettings {
    const session = this.requireSession();
    const repository = session.agents;
    const current = this.getAgentSettings();
    const updateEndpoint = (mode: AgentExecutionMode, value: typeof input.privateEndpoint) => {
      const previous = mode === "private" ? current.privateEndpoint : current.enhancedEndpoint;
      if (!value) return previous;
      const baseUrl = normalizeAgentEndpoint(mode, value.baseUrl);
      const model = value.model.trim();
      if (!model || model.length > 200) {
        throw new AppError("AGENT_MODEL_CONFIGURATION_INVALID", "A model name is required.");
      }
      if (value.clearCredential) repository.saveCredential(mode, undefined, new Date().toISOString());
      if (value.apiKey !== undefined) {
        const apiKey = value.apiKey.trim();
        if (!apiKey || apiKey.length > 10_000) {
          throw new AppError("AGENT_MODEL_CONFIGURATION_INVALID", "The model credential is invalid.");
        }
        const encryptionKey = session.keyRing?.keys.get(session.keyRing.activeKeyId) ?? session.key;
        repository.saveCredential(mode, encryptAgentCredential(apiKey, encryptionKey, session.workspace.id, mode), new Date().toISOString());
      }
      return { baseUrl, model, credentialConfigured: Boolean(repository.getCredential(mode)) };
    };
    const privateEndpoint = updateEndpoint("private", input.privateEndpoint);
    const enhancedEndpoint = updateEndpoint("enhanced", input.enhancedEndpoint);
    if (input.mode === "enhanced" && !enhancedEndpoint) {
      throw new AppError("AGENT_MODEL_CONFIGURATION_INVALID", "Configure an Enhanced model endpoint before enabling it.");
    }
    repository.saveSettings({
      mode: input.mode, consentPolicyVersion: AGENT_CONSENT_POLICY_VERSION,
      consentedDataCategories: input.consentedDataCategories ?? current.consentedDataCategories,
      ...(privateEndpoint ? { privateEndpoint } : {}),
      ...(enhancedEndpoint ? { enhancedEndpoint } : {})
    }, new Date().toISOString());
    return this.getAgentSettings();
  }

  clearAgentCredential(mode: AgentExecutionMode): AgentModelSettings {
    this.requireSession().agents.saveCredential(mode, undefined, new Date().toISOString());
    const current = this.getAgentSettings();
    this.requireSession().agents.saveSettings(current, new Date().toISOString());
    return this.getAgentSettings();
  }

  getAgentCredential(mode: AgentExecutionMode): string | undefined {
    const session = this.requireSession();
    const envelope = session.agents.getCredential(mode);
    if (!envelope) return undefined;
    const candidates = session.keyRing ? [...session.keyRing.keys.values()] : [session.key];
    for (const key of candidates) {
      try { return decryptAgentCredential(envelope, key, session.workspace.id, mode); } catch { /* try the next retained key */ }
    }
    throw new AppError("AGENT_MODEL_CONFIGURATION_INVALID", "The stored model credential could not be decrypted with the current key ring.");
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
    const memory = this.requireSession().memory;
    if (!query.personId) return memory.searchEvents(query);
    return memory.searchEvents({ ...query, personIds: memory.listIdentityPersonIds(query.personId) });
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
    const session = this.requireSession();
    const current = this.getCurrentEvent(input.eventId);
    this.assertRevision(current, input.expectedRevision);
    const candidate = session.dayOne.getCandidate(input.eventId, (eventId) => session.memory.getEventDetail(eventId));
    if (candidate?.extraction.reviewState === "pending" && input.status !== "candidate") {
      throw new AppError("CANDIDATE_STATE_CONFLICT", "Confirm, ignore, or merge a Day One candidate through its review action.");
    }
    if (candidate && ["ignored", "merged", "superseded"].includes(candidate.extraction.reviewState)) {
      throw new AppError("CANDIDATE_STATE_CONFLICT", "This Day One candidate has already been closed by review.");
    }
    return this.commitRevision(current, input, input.reason);
  }

  proposeAgentEvent(fields: EventWriteFields, sourceRef: string): Event {
    const now = new Date().toISOString();
    return this.commitNewEvent({
      ...fields, status: "candidate", sourceRefs: [...new Set([...fields.sourceRefs, sourceRef])]
    }, "Agent proposal approved by user", now, {}, "agent");
  }

  updateEventFromAgent(input: UpdateEventInput, sourceRef: string): Event {
    const current = this.getCurrentEvent(input.eventId);
    this.assertRevision(current, input.expectedRevision);
    return this.commitRevision(current, {
      ...input, sourceRefs: [...new Set([...input.sourceRefs, sourceRef])]
    }, input.reason || "Agent update approved by user", "agent");
  }

  answerClarificationFromAgent(
    clarificationId: string,
    answer: string,
    expectedRevision: number,
    answerSourceRef: string
  ): Event {
    const memory = this.requireSession().memory;
    const clarification = memory.getClarification(clarificationId);
    if (!clarification) throw new AppError("ENTITY_NOT_FOUND", "The clarification no longer exists.");
    if (clarification.status !== "open") throw new AppError("AGENT_ACTION_CONFLICT", "The clarification is already closed.");
    const current = this.getCurrentEvent(clarification.eventId);
    this.assertRevision(current, expectedRevision);
    const now = new Date().toISOString();
    const next = this.eventWithFields(current, {
      ...current, sourceRefs: [...new Set([...current.sourceRefs, answerSourceRef])]
    }, now, -1);
    return memory.commitEvent(next, this.revisionFor(
      current, next, "Clarification answered through Agent", [answerSourceRef], now, "agent"
    ), { clarifications: [{
      ...clarification, status: "answered", answerSourceRef,
      sourceRefs: [...new Set([...clarification.sourceRefs, answerSourceRef])], updatedAt: now
    }] });
  }

  confirmEvent(id: string, expectedRevision: number): Event {
    const session = this.requireSession();
    const candidate = session.dayOne.getCandidate(id, (eventId) => session.memory.getEventDetail(eventId));
    if (candidate?.extraction.reviewState === "pending") return this.confirmCandidate(id, expectedRevision);
    if (candidate) throw new AppError("CANDIDATE_STATE_CONFLICT", "This Day One candidate has already been reviewed.");
    return this.changeEventStatus(id, expectedRevision, "confirmed", "Confirmed by user");
  }

  archiveEvent(id: string, expectedRevision: number): Event {
    const session = this.requireSession();
    const candidate = session.dayOne.getCandidate(id, (eventId) => session.memory.getEventDetail(eventId));
    if (candidate?.extraction.reviewState === "pending") return this.ignoreCandidate(id, expectedRevision);
    if (candidate && candidate.extraction.reviewState !== "confirmed") {
      throw new AppError("CANDIDATE_STATE_CONFLICT", "This Day One candidate has already been closed by review.");
    }
    return this.changeEventStatus(id, expectedRevision, "archived", "Archived by user");
  }

  listPeople(includeArchived = false): Person[] {
    return this.requireSession().memory.listPeople(includeArchived);
  }

  listPersonIdentities(): PersonIdentityDetail[] {
    const memory = this.requireSession().memory;
    const canonicalIds = [...new Set(memory.listPeople().map(({ id }) => memory.resolveCanonicalPersonId(id)))];
    return canonicalIds.map((id) => this.getPersonIdentity(id));
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

  getPersonIdentity(id: string): PersonIdentityDetail {
    const memory = this.requireSession().memory;
    const canonicalId = memory.resolveCanonicalPersonId(id);
    const canonicalPerson = memory.getPerson(canonicalId);
    if (!canonicalPerson) throw new AppError("ENTITY_NOT_FOUND", "The person no longer exists.");
    const memberIds = memory.listIdentityPersonIds(canonicalId);
    const identities = memberIds.map((personId) => memory.getPerson(personId)).filter((person): person is Person => Boolean(person));
    return {
      canonicalPerson, identities,
      aliases: memberIds.flatMap((personId) => memory.listPersonAliases(personId, true)),
      events: memory.searchEvents({ personIds: memberIds, limit: 200 }),
      activeMerges: memory.listPersonMergeRecords().filter((record) =>
        memberIds.includes(record.sourcePersonId) || memberIds.includes(record.targetPersonId))
    };
  }

  addPersonAlias(input: PersonAliasInput): PersonAlias {
    const memory = this.requireSession().memory;
    if (!memory.getPerson(input.personId)) throw new AppError("ENTITY_NOT_FOUND", "The person no longer exists.");
    const value = input.value.trim();
    const normalizedValue = normalizeIdentity(value);
    if (!normalizedValue) throw new AppError("VALIDATION_FAILED", "An alias must contain letters or numbers.");
    const now = new Date().toISOString();
    return memory.createPersonAlias({
      id: randomUUID(), personId: input.personId, value, normalizedValue,
      sourceRefs: [...new Set(input.sourceRefs ?? [])], status: "active", createdAt: now, updatedAt: now
    });
  }

  deactivatePersonAlias(id: string): PersonAlias {
    return this.requireSession().memory.deactivatePersonAlias(id, new Date().toISOString());
  }

  listPersonMergeSuggestions(): PersonMergeSuggestion[] {
    const memory = this.requireSession().memory;
    const people = memory.listPeople().filter(({ status }) => status === "active");
    const aliases = memory.listPersonAliases();
    const now = new Date().toISOString();
    for (let leftIndex = 0; leftIndex < people.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < people.length; rightIndex += 1) {
        const left = people[leftIndex]!;
        const right = people[rightIndex]!;
        if (memory.resolveCanonicalPersonId(left.id) === memory.resolveCanonicalPersonId(right.id)) continue;
        const match = personSuggestionScore(
          left, aliases.filter(({ personId }) => personId === left.id),
          right, aliases.filter(({ personId }) => personId === right.id)
        );
        if (!match) continue;
        const [personAId, personBId] = [left.id, right.id].sort();
        memory.upsertPersonMergeSuggestion({
          id: randomUUID(), personAId: personAId!, personBId: personBId!, score: match.score, basis: match.basis,
          algorithmIdentity: "local.person-identity-match", algorithmVersion: 1,
          status: "pending", createdAt: now, updatedAt: now
        });
      }
    }
    return memory.listPersonMergeSuggestions();
  }

  rejectPersonMergeSuggestion(id: string): PersonMergeSuggestion {
    return this.requireSession().memory.updatePersonMergeSuggestion(id, "rejected", new Date().toISOString());
  }

  mergePeople(input: PersonMergeInput): PersonMergeRecord {
    const memory = this.requireSession().memory;
    const sourceInput = memory.getPerson(input.sourcePersonId);
    const targetInput = memory.getPerson(input.targetPersonId);
    if (!sourceInput || !targetInput) {
      throw new AppError("ENTITY_NOT_FOUND", "One of the people no longer exists.");
    }
    if (sourceInput.status !== "active" || targetInput.status !== "active") {
      throw new AppError("PERSON_MERGE_CONFLICT", "Archived people cannot participate in an identity merge.");
    }
    const sourcePersonId = memory.resolveCanonicalPersonId(input.sourcePersonId);
    const targetPersonId = memory.resolveCanonicalPersonId(input.targetPersonId);
    if (sourcePersonId === targetPersonId) throw new AppError("PERSON_MERGE_CONFLICT", "These people already resolve to one identity.");
    const now = new Date().toISOString();
    const record: PersonMergeRecord = {
      id: randomUUID(), sourcePersonId, targetPersonId, status: "active", createdAt: now,
      ...(input.suggestionId ? { suggestionId: input.suggestionId } : {})
    };
    const saved = memory.createPersonMerge(record);
    if (input.suggestionId) memory.updatePersonMergeSuggestion(input.suggestionId, "confirmed", now, saved.id);
    return saved;
  }

  revertPersonMerge(id: string): PersonMergeRecord {
    const memory = this.requireSession().memory;
    const existing = memory.listPersonMergeRecords(true).find((record) => record.id === id);
    if (!existing) throw new AppError("ENTITY_NOT_FOUND", "The identity merge no longer exists.");
    const now = new Date().toISOString();
    const reverted = memory.revertPersonMerge(id, now);
    if (existing.suggestionId) memory.updatePersonMergeSuggestion(existing.suggestionId, "pending", now);
    return reverted;
  }

  listEventRelations(eventId: string): EventRelation[] {
    if (!this.requireSession().memory.getEvent(eventId)) throw new AppError("ENTITY_NOT_FOUND", "The event no longer exists.");
    return this.requireSession().memory.listEventRelations(eventId);
  }

  refreshRelationSuggestions(): EventRelation[] {
    const memory = this.requireSession().memory;
    const now = new Date().toISOString();
    const events = memory.searchEvents({ status: "confirmed", limit: 200 });
    for (const suggestion of relationSuggestions(events, (id) => memory.resolveCanonicalPersonId(id), now)) {
      const normalized = suggestion.kind !== "precedes" && suggestion.sourceEventId > suggestion.targetEventId
        ? {
            ...suggestion, sourceEventId: suggestion.targetEventId, targetEventId: suggestion.sourceEventId,
            sourceRevision: suggestion.targetRevision, targetRevision: suggestion.sourceRevision
          }
        : suggestion;
      memory.upsertEventRelation(normalized);
    }
    return memory.listEventRelations();
  }

  createEventRelation(input: CreateRelationInput): EventRelation {
    const memory = this.requireSession().memory;
    const source = memory.getEvent(input.sourceEventId);
    const target = memory.getEvent(input.targetEventId);
    if (!source || !target) throw new AppError("ENTITY_NOT_FOUND", "One of the events no longer exists.");
    if (source.id === target.id) throw new AppError("VALIDATION_FAILED", "An event cannot relate to itself.");
    let sourceEventId = source.id;
    let targetEventId = target.id;
    if (input.kind !== "precedes" && sourceEventId > targetEventId) [sourceEventId, targetEventId] = [targetEventId, sourceEventId];
    const sourceEvent = memory.getEvent(sourceEventId)!;
    const targetEvent = memory.getEvent(targetEventId)!;
    const now = new Date().toISOString();
    return memory.upsertEventRelation({
      id: randomUUID(), sourceEventId, targetEventId, kind: input.kind, status: "confirmed", origin: "user",
      basis: [{ kind: "source", label: "用户手工关联", personIds: [], eventIds: [sourceEventId, targetEventId],
        sourceRefs: [...new Set([...sourceEvent.sourceRefs, ...targetEvent.sourceRefs])] }],
      sourceRevision: sourceEvent.currentRevision, targetRevision: targetEvent.currentRevision,
      createdAt: now, updatedAt: now
    });
  }

  confirmEventRelation(id: string): EventRelation {
    const memory = this.requireSession().memory;
    const relation = memory.getEventRelation(id);
    if (!relation) throw new AppError("ENTITY_NOT_FOUND", "The event relation no longer exists.");
    if (relation.status === "rejected") throw new AppError("RELATION_STATE_CONFLICT", "A rejected relation must be recreated manually.");
    return memory.updateEventRelationStatus(id, "confirmed", new Date().toISOString());
  }

  rejectEventRelation(id: string): EventRelation {
    const memory = this.requireSession().memory;
    const relation = memory.getEventRelation(id);
    if (!relation) throw new AppError("ENTITY_NOT_FOUND", "The event relation no longer exists.");
    return memory.updateEventRelationStatus(id, "rejected", new Date().toISOString());
  }

  removeEventRelation(id: string): void {
    const memory = this.requireSession().memory;
    const relation = memory.getEventRelation(id);
    if (!relation) throw new AppError("ENTITY_NOT_FOUND", "The event relation no longer exists.");
    if (relation.origin !== "user") throw new AppError("RELATION_STATE_CONFLICT", "Algorithm suggestions must be rejected instead of deleted.");
    memory.deleteEventRelation(id);
  }

  queryTimeline(query: TimelineQuery): TimelineResult {
    const memory = this.requireSession().memory;
    const search: EventSearchQuery = {
      limit: 200, ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {})
    };
    if (query.status) search.status = query.status;
    if (query.personId) search.personIds = memory.listIdentityPersonIds(query.personId);
    const events = memory.searchEvents(search).filter(({ status }) =>
      query.includeArchived || query.status === "archived" || status !== "archived");
    return buildTimeline(events, query);
  }

  async unifiedSearch(query: UnifiedSearchQuery): Promise<UnifiedSearchHit[]> {
    const memory = this.requireSession().memory;
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const keyword = memory.searchUnifiedKeyword({ ...query, limit: Math.max(limit, 100) });
    const enabled = memory.getSetting<boolean>("search.semantic_enabled") ?? false;
    const active = memory.listEmbeddingGenerations().find(({ state }) => state === "active");
    if (!query.semantic || !enabled || !this.embeddingAdapter || !active || !query.text.trim()
      || active.adapterIdentity !== this.embeddingAdapter.identity || active.adapterVersion !== this.embeddingAdapter.version) {
      return keyword.slice(0, limit).map((hit, index) => ({ ...hit, combinedScore: 0.7 / (61 + index) }));
    }
    const [queryVector] = await this.embeddingAdapter.embed([query.text]);
    if (!queryVector || queryVector.length !== this.embeddingAdapter.dimensions) {
      return keyword.slice(0, limit).map((hit, index) => ({ ...hit, combinedScore: 0.7 / (61 + index) }));
    }
    const eligible = new Map(memory.searchUnifiedKeyword({ ...query, text: "", semantic: false, limit: 200 })
      .map((hit) => [`${hit.kind}:${hit.id}`, hit]));
    const semantic = memory.listEmbeddings(active.id).flatMap(({ document, vector }) => {
      const base = eligible.get(`${document.kind}:${document.id}`);
      if (!base) return [];
      return [{ ...base, semanticScore: cosineSimilarity(queryVector, vector), combinedScore: 0 }];
    }).sort((a, b) => (b.semanticScore ?? 0) - (a.semanticScore ?? 0));
    return reciprocalRankFusion(keyword, semantic, limit);
  }

  getEmbeddingStatus(): EmbeddingIndexStatus {
    const memory = this.requireSession().memory;
    const enabled = memory.getSetting<boolean>("search.semantic_enabled") ?? false;
    const generations = memory.listEmbeddingGenerations();
    const active = generations.find(({ state }) => state === "active");
    const building = generations.find(({ state }) => state === "building");
    const failed = generations.find(({ state }) => state === "failed");
    if (!this.embeddingAdapter) return { available: false, enabled, documentCount: 0, state: "unavailable" };
    return {
      available: true, enabled, adapterIdentity: this.embeddingAdapter.identity,
      adapterVersion: this.embeddingAdapter.version, dimensions: this.embeddingAdapter.dimensions,
      ...(active ? { activeGenerationId: active.id } : {}), documentCount: active?.documentCount ?? 0,
      state: !enabled ? "disabled" : building ? "building" : active ? "ready" : failed ? "failed" : "empty",
      ...(failed?.lastError && !active ? { lastError: failed.lastError } : {})
    };
  }

  setSemanticEnabled(enabled: boolean): EmbeddingIndexStatus {
    this.requireSession().memory.setSetting("search.semantic_enabled", enabled, new Date().toISOString());
    return this.getEmbeddingStatus();
  }

  rebuildEmbeddings(): Job {
    if (!this.embeddingAdapter) throw new AppError("EMBEDDING_UNAVAILABLE", "No local embedding adapter is configured.");
    const session = this.requireSession();
    const now = new Date().toISOString();
    const generation: EmbeddingGeneration = {
      id: randomUUID(), adapterIdentity: this.embeddingAdapter.identity, adapterVersion: this.embeddingAdapter.version,
      dimensions: this.embeddingAdapter.dimensions, state: "building", documentCount: 0, createdAt: now
    };
    session.memory.createEmbeddingGeneration(generation);
    return session.jobs.enqueue("search.embedding-rebuild", { generationId: generation.id }, now, 1);
  }

  async runEmbeddingRebuild(generationId: string, context: JobHandlerContext): Promise<void> {
    if (!this.embeddingAdapter) throw new AppError("EMBEDDING_UNAVAILABLE", "No local embedding adapter is configured.");
    const memory = this.requireSession().memory;
    const generation = memory.listEmbeddingGenerations().find(({ id }) => id === generationId);
    if (!generation || generation.state !== "building") throw new AppError("VALIDATION_FAILED", "The embedding generation is unavailable.");
    const documents = memory.listSearchDocuments();
    try {
      const batchSize = 32;
      for (let index = 0; index < documents.length; index += batchSize) {
        if (context.signal.aborted) throw new Error("Embedding rebuild interrupted.");
        const batch = documents.slice(index, index + batchSize);
        const vectors = await this.embeddingAdapter.embed(batch.map(({ content }) => content));
        if (vectors.length !== batch.length || vectors.some(({ length }) => length !== this.embeddingAdapter!.dimensions)) {
          throw new Error("The embedding adapter returned an incompatible vector batch.");
        }
        batch.forEach((document, vectorIndex) => memory.putEmbedding(generationId, document, vectors[vectorIndex]!));
        context.reportProgress(documents.length ? Math.min(0.99, (index + batch.length) / documents.length) : 0.99);
      }
      memory.activateEmbeddingGeneration(generationId, documents.length, new Date().toISOString());
      context.reportProgress(1);
    } catch (error) {
      memory.failEmbeddingGeneration(generationId, error instanceof Error ? error.message : "Embedding rebuild failed.");
      throw error;
    }
  }

  listReviews(): ReviewRun[] {
    return this.requireSession().memory.listReviews().map((review) => this.reviewWithStale(review));
  }

  getReview(id: string): ReviewRun {
    const review = this.requireSession().memory.getReview(id);
    if (!review) throw new AppError("ENTITY_NOT_FOUND", "The review no longer exists.");
    return this.reviewWithStale(review);
  }

  generateReview(input: ReviewGenerateInput): ReviewRun {
    if (input.from > input.to) throw new AppError("VALIDATION_FAILED", "The review start must not be after its end.");
    const memory = this.requireSession().memory;
    const events = memory.searchEvents({ status: "confirmed", from: input.from, to: input.to, limit: 200 });
    const relations = memory.listEventRelations(undefined, true).filter(({ sourceEventId, targetEventId, status }) =>
      status !== "rejected" && events.some(({ id }) => id === sourceEventId) && events.some(({ id }) => id === targetEventId));
    const people = new Map(memory.listPeople(true).map((person) => [person.id, person]));
    const participantIds = [...new Set(events.flatMap(({ participants }) => participants.map(({ personId }) => personId)))];
    const canonicalPeople = new Map(participantIds.map((id) => [id, memory.resolveCanonicalPersonId(id)]));
    const inputHash = this.reviewInputHash(events, relations, canonicalPeople);
    const now = new Date().toISOString();
    const review: ReviewRun = {
      id: randomUUID(), from: input.from, to: input.to,
      generatorIdentity: REVIEW_GENERATOR_IDENTITY, generatorVersion: REVIEW_GENERATOR_VERSION, inputHash,
      patterns: buildReviewPatterns(events, relations, (id) => canonicalPeople.get(id) ?? id, people),
      eventIds: events.map(({ id }) => id), sourceRefs: [...new Set(events.flatMap(({ sourceRefs }) => sourceRefs))],
      createdAt: now, stale: false
    };
    return memory.saveReview(review);
  }

  getSourceReference(id: string): SourceReferenceDetail {
    const detail = this.requireSession().memory.getSourceReference(id);
    if (!detail) throw new AppError("ENTITY_NOT_FOUND", "The source record no longer exists.");
    return detail;
  }

  setClarificationPriority(id: string, priority: Clarification["priority"]): Clarification {
    return this.requireSession().memory.setClarificationPriority(id, priority, new Date().toISOString());
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
      const stored = await session.vault.put(filePath, session.keyRing ?? session.key);
      const now = new Date().toISOString();
      const candidate: Asset = {
        id: randomUUID(), sha256: stored.sha256, byteSize: stored.byteSize,
        mimeType: lookupMimeType(filePath) || "application/octet-stream",
        originalFileName: basename(filePath), vaultFormat: stored.vaultFormat,
        integrityStatus: "pending", availabilityStatus: "available", createdAt: now
      };
      const result = session.assets.upsert(candidate);
      if (!result.deduplicated) {
        session.jobs.enqueue("asset.verify", { assetId: result.asset.id, sha256: result.asset.sha256 }, now);
        await this.enqueueAutomaticMedia(result.asset);
      }
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("ASSET_IMPORT_FAILED", "The file could not be stored in the vault.", true, { cause: error });
    }
  }

  async createDayOneImport(filePath: string): Promise<ImportRun> {
    const imported = await this.importAsset(filePath);
    return this.createDayOneImportForAsset(imported.asset);
  }

  private createDayOneImportForAsset(asset: Asset): ImportRun {
    const now = new Date().toISOString();
    const run: ImportRun = {
      id: randomUUID(), archiveAssetId: asset.id, archiveFileName: asset.originalFileName,
      state: "queued", progress: 0,
      counts: { totalEntries: 0, newEntries: 0, updatedEntries: 0, skippedEntries: 0, mediaImported: 0, mediaMissing: 0, errorCount: 0 },
      createdAt: now, updatedAt: now
    };
    const session = this.requireSession();
    session.dayOne.createImportRun(run);
    session.jobs.enqueue("dayone.import", { importRunId: run.id }, now, 1);
    return run;
  }

  listImportRuns(): ImportRun[] {
    return this.requireSession().dayOne.listImportRuns();
  }

  getImportRun(id: string): ImportRunDetail {
    const detail = this.requireSession().dayOne.getImportRunDetail(id);
    if (!detail) throw new AppError("ENTITY_NOT_FOUND", "The import run no longer exists.");
    return detail;
  }

  async runDayOneImport(importRunId: string, context: JobHandlerContext): Promise<void> {
    if (!this.dayOneImporter) throw new AppError("INTERNAL_ERROR", "The Day One importer is unavailable.");
    const session = this.requireSession();
    const repository = session.dayOne;
    let run = repository.startImportRun(importRunId, new Date().toISOString());
    const archive = session.assets.findById(run.archiveAssetId);
    if (!archive) throw new AppError("ASSET_NOT_FOUND", "The encrypted Day One archive no longer exists.");
    const temporary = join(session.workspace.rootPath, "vault", "tmp", `${run.id}.${randomUUID()}.dayone.zip`);
    try {
      await pipeline(await session.vault.open(archive.sha256, session.keyRing ?? session.key), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      const bump = (field: keyof ImportRun["counts"], amount = 1) => {
        run = { ...run, counts: { ...run.counts, [field]: run.counts[field] + amount }, updatedAt: new Date().toISOString() };
      };
      const report = await this.dayOneImporter.importArchive(temporary, {
        onEntry: async (entry: NormalizedDayOneEntry) => {
          const result = repository.upsertEntry(run.id, entry, new Date().toISOString());
          bump(result.outcome === "new" ? "newEntries" : result.outcome === "updated" ? "updatedEntries" : "skippedEntries");
        },
        onMedia: async (media: NormalizedDayOneMedia) => {
          const importedMedia = await this.importAssetStream(media.stream, media.fileName, media.byteSize);
          repository.linkMedia(run.id, media.referencedByExternalIds, importedMedia.asset.id, media.archivePath, new Date().toISOString());
          bump("mediaImported");
        },
        onIssue: async (issue) => {
          const now = new Date().toISOString();
          const stored: ImportIssue = { id: randomUUID(), importRunId: run.id, ...issue, createdAt: now };
          repository.addImportIssue(stored);
          if (issue.severity === "error") bump("errorCount");
          if (issue.code === "DAYONE_MEDIA_MISSING") bump("mediaMissing");
        },
        onProgress: (progress) => {
          run = repository.updateImportRun({ ...run, progress, updatedAt: new Date().toISOString() });
          context.reportProgress(progress);
        }
      }, context.signal);
      const now = new Date().toISOString();
      run = repository.updateImportRun({
        ...run, state: "succeeded", progress: 1,
        counts: { ...run.counts, totalEntries: report.totalEntries, mediaMissing: Math.max(run.counts.mediaMissing, report.missingMedia) },
        finishedAt: now, updatedAt: now
      });
    } catch (error) {
      const now = new Date().toISOString();
      repository.updateImportRun({
        ...run, state: "failed", finishedAt: now, updatedAt: now,
        lastError: error instanceof AppError ? error.message : "The Day One import failed."
      });
      throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  listBackfillRuns(): BackfillRun[] {
    return this.requireSession().dayOne.listBackfillRuns();
  }

  startBackfill(input: StartBackfillInput): BackfillRun {
    const session = this.requireSession();
    if (input.importRunId) {
      const imported = session.dayOne.getImportRun(input.importRunId);
      if (!imported) throw new AppError("ENTITY_NOT_FOUND", "The import run no longer exists.");
      if (imported.state !== "succeeded") throw new AppError("IMPORT_RUN_STATE_CONFLICT", "Backfill can start only after an import succeeds.");
    }
    const now = new Date().toISOString();
    const run: BackfillRun = {
      id: randomUUID(), scope: {
        ...(input.importRunId ? { importRunId: input.importRunId } : {}),
        ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}),
        tags: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))], batchSize: input.batchSize ?? 25
      },
      detectorIdentity: DAYONE_DETECTOR_IDENTITY, detectorVersion: DAYONE_DETECTOR_VERSION,
      state: "queued", totalItems: 0, processedItems: 0, candidateCount: 0, createdAt: now, updatedAt: now
    };
    const totalItems = session.dayOne.listBackfillSourceVersions(run).length;
    const saved = session.dayOne.createBackfillRun({ ...run, totalItems });
    session.jobs.enqueue("dayone.backfill", { backfillRunId: saved.id }, now, 1);
    return saved;
  }

  pauseBackfill(id: string): BackfillRun {
    const repository = this.requireSession().dayOne;
    const run = this.getBackfillRequired(id);
    if (run.state !== "queued" && run.state !== "running") {
      throw new AppError("BACKFILL_STATE_CONFLICT", "Only queued or running backfill can be paused.");
    }
    return repository.updateBackfillRun({ ...run, state: "paused", updatedAt: new Date().toISOString() });
  }

  resumeBackfill(id: string): BackfillRun {
    const session = this.requireSession();
    const run = this.getBackfillRequired(id);
    if (run.state !== "paused" && run.state !== "failed") {
      throw new AppError("BACKFILL_STATE_CONFLICT", "Only paused or failed backfill can be resumed.");
    }
    const now = new Date().toISOString();
    const next: BackfillRun = { ...run, state: "queued", updatedAt: now };
    delete next.lastError;
    delete next.finishedAt;
    const resumed = session.dayOne.updateBackfillRun(next);
    session.jobs.enqueue("dayone.backfill", { backfillRunId: id }, now, 1);
    return resumed;
  }

  cancelBackfill(id: string): BackfillRun {
    const repository = this.requireSession().dayOne;
    const run = this.getBackfillRequired(id);
    if (!["queued", "running", "paused", "failed"].includes(run.state)) {
      throw new AppError("BACKFILL_STATE_CONFLICT", "The backfill run can no longer be cancelled.");
    }
    const now = new Date().toISOString();
    return repository.updateBackfillRun({ ...run, state: "cancelled", updatedAt: now, finishedAt: now });
  }

  async runBackfill(backfillRunId: string, context: JobHandlerContext): Promise<void> {
    const session = this.requireSession();
    const repository = session.dayOne;
    let run = this.getBackfillRequired(backfillRunId);
    if (["paused", "cancelled", "completed"].includes(run.state)) return;
    run = repository.updateBackfillRun({ ...run, state: "running", updatedAt: new Date().toISOString() });
    try {
      const items = repository.listBackfillSourceVersions(run);
      const remaining = run.cursor
        ? items.filter(({ journalEntry }) => journalEntry.sourceItemId > run.cursor!)
        : items;
      let handled = 0;
      for (const item of remaining) {
        const current = this.getBackfillRequired(run.id);
        if (current.state === "paused" || current.state === "cancelled") return;
        if (context.signal.aborted) throw new Error("Backfill interrupted.");
        if (handled >= run.scope.batchSize) break;
        const existing = repository.findExtraction(item.sourceVersion.id, run.detectorIdentity, run.detectorVersion, 0);
        let created = false;
        if (!existing) created = this.createDayOneCandidate(item.sourceVersion, item.journalEntry.journalDate, item.assetRefs) !== undefined;
        handled += 1;
        run = repository.updateBackfillRun({
          ...run, processedItems: Math.min(run.totalItems, run.processedItems + 1),
          candidateCount: run.candidateCount + (created ? 1 : 0), cursor: item.journalEntry.sourceItemId,
          updatedAt: new Date().toISOString()
        });
        context.reportProgress(run.totalItems === 0 ? 1 : run.processedItems / run.totalItems);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const now = new Date().toISOString();
      if (run.processedItems >= run.totalItems || handled === 0) {
        repository.updateBackfillRun({ ...run, state: "completed", updatedAt: now, finishedAt: now });
      } else {
        repository.updateBackfillRun({ ...run, state: "queued", updatedAt: now });
        session.jobs.enqueue("dayone.backfill", { backfillRunId: run.id }, now, 1);
      }
    } catch (error) {
      const now = new Date().toISOString();
      repository.updateBackfillRun({ ...run, state: "failed", updatedAt: now, finishedAt: now, lastError: "Backfill processing failed." });
      throw error;
    }
  }

  listCandidates(): CandidateSummary[] {
    const session = this.requireSession();
    return session.dayOne.listCandidates((id) => session.memory.getEvent(id));
  }

  getCandidate(eventId: string): CandidateDetail {
    const session = this.requireSession();
    const detail = session.dayOne.getCandidate(eventId, (id) => session.memory.getEventDetail(id));
    if (!detail) throw new AppError("ENTITY_NOT_FOUND", "The candidate no longer exists.");
    return detail;
  }

  confirmCandidate(eventId: string, expectedRevision: number): Event {
    return this.reviewCandidate(eventId, expectedRevision, "confirmed");
  }

  ignoreCandidate(eventId: string, expectedRevision: number): Event {
    return this.reviewCandidate(eventId, expectedRevision, "ignored");
  }

  mergeCandidate(input: CandidateMergeInput): CandidateMergeResult {
    return this.requireSession().dayOne.mergeCandidate(input, new Date().toISOString());
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
      for await (const chunk of await session.vault.open(asset.sha256, session.keyRing ?? session.key)) {
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
      await pipeline(await session.vault.open(asset.sha256, session.keyRing ?? session.key), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
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

  async getLocalProcessorStatus(): Promise<LocalProcessorStatus> {
    const session = this.requireSession();
    if (!this.mediaPipeline) return {
      settings: DEFAULT_MEDIA_PROCESSING_SETTINGS,
      ocr: { configured: false, available: false, displayNames: [], warnings: ["No OCR pipeline is installed."] },
      asr: { configured: false, available: false, displayNames: [], warnings: ["No ASR pipeline is installed."] },
      eligibleHistoricalAssets: 0, pendingJobs: 0
    };
    const base = await this.mediaPipeline.getStatus();
    const eligibleHistoricalAssets = session.assets.list().filter((asset) => {
      const kind = this.mediaPipeline!.kindFor(asset);
      return asset.availabilityStatus === "available" && Boolean(kind)
        && !session.phase6?.getCurrentDerivedArtifact(asset.id, kind!);
    }).length;
    const pendingJobs = session.jobs.list().filter(({ type, state }) =>
      type === "media.process" && (state === "queued" || state === "running")).length;
    return { ...base, eligibleHistoricalAssets, pendingJobs };
  }

  async updateMediaProcessingSettings(settings: MediaProcessingSettings): Promise<LocalProcessorStatus> {
    if (!this.mediaPipeline) throw new AppError("LOCAL_PROCESSOR_UNAVAILABLE", "No local media pipeline is installed.");
    await this.mediaPipeline.updateSettings(settings);
    return this.getLocalProcessorStatus();
  }

  async probeLocalProcessors(): Promise<LocalProcessorStatus> {
    if (!this.mediaPipeline) throw new AppError("LOCAL_PROCESSOR_UNAVAILABLE", "No local media pipeline is installed.");
    await this.mediaPipeline.probe();
    return this.getLocalProcessorStatus();
  }

  async enqueueMediaProcessing(assetId: string): Promise<Job> {
    const session = this.requireSession();
    if (!this.mediaPipeline || !session.phase6) throw new AppError("LOCAL_PROCESSOR_UNAVAILABLE", "Local media processing is unavailable.");
    const asset = session.assets.findById(assetId);
    if (!asset) throw new AppError("ASSET_NOT_FOUND", "The asset no longer exists.");
    if (asset.availabilityStatus !== "available") throw new AppError("EVIDENCE_UNAVAILABLE", "The original is not available for processing.");
    const fingerprint = await this.mediaPipeline.fingerprint(asset);
    const existingJob = session.jobs.list().find(({ type, state, payload }) => {
      const value = payload as { assetId?: unknown; inputHash?: unknown };
      return type === "media.process" && (state === "queued" || state === "running")
        && value.assetId === assetId && value.inputHash === fingerprint.inputHash;
    });
    if (existingJob) return existingJob;
    return session.jobs.enqueue("media.process", {
      assetId, kind: fingerprint.kind, inputHash: fingerprint.inputHash
    }, new Date().toISOString(), 3);
  }

  async enqueueHistoricalMediaProcessing(): Promise<Job[]> {
    if (!this.mediaPipeline) throw new AppError("LOCAL_PROCESSOR_UNAVAILABLE", "Local media processing is unavailable.");
    const session = this.requireSession();
    const jobs: Job[] = [];
    for (const asset of session.assets.list()) {
      const kind = this.mediaPipeline.kindFor(asset);
      if (!kind || asset.availabilityStatus !== "available" || session.phase6?.getCurrentDerivedArtifact(asset.id, kind)) continue;
      jobs.push(await this.enqueueMediaProcessing(asset.id));
    }
    return jobs;
  }

  async runMediaProcessing(assetId: string, expectedInputHash: string, context: JobHandlerContext): Promise<void> {
    const session = this.requireSession();
    if (!this.mediaPipeline || !session.phase6) throw new AppError("LOCAL_PROCESSOR_UNAVAILABLE", "Local media processing is unavailable.");
    const asset = session.assets.findById(assetId);
    if (!asset) throw new AppError("ASSET_NOT_FOUND", "The asset no longer exists.");
    if (asset.availabilityStatus !== "available") throw new AppError("EVIDENCE_UNAVAILABLE", "The original is no longer available.");
    const fingerprint = await this.mediaPipeline.fingerprint(asset);
    if (fingerprint.inputHash !== expectedInputHash) {
      throw new AppError("MEDIA_PROCESSING_FAILED", "The local processor configuration changed before the task started.", true);
    }
    const existing = session.phase6.findDerivedArtifact(asset.id, fingerprint.kind, fingerprint.inputHash);
    if (existing?.current) { context.reportProgress(1); return; }
    if (existing) {
      const detail = await this.getDerivedArtifactDetail(existing.id);
      session.phase6.activateDerivedArtifact(existing, {
        kind: existing.kind as MediaProcessorKind, id: `derived:${asset.id}:${existing.kind}`,
        title: `${asset.originalFileName} · ${existing.kind === "ocr" ? "OCR" : "Transcript"}`,
        content: detail.payload.text, contentHash: createHash("sha256").update(detail.payload.text).digest("hex"),
        derivedArtifactId: existing.id, sourceAssetId: asset.id, sourceRefs: []
      }, new Date().toISOString());
      context.reportProgress(1);
      return;
    }
    const temporaryRoot = join(session.workspace.rootPath, "vault", "tmp");
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const temporaryDirectory = await mkdtemp(join(temporaryRoot, "media-"));
    const suffix = extname(asset.originalFileName).replace(/[^.A-Za-z0-9]/g, "").slice(0, 12) || ".bin";
    const inputPath = join(temporaryDirectory, `input${suffix}`);
    try {
      await pipeline(await session.vault.open(asset.sha256, session.keyRing ?? session.key), createWriteStream(inputPath, { flags: "wx", mode: 0o600 }));
      context.reportProgress(0.05);
      const result = await this.mediaPipeline.process({ asset, inputPath, temporaryDirectory, signal: context.signal,
        reportProgress: (progress) => context.reportProgress(0.05 + progress * 0.9) });
      if (result.inputHash !== expectedInputHash) throw new AppError("MEDIA_PROCESSING_FAILED", "The processor returned an unexpected input hash.");
      const payload = Buffer.from(JSON.stringify(result.payload), "utf8");
      if (payload.length > 64 * 1024 * 1024) throw new AppError("MEDIA_PROCESSING_FAILED", "The derived artifact exceeds 64 MiB.");
      const stored = await session.vault.putStream(Readable.from(payload), session.keyRing ?? session.key, payload.length);
      const now = new Date().toISOString();
      const artifact = session.phase6.activateDerivedArtifact({
        id: randomUUID(), sourceAssetId: asset.id, kind: result.kind, sha256: stored.sha256,
        byteSize: stored.byteSize, mimeType: "application/vnd.grudge-vault.media+json",
        processorIdentity: result.processorIdentity, processorVersion: result.processorVersion,
        configHash: result.configHash, inputHash: result.inputHash, current: true, createdAt: now
      }, {
        kind: result.kind, id: `derived:${asset.id}:${result.kind}`,
        title: `${asset.originalFileName} · ${result.kind === "ocr" ? "OCR" : "Transcript"}`,
        content: result.payload.text, contentHash: createHash("sha256").update(result.payload.text).digest("hex"),
        derivedArtifactId: "pending", sourceAssetId: asset.id, sourceRefs: []
      }, now);
      if (!artifact.current) throw new AppError("MEDIA_PROCESSING_FAILED", "The derived artifact was not activated.");
      context.reportProgress(1);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async getDerivedArtifactDetail(artifactId: string): Promise<DerivedArtifactDetail> {
    const session = this.requireSession();
    const artifact = session.phase6?.getDerivedArtifact(artifactId);
    if (!artifact) throw new AppError("ENTITY_NOT_FOUND", "The derived artifact no longer exists.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of await session.vault.open(artifact.sha256, session.keyRing ?? session.key)) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.length;
      if (size > 64 * 1024 * 1024) throw new AppError("MEDIA_PROCESSING_FAILED", "The derived artifact exceeds the preview limit.");
      chunks.push(value);
    }
    let payload: DerivedArtifactDetail["payload"];
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as DerivedArtifactDetail["payload"]; }
    catch (cause) { throw new AppError("MEDIA_PROCESSING_FAILED", "The derived artifact is invalid.", false, { cause }); }
    if (payload.formatVersion !== 1 || payload.kind !== artifact.kind || payload.sourceAssetId !== artifact.sourceAssetId) {
      throw new AppError("MEDIA_PROCESSING_FAILED", "The derived artifact metadata does not match its index.");
    }
    return { artifact, payload };
  }

  getReviewAutomationSettings(): ReviewAutomationSettings {
    return this.requireSession().memory.getSetting<ReviewAutomationSettings>("review.automation")
      ?? DEFAULT_REVIEW_AUTOMATION_SETTINGS;
  }

  updateReviewAutomationSettings(settings: ReviewAutomationSettings): ReviewAutomationSettings {
    this.requireSession().memory.setSetting("review.automation", settings, new Date().toISOString());
    return settings;
  }

  listReminders(): Reminder[] { return this.requirePhaseSix().listReminders(); }
  markReminderRead(id: string): Reminder { return this.requirePhaseSix().updateReminderStatus(id, "read", new Date().toISOString()); }
  dismissReminder(id: string): Reminder { return this.requirePhaseSix().updateReminderStatus(id, "dismissed", new Date().toISOString()); }

  runReviewAutomation(now = new Date()): Reminder[] {
    const repository = this.requirePhaseSix();
    const settings = this.getReviewAutomationSettings();
    const created: Reminder[] = [];
    const scheduleReview = (kind: "monthly_review" | "quarterly_review", period: { key: string; from: string; to: string }) => {
      if (repository.getAutomationRun(period.key)) return;
      const review = this.generateReview({ from: period.from, to: period.to });
      repository.saveAutomationRun({ scheduleKey: period.key, kind, reviewId: review.id, from: period.from, to: period.to, createdAt: now.toISOString() });
      if (review.eventIds.length === 0) return;
      created.push(repository.saveReminder({
        id: randomUUID(), kind, scheduleKey: period.key, status: "unread", dueAt: now.toISOString(), reviewId: review.id,
        clarificationIds: [], createdAt: now.toISOString(), updatedAt: now.toISOString()
      }));
    };
    if (settings.monthly) scheduleReview("monthly_review", latestCompletedMonth(now));
    if (settings.quarterly) scheduleReview("quarterly_review", latestCompletedQuarter(now));
    if (settings.clarificationWeekly) {
      const key = isoWeekScheduleKey(now);
      if (!repository.getAutomationRun(key)) {
        const clarificationIds = this.listClarifications().filter(({ status, priority }) =>
          status === "open" && (priority === "important" || priority === "rights_related")).map(({ id }) => id);
        if (clarificationIds.length) {
          repository.saveAutomationRun({ scheduleKey: key, kind: "clarification_digest", createdAt: now.toISOString() });
          created.push(repository.saveReminder({
          id: randomUUID(), kind: "clarification_digest", scheduleKey: key, status: "unread", dueAt: now.toISOString(),
          clarificationIds, createdAt: now.toISOString(), updatedAt: now.toISOString()
          }));
        }
      }
    }
    return created;
  }

  async ingestWatchedDayOne(filePath: string): Promise<ImportRun | undefined> {
    const repository = this.requirePhaseSix();
    const imported = await this.importAsset(filePath);
    if (repository.hasImportFolderArchive(imported.asset.sha256)) return undefined;
    const run = this.createDayOneImportForAsset(imported.asset);
    repository.saveImportFolderEntry({
      id: randomUUID(), archiveSha256: imported.asset.sha256, assetId: imported.asset.id,
      importRunId: run.id, fileName: imported.asset.originalFileName, createdAt: new Date().toISOString()
    });
    return run;
  }

  getImportFolderCounts(): { imported: number; failed: number } {
    return this.requirePhaseSix().countImportFolderEntries();
  }

  listEvidence(): EvidenceDetail[] { return this.phaseFive.listEvidence(); }
  getEvidence(assetId: string): EvidenceDetail { return this.phaseFive.getEvidence(assetId); }
  getEvidenceImpact(assetId: string): EvidenceReferenceImpact { return this.phaseFive.getEvidenceImpact(assetId); }
  listIntegrityScans(): IntegrityScan[] { return this.requireSession().phase5?.listIntegrityScans() ?? []; }
  startIntegrityScan(): IntegrityScan {
    const scan = this.phaseFive.startIntegrityScan();
    this.requireSession().jobs.enqueue("vault.integrity-scan", { scanId: scan.id }, new Date().toISOString(), 3);
    return scan;
  }
  runIntegrityScan(scanId: string, context: JobHandlerContext): Promise<void> {
    return this.phaseFive.runIntegrityScan(scanId, context.reportProgress, context.signal);
  }
  deleteOriginal(assetId: string, confirmReferencedDeletion: boolean): Promise<EvidenceDetail> {
    return this.phaseFive.deleteOriginal(assetId, confirmReferencedDeletion);
  }
  supersedeOriginal(oldAssetId: string, newAssetId: string): EvidenceDetail {
    return this.phaseFive.supersedeOriginal(oldAssetId, newAssetId);
  }

  listCases(): Case[] { return this.phaseFive.listCases(); }
  getCase(id: string): CaseDetail { return this.phaseFive.getCase(id); }
  listCaseRevisions(id: string): CaseRevision[] { return this.requireSession().phase5?.listCaseRevisions(id) ?? []; }
  createCase(input: CreateCaseInput): Case {
    const { reason, ...fields } = input;
    return this.phaseFive.createCase(normalizeCaseWriteFields(fields), reason);
  }
  updateCase(input: UpdateCaseInput): Case {
    const { caseId, expectedRevision, reason, ...fields } = input;
    return this.phaseFive.updateCase(caseId, expectedRevision, normalizeCaseWriteFields(fields), reason);
  }
  archiveCase(id: string, expectedRevision: number): Case {
    const current = this.phaseFive.getCase(id).case;
    return this.phaseFive.updateCase(id, expectedRevision, { ...normalizeCaseWriteFields(current), status: "archived" }, "Case archived");
  }
  runLegalCheck(id: string): Promise<LegalVerificationResult> { return this.phaseFive.runLegalCheck(id); }
  previewCaseBinder(id: string, profile: CaseBinderProfile): CaseBinderPreview { return this.phaseFive.previewBinder(id, profile); }
  exportCaseBinder(previewId: string, destinationPath: string): Promise<CaseBinderExportResult> {
    return this.phaseFive.exportBinder(previewId, destinationPath);
  }

  private createProposedEvent(proposal: EventDraftProposal): Event {
    const now = new Date().toISOString();
    const clarifications: Clarification[] = proposal.clarification ? [{
      id: randomUUID(), eventId: "", ...proposal.clarification, status: "open",
      sourceRefs: proposal.sourceRefs, createdAt: now, updatedAt: now
    }] : [];
    return this.commitNewEvent(proposal, "Created from chat message", now, { clarifications });
  }

  private requirePhaseSix(): PhaseSixRepositoryPort {
    const repository = this.requireSession().phase6;
    if (!repository) throw new AppError("INTERNAL_ERROR", "Phase 6 storage is unavailable.");
    return repository;
  }

  private reencryptAgentCredentials(targetKeyId: string): void {
    const session = this.requireSession();
    const target = session.keyRing?.keys.get(targetKeyId);
    if (!target) throw new AppError("CRYPTO_MIGRATION_CONFLICT", "The target key is unavailable for credential migration.");
    for (const mode of ["private", "enhanced"] as const) {
      const plaintext = this.getAgentCredential(mode);
      if (plaintext !== undefined) {
        session.agents.saveCredential(mode, encryptAgentCredential(plaintext, target, session.workspace.id, mode), new Date().toISOString());
      }
    }
  }

  private async importAssetStream(stream: Readable, fileName: string, expectedByteSize: number): Promise<AssetImportResult> {
    const session = this.requireSession();
    const stored = await session.vault.putStream(stream, session.keyRing ?? session.key, expectedByteSize);
    const now = new Date().toISOString();
    const result = session.assets.upsert({
      id: randomUUID(), sha256: stored.sha256, byteSize: stored.byteSize,
      mimeType: lookupMimeType(fileName) || "application/octet-stream", originalFileName: basename(fileName),
      vaultFormat: stored.vaultFormat, integrityStatus: "pending", availabilityStatus: "available", createdAt: now
    });
    if (!result.deduplicated) {
      session.jobs.enqueue("asset.verify", { assetId: result.asset.id, sha256: result.asset.sha256 }, now);
      await this.enqueueAutomaticMedia(result.asset);
    }
    return result;
  }

  private async enqueueAutomaticMedia(asset: Asset): Promise<void> {
    if (!this.mediaPipeline?.getSettings().autoProcessNew || !this.mediaPipeline.kindFor(asset)) return;
    try {
      const status = await this.mediaPipeline.getStatus();
      const kind = this.mediaPipeline.kindFor(asset);
      if ((kind === "ocr" && status.ocr.available) || (kind === "transcript" && status.asr.available)) {
        await this.enqueueMediaProcessing(asset.id);
      }
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "LOCAL_PROCESSOR_UNAVAILABLE") throw error;
    }
  }

  private createDayOneCandidate(sourceVersion: SourceVersion, journalDate: string, assetRefs: string[]): Event | undefined {
    const content = sourceVersion.content ?? "";
    const meaningful = content
      .replace(/!\[[^\]]*\]\(\s*dayone(?:-moment)?:\/\/[^)]*\)/gi, "")
      .replace(/\{%\s*(?:photo|image|video|audio|pdf|attachment)\b.*?%\}/gi, "")
      .replace(/<\/?(?:img|video|audio)\b[^>]*>/gi, "")
      .replace(/\[\{(?:photo|image|video|audio|pdf|attachment)\}\]/gi, "")
      .trim();
    if (!meaningful) return undefined;
    const now = new Date().toISOString();
    const parsed = parseConservativeTemporalValue(meaningful);
    const occurredAt = parsed.kind === "unknown" ? { kind: "date" as const, value: journalDate.slice(0, 10) } : parsed;
    const temporalBasis: CandidateExtraction["temporalBasis"] = parsed.kind === "unknown"
      ? "journal-date" : parsed.kind === "relative" ? "relative" : "source-text";
    const title = meaningful.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean)!.slice(0, 80);
    const needsClarification = occurredAt.kind === "relative";
    const event: Event = {
      id: randomUUID(), title, status: "candidate", occurredAt, recordedAt: now,
      narrative: content.trim().slice(0, 100_000), facts: [], interpretations: [], emotions: [], interests: [], participants: [],
      sourceRefs: [sourceVersion.sourceItemId], assetRefs: [...new Set(assetRefs)],
      completeness: { missingFields: needsClarification ? ["occurredAt"] : [], openClarificationCount: needsClarification ? 1 : 0 },
      currentRevision: 1, updatedAt: now
    };
    const extraction: CandidateExtraction = {
      id: randomUUID(), sourceVersionId: sourceVersion.id, eventId: event.id,
      detectorIdentity: DAYONE_DETECTOR_IDENTITY, detectorVersion: DAYONE_DETECTOR_VERSION,
      ordinal: 0, anchorStart: 0, anchorEnd: Math.min(content.length, 100_000),
      temporalBasis, reviewState: "pending", createdAt: now, updatedAt: now
    };
    const clarification: Clarification | undefined = needsClarification ? {
      id: randomUUID(), eventId: event.id, fieldPath: "occurredAt",
      question: "这件事大约发生在什么时候？ / About when did this happen?",
      reason: "日记只包含相对时间或含糊指代，系统没有补造具体日期。", priority: "normal",
      status: "open", sourceRefs: [sourceVersion.sourceItemId], createdAt: now, updatedAt: now
    } : undefined;
    return this.requireSession().dayOne.commitCandidate(event, extraction, clarification);
  }

  private reviewCandidate(eventId: string, expectedRevision: number, state: "confirmed" | "ignored"): Event {
    const current = this.getCurrentEvent(eventId);
    this.assertRevision(current, expectedRevision);
    const now = new Date().toISOString();
    const next: Event = {
      ...current, status: state === "confirmed" ? "confirmed" : "archived",
      currentRevision: current.currentRevision + 1, updatedAt: now
    };
    const revision: EventRevision = {
      id: randomUUID(), eventId, revision: next.currentRevision, previousRevision: current.currentRevision,
      snapshot: next, actor: "user", reason: state === "confirmed" ? "Confirmed Day One candidate" : "Ignored Day One candidate",
      sourceRefs: next.sourceRefs, createdAt: now
    };
    return this.requireSession().dayOne.commitCandidateReview(next, revision, state);
  }

  private getBackfillRequired(id: string): BackfillRun {
    const run = this.requireSession().dayOne.getBackfillRun(id);
    if (!run) throw new AppError("ENTITY_NOT_FOUND", "The backfill run no longer exists.");
    return run;
  }

  private commitNewEvent(
    fields: EventWriteFields,
    reason: string,
    now: string,
    extras: EventCommitExtras = {},
    actor: EventRevision["actor"] = "user"
  ): Event {
    const id = randomUUID();
    const clarifications = (extras.clarifications ?? []).map((item) => ({ ...item, eventId: id }));
    const normalized = normalizeEventFields(fields);
    const event: Event = {
      id, ...normalized, recordedAt: now, updatedAt: now, currentRevision: 1,
      completeness: completenessFor(normalized, clarifications.filter(({ status }) => status === "open").length)
    };
    const revision: EventRevision = {
      id: randomUUID(), eventId: id, revision: 1, previousRevision: 0, snapshot: event,
      actor, reason: reason.trim() || "Event created", sourceRefs: event.sourceRefs, createdAt: now
    };
    return this.requireSession().memory.commitEvent(event, revision, { ...extras, clarifications });
  }

  private commitRevision(
    current: Event,
    fields: EventWriteFields,
    reason: string,
    actor: EventRevision["actor"] = "user"
  ): Event {
    const now = new Date().toISOString();
    const next = this.eventWithFields(current, fields, now);
    return this.requireSession().memory.commitEvent(next, this.revisionFor(current, next, reason, next.sourceRefs, now, actor));
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

  private revisionFor(
    current: Event,
    next: Event,
    reason: string,
    sourceRefs: string[],
    now: string,
    actor: EventRevision["actor"] = "user"
  ): EventRevision {
    return {
      id: randomUUID(), eventId: next.id, revision: next.currentRevision,
      previousRevision: current.currentRevision, snapshot: next, actor,
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

  private reviewInputHash(
    events: Event[], relations: EventRelation[], canonicalPeople: Map<string, string>
  ): string {
    const input = {
      events: events.map(({ id, currentRevision }) => ({ id, currentRevision })).sort((a, b) => a.id.localeCompare(b.id)),
      relations: relations.map(({ id, status, sourceRevision, targetRevision }) => ({ id, status, sourceRevision, targetRevision }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      people: [...canonicalPeople.entries()].sort(([left], [right]) => left.localeCompare(right))
    };
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
  }

  private reviewWithStale(review: ReviewRun): ReviewRun {
    const memory = this.requireSession().memory;
    const events = memory.searchEvents({ status: "confirmed", from: review.from, to: review.to, limit: 200 });
    const eventIds = new Set(events.map(({ id }) => id));
    const relations = memory.listEventRelations(undefined, true).filter(({ sourceEventId, targetEventId, status }) =>
      status !== "rejected" && eventIds.has(sourceEventId) && eventIds.has(targetEventId));
    const participantIds = [...new Set(events.flatMap(({ participants }) => participants.map(({ personId }) => personId)))];
    const canonical = new Map(participantIds.map((id) => [id, memory.resolveCanonicalPersonId(id)]));
    return { ...review, stale: review.inputHash !== this.reviewInputHash(events, relations, canonical) };
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

export const DAYONE_DETECTOR_IDENTITY = "local.dayone-candidate";
export const DAYONE_DETECTOR_VERSION = 1;

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
  private runningJobId: string | undefined;
  private draining = false;
  private stopped = true;
  private drainPromise: Promise<void> | undefined;

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
    this.pollTimer = setInterval(() => this.triggerDrain(), this.pollMs);
    this.triggerDrain();
  }

  wake(): void {
    if (!this.stopped) this.triggerDrain();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.runningAbort?.abort();
  }

  cancel(jobId: string): Job {
    const job = this.repository.cancel(jobId, this.now().toISOString());
    if (this.runningJobId === jobId) this.runningAbort?.abort();
    this.onChanged();
    return job;
  }

  async stopAndWait(): Promise<void> {
    this.stop();
    await this.drainPromise;
  }

  private triggerDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => { this.drainPromise = undefined; });
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
    this.runningJobId = job.id;
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
      const finished = this.now().toISOString();
      if (!this.stopped) this.repository.succeed(job.id, finished);
      else this.repository.interrupt(job.id, "Interrupted while locking workspace", finished);
    } catch (error) {
      if (this.stopped && abort.signal.aborted) {
        this.repository.interrupt(job.id, "Interrupted while locking workspace", this.now().toISOString());
      } else if (!this.stopped || abort.signal.aborted) {
        const now = this.now();
        const retryDelays = [1_000, 5_000];
        const attemptWithinCycle = (job.attempts - 1) % 3;
        const delay = abort.signal.aborted ? 0 : retryDelays[attemptWithinCycle];
        const retryAt = delay === undefined ? undefined : new Date(now.getTime() + delay).toISOString();
        this.repository.fail(job.id, abort.signal.aborted ? "Interrupted while locking workspace" : error instanceof Error ? error.message : "Job failed", now.toISOString(), retryAt);
      }
    } finally {
      clearInterval(heartbeat);
      this.runningAbort = undefined;
      this.runningJobId = undefined;
      this.onChanged();
    }
  }
}
