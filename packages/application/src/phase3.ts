import { createHash, randomUUID } from "node:crypto";
import type {
  Event, EventRelation, Person, PersonAlias, RelationBasis, ReviewPattern, TimelineQuery,
  TimelineResult, UnifiedSearchHit
} from "@grudge-vault/domain";

export interface EmbeddingAdapterPort {
  readonly identity: string;
  readonly version: number;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export const RELATION_ALGORITHM_IDENTITY = "local.deterministic-event-relations";
export const RELATION_ALGORITHM_VERSION = 1;
export const REVIEW_GENERATOR_IDENTITY = "local.deterministic-review";
export const REVIEW_GENERATOR_VERSION = 1;

export function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\p{P}\p{S}\s]+/gu, "");
}

function trigrams(value: string): Set<string> {
  const normalized = normalizeIdentity(value);
  if (normalized.length < 3) return new Set(normalized ? [normalized] : []);
  return new Set(Array.from({ length: normalized.length - 2 }, (_, index) => normalized.slice(index, index + 3)));
}

export function trigramSimilarity(left: string, right: string): number {
  const a = trigrams(left);
  const b = trigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((value) => b.has(value)).length;
  return intersection / (a.size + b.size - intersection);
}

export function personSuggestionScore(
  personA: Person,
  aliasesA: PersonAlias[],
  personB: Person,
  aliasesB: PersonAlias[]
): { score: number; basis: string[] } | undefined {
  const namesA = [personA.displayName, ...aliasesA.filter(({ status }) => status === "active").map(({ value }) => value)];
  const namesB = [personB.displayName, ...aliasesB.filter(({ status }) => status === "active").map(({ value }) => value)];
  let score = 0;
  const basis: string[] = [];
  for (const left of namesA) for (const right of namesB) {
    const normalizedLeft = normalizeIdentity(left);
    const normalizedRight = normalizeIdentity(right);
    if (!normalizedLeft || !normalizedRight) continue;
    if (normalizedLeft === normalizedRight) {
      score = Math.max(score, 1);
      basis.push(`同名或别名匹配：${left}`);
      continue;
    }
    if (normalizedLeft.length < 3 || normalizedRight.length < 3) continue;
    const similarity = trigramSimilarity(left, right);
    if (similarity >= 0.8) {
      score = Math.max(score, similarity);
      basis.push(`名称相似：${left} / ${right}`);
    }
  }
  return score >= 0.8 ? { score, basis: [...new Set(basis)] } : undefined;
}

export function textTokens(event: Event): Set<string> {
  const text = [
    event.title, event.narrative ?? "", ...event.facts.map(({ text }) => text),
    ...event.interpretations.map(({ text }) => text), ...event.interests.map(({ label }) => label)
  ].join(" ").normalize("NFKC").toLocaleLowerCase("en-US");
  const words = text.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const cjk = text.match(/[\p{Script=Han}]{2,}/gu)?.flatMap((value) => {
    const chars = [...value];
    return chars.flatMap((_, index) => [chars.slice(index, index + 2).join(""), chars.slice(index, index + 3).join("")]);
  }) ?? [];
  const stop = new Set(["this", "that", "with", "from", "have", "the", "and", "了", "的", "一个", "事情"]);
  return new Set([...words, ...cjk].filter((value) => value.length >= 2 && !stop.has(value)));
}

function jaccard(left: Set<string>, right: Set<string>): { score: number; shared: string[] } {
  const shared = [...left].filter((value) => right.has(value));
  const union = new Set([...left, ...right]).size;
  return { score: union ? shared.length / union : 0, shared: shared.slice(0, 8) };
}

export function temporalStart(event: Event): string | undefined {
  const temporal = event.occurredAt;
  if (temporal.kind === "instant" || temporal.kind === "date") return temporal.value.slice(0, 10);
  if (temporal.kind === "month") return `${temporal.value}-01`;
  if (temporal.kind === "range") return temporal.from?.slice(0, 10);
  return undefined;
}

function temporalEnd(event: Event): string | undefined {
  const temporal = event.occurredAt;
  if (temporal.kind === "instant" || temporal.kind === "date") return temporal.value.slice(0, 10);
  if (temporal.kind === "month") {
    const [year, month] = temporal.value.split("-").map(Number);
    if (!year || !month) return undefined;
    return `${temporal.value}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
  }
  if (temporal.kind === "range") return temporal.to?.slice(0, 10);
  return undefined;
}

export function relationSuggestions(
  events: Event[],
  canonicalPerson: (id: string) => string,
  now: string
): EventRelation[] {
  const output: EventRelation[] = [];
  for (let leftIndex = 0; leftIndex < events.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < events.length; rightIndex += 1) {
      const left = events[leftIndex]!;
      const right = events[rightIndex]!;
      const leftPeople = new Set(left.participants.map(({ personId }) => canonicalPerson(personId)));
      const rightPeople = new Set(right.participants.map(({ personId }) => canonicalPerson(personId)));
      const sharedPeople = [...leftPeople].filter((id) => rightPeople.has(id));
      const sharedInterests = left.interests.map(({ label }) => normalizeIdentity(label))
        .filter((label) => right.interests.some((interest) => normalizeIdentity(interest.label) === label));
      const text = jaccard(textTokens(left), textTokens(right));
      const startLeft = temporalStart(left);
      const startRight = temporalStart(right);
      const days = startLeft && startRight
        ? Math.abs(Date.parse(startLeft) - Date.parse(startRight)) / 86_400_000
        : undefined;
      const basis: RelationBasis[] = [];
      if (sharedPeople.length) basis.push({
        kind: "person", label: `共同人物 ${sharedPeople.length} 位`, personIds: sharedPeople,
        eventIds: [left.id, right.id], sourceRefs: [...new Set([...left.sourceRefs, ...right.sourceRefs])]
      });
      if (sharedInterests.length) basis.push({
        kind: "topic", label: `共同利益/主题：${sharedInterests.join("、")}`, personIds: [],
        eventIds: [left.id, right.id], sourceRefs: [...new Set([...left.sourceRefs, ...right.sourceRefs])]
      });
      if (text.score >= 0.12 && text.shared.length) basis.push({
        kind: "text", label: `共同关键词：${text.shared.join("、")}`, personIds: [],
        eventIds: [left.id, right.id], sourceRefs: [...new Set([...left.sourceRefs, ...right.sourceRefs])]
      });
      if (days !== undefined && days <= 45) basis.push({
        kind: "time", label: `时间相距约 ${Math.round(days)} 天`, personIds: [], eventIds: [left.id, right.id], sourceRefs: []
      });
      const score = Math.min(1, sharedPeople.length * 0.45 + (sharedInterests.length ? 0.35 : 0) + text.score * 0.5 + (days !== undefined && days <= 45 ? 0.1 : 0));
      const base = {
        origin: "algorithm" as const, status: "suggested" as const, basis,
        algorithmIdentity: RELATION_ALGORITHM_IDENTITY, algorithmVersion: RELATION_ALGORITHM_VERSION,
        sourceRevision: left.currentRevision, targetRevision: right.currentRevision, createdAt: now, updatedAt: now
      };
      if (score >= 0.45) output.push({
        ...base, id: randomUUID(), sourceEventId: left.id, targetEventId: right.id, kind: "similar", score
      });
      if (sharedInterests.length || text.score >= 0.22) output.push({
        ...base, id: randomUUID(), sourceEventId: left.id, targetEventId: right.id, kind: "same_topic", score: Math.max(0.5, text.score)
      });
      const leftEnd = temporalEnd(left);
      const rightEnd = temporalEnd(right);
      if (score >= 0.45 && leftEnd && startRight && leftEnd < startRight) output.push({
        ...base, id: randomUUID(), sourceEventId: left.id, targetEventId: right.id, kind: "precedes", score
      }); else if (score >= 0.45 && rightEnd && startLeft && rightEnd < startLeft) output.push({
        ...base, id: randomUUID(), sourceEventId: right.id, targetEventId: left.id, kind: "precedes", score,
        sourceRevision: right.currentRevision, targetRevision: left.currentRevision
      });
    }
  }
  return output;
}

export function buildTimeline(events: Event[], query: TimelineQuery): TimelineResult {
  const sorted = [...events].sort((a, b) => {
    const left = temporalStart(a);
    const right = temporalStart(b);
    if (!left && !right) return b.recordedAt.localeCompare(a.recordedAt);
    if (!left) return 1;
    if (!right) return -1;
    return right.localeCompare(left) || b.updatedAt.localeCompare(a.updatedAt);
  });
  const groups = new Map<string, Event[]>();
  for (const event of sorted) {
    const start = temporalStart(event);
    const key = start ? start.slice(0, 7) : event.occurredAt.kind === "relative" ? "relative" : "unknown";
    const list = groups.get(key) ?? [];
    list.push(event);
    groups.set(key, list);
  }
  return {
    query, total: sorted.length,
    groups: [...groups.entries()].map(([key, grouped]) => ({
      key, label: key === "relative" ? "相对时间 / Relative" : key === "unknown" ? "未知时间 / Unknown" : key,
      events: grouped
    }))
  };
}

export function buildReviewPatterns(
  events: Event[], relations: EventRelation[], canonicalPerson: (id: string) => string,
  peopleById: Map<string, Person>
): ReviewPattern[] {
  const patterns: ReviewPattern[] = [];
  const add = (kind: ReviewPattern["kind"], title: string, summary: string, grouped: Event[], personIds: string[] = []) => {
    if (grouped.length < 2) return;
    const eventIds = [...new Set(grouped.map(({ id }) => id))];
    const key = `${kind}:${eventIds.sort().join(":")}:${title}`;
    patterns.push({
      id: createHash("sha256").update(key).digest("hex").slice(0, 32), kind, title, summary,
      eventIds, eventRevisionRefs: grouped.map(({ id, currentRevision }) => ({ eventId: id, revision: currentRevision })),
      personIds, sourceRefs: [...new Set(grouped.flatMap(({ sourceRefs }) => sourceRefs))]
    });
  };
  const byPerson = new Map<string, Event[]>();
  for (const event of events) for (const personId of new Set(event.participants.map(({ personId }) => canonicalPerson(personId)))) {
    byPerson.set(personId, [...(byPerson.get(personId) ?? []), event]);
  }
  for (const [personId, grouped] of byPerson) add(
    "person", `与 ${peopleById.get(personId)?.displayName ?? "同一人物"} 的重复事件 / Repeated events with the same person`,
    `${grouped.length} 条事件涉及同一人物。 / ${grouped.length} events involve the same person.`, grouped, [personId]
  );
  const byInterest = new Map<string, { label: string; events: Event[] }>();
  for (const event of events) for (const interest of event.interests) {
    const key = normalizeIdentity(interest.label);
    if (!key) continue;
    const existing = byInterest.get(key) ?? { label: interest.label, events: [] };
    existing.events.push(event);
    byInterest.set(key, existing);
  }
  for (const { label, events: grouped } of byInterest.values()) add(
    "topic", `重复主题 / Repeated topic: ${label}`,
    `${grouped.length} 条事件标记了相同的利益或主题。 / ${grouped.length} events share this interest or topic.`, grouped
  );
  for (const relation of relations.filter(({ status }) => status !== "rejected")) {
    const grouped = [events.find(({ id }) => id === relation.sourceEventId), events.find(({ id }) => id === relation.targetEventId)]
      .filter((event): event is Event => Boolean(event));
    add("relation", `事件关系 / Event relation: ${relation.kind}`,
      relation.basis.map(({ label }) => label).join("；") || "用户确认的事件关系 / User-confirmed relation.", grouped);
  }
  const byMonth = new Map<string, Event[]>();
  for (const event of events) {
    const start = temporalStart(event);
    if (start) byMonth.set(start.slice(0, 7), [...(byMonth.get(start.slice(0, 7)) ?? []), event]);
  }
  for (const [month, grouped] of byMonth) if (grouped.length >= 2) add(
    "time_cluster", `${month} 的事件集中 / Event cluster`,
    `${grouped.length} 条事件发生在同一月份；这表示时间聚集，不代表因果关系。 / ${grouped.length} events occurred in the same month; clustering does not imply causation.`, grouped
  );
  const unique = new Map(patterns.map((pattern) => [`${pattern.kind}:${pattern.eventIds.slice().sort().join(":")}:${pattern.title}`, pattern]));
  return [...unique.values()];
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    normA += a[index]! ** 2;
    normB += b[index]! ** 2;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

export function reciprocalRankFusion(keyword: UnifiedSearchHit[], semantic: UnifiedSearchHit[], limit: number): UnifiedSearchHit[] {
  const merged = new Map<string, UnifiedSearchHit>();
  keyword.forEach((hit, index) => {
    merged.set(`${hit.kind}:${hit.id}`, { ...hit, keywordScore: hit.keywordScore ?? 1 / (index + 1), combinedScore: 0.7 / (60 + index + 1) });
  });
  semantic.forEach((hit, index) => {
    const key = `${hit.kind}:${hit.id}`;
    const current = merged.get(key) ?? { ...hit, combinedScore: 0 };
    merged.set(key, { ...current, semanticScore: hit.semanticScore ?? 0, combinedScore: current.combinedScore + 0.3 / (60 + index + 1) });
  });
  return [...merged.values()].sort((a, b) => b.combinedScore - a.combinedScore).slice(0, limit);
}
