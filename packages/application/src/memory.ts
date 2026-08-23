import type {
  Clarification,
  Conversation,
  Event,
  EventDetail,
  EventRevision,
  EventSearchQuery,
  Message,
  Person,
  Source,
  SourceItem,
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

  listClarifications(eventId?: string): Clarification[];
  getClarification(id: string): Clarification | undefined;
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

export function parseConservativeTemporalValue(content: string): TemporalValue {
  const isoDate = content.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoDate?.[1] && isoDate[2] && isoDate[3]) {
    return { kind: "date", value: `${isoDate[1]}-${pad(isoDate[2])}-${pad(isoDate[3])}` };
  }
  const chineseDate = content.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (chineseDate?.[1] && chineseDate[2] && chineseDate[3]) {
    return { kind: "date", value: `${chineseDate[1]}-${pad(chineseDate[2])}-${pad(chineseDate[3])}` };
  }
  const isoMonth = content.match(/\b(\d{4})-(\d{1,2})(?!-\d)/);
  if (isoMonth?.[1] && isoMonth[2]) {
    return { kind: "month", value: `${isoMonth[1]}-${pad(isoMonth[2])}` };
  }
  const chineseMonth = content.match(/(\d{4})年(\d{1,2})月/);
  if (chineseMonth?.[1] && chineseMonth[2]) {
    return { kind: "month", value: `${chineseMonth[1]}-${pad(chineseMonth[2])}` };
  }
  const relative = content.match(/(?:大约|约|去年|今年|上个月|这个月|上次|那天|当时)?\s*\d{1,2}\s*月(?:份)?|去年|今年|上个月|这个月|上次|那天|当时/);
  if (relative?.[0]?.trim()) return { kind: "relative", text: relative[0].trim() };
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
