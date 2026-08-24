import type {
  AgentExecutionMode,
  AgentModelCallAudit,
  AgentModelSettings,
  AgentRun,
  Clarification,
  Conversation,
  Event,
  EventDetail,
  EventRelation,
  EventRevision,
  EventSearchQuery,
  Message,
  Person,
  PersonAlias,
  PersonMergeRecord,
  PersonMergeSuggestion,
  ReviewRun,
  SearchDocument,
  Source,
  SourceItem,
  SourceReferenceDetail,
  TemporalValue
} from "@grudge-vault/domain";
import type { EventWriteFields } from "@grudge-vault/shared";

export interface EventCommitExtras {
  sources?: Source[];
  sourceItems?: SourceItem[];
  clarifications?: Clarification[];
}

export interface MemoryRepositoryPort {
  listConversations(): Conversation[];
  createConversation(conversation: Conversation, source: Source): Conversation;
  renameConversation(id: string, title: string, now: string): Conversation;
  deleteConversation(id: string, now: string): Conversation;
  listMessages(conversationId: string): Message[];
  appendMessage(message: Message, sourceItem: SourceItem): Message;

  searchEvents(query: EventSearchQuery): Event[];
  getEvent(id: string): Event | undefined;
  getEventDetail(id: string): EventDetail | undefined;
  listEventRevisions(id: string): EventRevision[];
  commitEvent(event: Event, revision: EventRevision, extras?: EventCommitExtras): Event;

  listPeople(includeArchived?: boolean): Person[];
  getPerson(id: string): Person | undefined;
  createPerson(person: Person): Person;
  updatePerson(person: Person): Person;
  listPersonAliases(personId?: string, includeInactive?: boolean): PersonAlias[];
  createPersonAlias(alias: PersonAlias): PersonAlias;
  deactivatePersonAlias(id: string, now: string): PersonAlias;
  listPersonMergeSuggestions(): PersonMergeSuggestion[];
  upsertPersonMergeSuggestion(suggestion: PersonMergeSuggestion): PersonMergeSuggestion;
  updatePersonMergeSuggestion(id: string, status: PersonMergeSuggestion["status"], now: string, mergeRecordId?: string): PersonMergeSuggestion;
  listPersonMergeRecords(includeReverted?: boolean): PersonMergeRecord[];
  createPersonMerge(record: PersonMergeRecord): PersonMergeRecord;
  revertPersonMerge(id: string, now: string): PersonMergeRecord;
  resolveCanonicalPersonId(id: string): string;
  listIdentityPersonIds(id: string): string[];

  listEventRelations(eventId?: string, includeRejected?: boolean): EventRelation[];
  getEventRelation(id: string): EventRelation | undefined;
  upsertEventRelation(relation: EventRelation): EventRelation;
  updateEventRelationStatus(id: string, status: EventRelation["status"], now: string): EventRelation;
  deleteEventRelation(id: string): void;

  searchUnifiedKeyword(query: import("@grudge-vault/domain").UnifiedSearchQuery): import("@grudge-vault/domain").UnifiedSearchHit[];
  listSearchDocuments(): SearchDocument[];
  upsertSearchDocument(document: SearchDocument, now: string): void;
  getSourceReference(id: string): SourceReferenceDetail | undefined;

  getSetting<T>(key: string): T | undefined;
  setSetting(key: string, value: unknown, now: string): void;
  listEmbeddingGenerations(): import("@grudge-vault/domain").EmbeddingGeneration[];
  createEmbeddingGeneration(generation: import("@grudge-vault/domain").EmbeddingGeneration): void;
  putEmbedding(generationId: string, document: SearchDocument, vector: Float32Array): void;
  activateEmbeddingGeneration(id: string, documentCount: number, now: string): void;
  failEmbeddingGeneration(id: string, error: string): void;
  listEmbeddings(generationId: string): Array<{ document: SearchDocument; vector: Float32Array }>;

  listReviews(): ReviewRun[];
  getReview(id: string): ReviewRun | undefined;
  saveReview(review: ReviewRun): ReviewRun;

  listClarifications(eventId?: string): Clarification[];
  getClarification(id: string): Clarification | undefined;
  setClarificationPriority(id: string, priority: Clarification["priority"], now: string): Clarification;
}

export interface AgentCredentialEnvelope {
  algorithm: "aes-256-gcm";
  version: 1;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface AgentRepositoryPort {
  listRuns(conversationId: string): AgentRun[];
  getRun(id: string): AgentRun | undefined;
  saveRun(run: AgentRun): AgentRun;
  listModelCallAudits(runId: string): AgentModelCallAudit[];
  saveModelCallAudit(audit: AgentModelCallAudit): AgentModelCallAudit;
  getSettings(): AgentModelSettings | undefined;
  saveSettings(settings: AgentModelSettings, now: string): AgentModelSettings;
  getCredential(mode: AgentExecutionMode): AgentCredentialEnvelope | undefined;
  saveCredential(mode: AgentExecutionMode, envelope: AgentCredentialEnvelope | undefined, now: string): void;
}

export interface EventDraftProposal extends EventWriteFields {
  clarification?: Pick<Clarification, "fieldPath" | "question" | "reason" | "priority">;
}

export interface EventDraftGeneratorPort {
  readonly identity: string;
  readonly version: number;
  generate(content: string, sourceRef: string): Promise<EventDraftProposal | undefined>;
}

function pad(value: string): string {
  return value.padStart(2, "0");
}

function validCalendarDate(year: string, month: string, day: string): boolean {
  const candidate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return candidate.getUTCFullYear() === Number(year)
    && candidate.getUTCMonth() + 1 === Number(month)
    && candidate.getUTCDate() === Number(day);
}

function validCalendarMonth(year: string, month: string): boolean {
  return /^\d{4}$/.test(year) && Number(month) >= 1 && Number(month) <= 12;
}

export function parseConservativeTemporalValue(content: string): TemporalValue {
  const isoDate = content.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoDate?.[1] && isoDate[2] && isoDate[3] && validCalendarDate(isoDate[1], isoDate[2], isoDate[3])) {
    return { kind: "date", value: `${isoDate[1]}-${pad(isoDate[2])}-${pad(isoDate[3])}` };
  }
  const chineseDate = content.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (chineseDate?.[1] && chineseDate[2] && chineseDate[3] && validCalendarDate(chineseDate[1], chineseDate[2], chineseDate[3])) {
    return { kind: "date", value: `${chineseDate[1]}-${pad(chineseDate[2])}-${pad(chineseDate[3])}` };
  }
  const isoMonth = content.match(/\b(\d{4})-(\d{1,2})(?!-\d)/);
  if (isoMonth?.[1] && isoMonth[2] && validCalendarMonth(isoMonth[1], isoMonth[2])) {
    return { kind: "month", value: `${isoMonth[1]}-${pad(isoMonth[2])}` };
  }
  const chineseMonth = content.match(/(\d{4})年(\d{1,2})月/);
  if (chineseMonth?.[1] && chineseMonth[2] && validCalendarMonth(chineseMonth[1], chineseMonth[2])) {
    return { kind: "month", value: `${chineseMonth[1]}-${pad(chineseMonth[2])}` };
  }
  const relativeMonth = content.match(/(?:大约|约)?\s*(\d{1,2})\s*月(?:份)?/);
  if (relativeMonth?.[0]?.trim() && relativeMonth[1] && Number(relativeMonth[1]) >= 1 && Number(relativeMonth[1]) <= 12) {
    return { kind: "relative", text: relativeMonth[0].trim() };
  }
  const relative = content.match(/去年|今年|上个月|这个月|上次|那天|当时|那件事/);
  if (relative?.[0]) return { kind: "relative", text: relative[0] };
  return { kind: "unknown" };
}

export class DeterministicEventDraftGenerator implements EventDraftGeneratorPort {
  readonly identity = "local.deterministic-event-draft";
  readonly version = 1;

  async generate(content: string, sourceRef: string): Promise<EventDraftProposal | undefined> {
    const normalized = content.trim();
    if (!normalized) return undefined;
    const firstSentence = normalized.split(/[。！？.!?\n]/, 1)[0]?.trim() || normalized;
    const occurredAt = parseConservativeTemporalValue(normalized);
    const proposal: EventDraftProposal = {
      title: firstSentence.slice(0, 80),
      status: "candidate",
      occurredAt,
      narrative: normalized,
      facts: [],
      interpretations: [],
      emotions: [],
      interests: [],
      participants: [],
      sourceRefs: [sourceRef],
      assetRefs: []
    };
    if (occurredAt.kind === "unknown" || occurredAt.kind === "relative") {
      proposal.clarification = {
        fieldPath: "occurredAt",
        question: "这件事大约发生在什么时候？ / About when did this happen?",
        reason: "事件时间仍然未知或只有相对描述。",
        priority: "normal"
      };
    }
    return proposal;
  }
}
