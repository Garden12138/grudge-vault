import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentAction, AgentModelSettings, AgentRun, Asset, BackfillRun, CandidateDetail, CandidateSummary, Conversation, Event, EventDetail,
  EmbeddingIndexStatus, EventRelation, EventRevision, ImportFolderStatus, ImportRun, ImportRunDetail, Job, LocalProcessorStatus,
  MediaProcessingSettings, Message, Person, PersonIdentityDetail, PersonMergeSuggestion, Reminder, ReviewAutomationSettings,
  ReviewRun, SourceReferenceDetail, StatementKind,
  TemporalValue, TimelineResult, UnifiedSearchHit, Workspace, WorkspaceLockState
} from "@grudge-vault/domain";
import type { EventWriteFields, IpcResult } from "@grudge-vault/shared";
import { detectLanguage, translator, type Language } from "./i18n";
import { CasesPanel, EvidencePanel, WorkspaceSecurityPanel } from "./PhaseFive";

type View = "chat" | "events" | "search" | "timeline" | "people" | "review" | "backfill" | "vault" | "evidence" | "cases" | "settings";

interface EventForm {
  title: string;
  status: Event["status"];
  temporalKind: TemporalValue["kind"];
  temporalValue: string;
  temporalEnd: string;
  narrative: string;
  facts: string;
  interpretations: string;
  emotions: string;
  interests: string;
  personIds: string[];
}

interface PreviewState {
  fileName: string;
  mimeType: string;
  url?: string;
  text?: string;
}

const EMPTY_FORM: EventForm = {
  title: "", status: "candidate", temporalKind: "unknown", temporalValue: "", temporalEnd: "",
  narrative: "", facts: "", interpretations: "", emotions: "", interests: "", personIds: []
};

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1_024; index += 1) {
    value /= 1_024;
    unit = units[index]!;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function formatJournalTimestamp(value: string, language: Language, timeZone?: string): string {
  const date = new Date(value);
  try {
    return date.toLocaleString(language, timeZone ? { timeZone } : undefined);
  } catch {
    return date.toLocaleString(language);
  }
}

function eventToForm(event: Event): EventForm {
  const temporal = event.occurredAt;
  let temporalValue = "";
  let temporalEnd = "";
  if (temporal.kind === "instant") temporalValue = temporal.value.slice(0, 16);
  if (temporal.kind === "date" || temporal.kind === "month") temporalValue = temporal.value;
  if (temporal.kind === "relative") temporalValue = temporal.text;
  if (temporal.kind === "range") {
    temporalValue = temporal.from ?? "";
    temporalEnd = temporal.to ?? "";
  }
  const facts = event.facts.map(({ kind, text }) => {
    const prefix = kind === "fact.disputed" ? "[disputed] " : kind === "fact.unknown" ? "[unknown] " : "[confirmed] ";
    return `${prefix}${text}`;
  }).join("\n");
  return {
    title: event.title, status: event.status, temporalKind: temporal.kind,
    temporalValue, temporalEnd, narrative: event.narrative ?? "", facts,
    interpretations: event.interpretations.map(({ text }) => text).join("\n"),
    emotions: event.emotions.map(({ label, intensity }) => `${label}${intensity ? `|${intensity}` : ""}`).join("\n"),
    interests: event.interests.map(({ label, description }) => `${label}${description ? `|${description}` : ""}`).join("\n"),
    personIds: event.participants.map(({ personId }) => personId)
  };
}

function temporalFromForm(form: EventForm): TemporalValue {
  if (form.temporalKind === "date") return { kind: "date", value: form.temporalValue };
  if (form.temporalKind === "month") return { kind: "month", value: form.temporalValue };
  if (form.temporalKind === "instant") return { kind: "instant", value: new Date(form.temporalValue).toISOString() };
  if (form.temporalKind === "relative") return { kind: "relative", text: form.temporalValue.trim() };
  if (form.temporalKind === "range") {
    const value: Extract<TemporalValue, { kind: "range" }> = { kind: "range" };
    if (form.temporalValue) value.from = form.temporalValue;
    if (form.temporalEnd) value.to = form.temporalEnd;
    return value;
  }
  return { kind: "unknown" };
}

function nonEmptyLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function formFields(form: EventForm, current?: Event): EventWriteFields {
  const sourceRefs = current?.sourceRefs ?? [];
  const facts = nonEmptyLines(form.facts).map((line) => {
    let kind: StatementKind = "fact.confirmed";
    let text = line;
    if (/^\[disputed\]/i.test(line)) { kind = "fact.disputed"; text = line.replace(/^\[disputed\]\s*/i, ""); }
    else if (/^\[unknown\]/i.test(line)) { kind = "fact.unknown"; text = line.replace(/^\[unknown\]\s*/i, ""); }
    else text = line.replace(/^\[confirmed\]\s*/i, "");
    return { id: window.crypto.randomUUID(), kind, text, sourceRefs };
  });
  return {
    title: form.title.trim(), status: form.status, occurredAt: temporalFromForm(form),
    ...(form.narrative.trim() ? { narrative: form.narrative.trim() } : {}), facts,
    interpretations: nonEmptyLines(form.interpretations).map((text) => ({
      id: window.crypto.randomUUID(), kind: "interpretation.user" as const, text, sourceRefs
    })),
    emotions: nonEmptyLines(form.emotions).map((line) => {
      const [label = "", rawIntensity] = line.split("|", 2);
      const numeric = Number(rawIntensity);
      const emotion = { id: window.crypto.randomUUID(), label: label.trim(), sourceRefs };
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 5) {
        return { ...emotion, intensity: numeric as 1 | 2 | 3 | 4 | 5 };
      }
      return emotion;
    }),
    interests: nonEmptyLines(form.interests).map((line) => {
      const [label = "", description] = line.split("|", 2);
      return {
        id: window.crypto.randomUUID(), label: label.trim(), sourceRefs,
        ...(description?.trim() ? { description: description.trim() } : {})
      };
    }),
    participants: form.personIds.map((personId) => ({ personId })),
    sourceRefs, assetRefs: current?.assetRefs ?? []
  };
}

export function App() {
  const [language, setLanguage] = useState<Language>(detectLanguage);
  const t = useMemo(() => translator(language), [language]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [lockState, setLockState] = useState<WorkspaceLockState>({ status: "closed" });
  const [recoveryPassphrase, setRecoveryPassphrase] = useState("");
  const [workspaceName, setWorkspaceName] = useState(language === "zh-CN" ? "我的记仇账本" : "My Grudge Vault");
  const [view, setView] = useState<View>("chat");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [newConversationTitle, setNewConversationTitle] = useState("");
  const [messageText, setMessageText] = useState("");
  const [composerMode, setComposerMode] = useState<"agent" | "quick" | "source">("agent");
  const [lastDraft, setLastDraft] = useState<Event>();
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
  const [pendingAgentRun, setPendingAgentRun] = useState<AgentRun>();
  const [agentSettings, setAgentSettings] = useState<AgentModelSettings>();
  const [agentMode, setAgentMode] = useState<AgentModelSettings["mode"]>("private");
  const [agentPrivateBaseUrl, setAgentPrivateBaseUrl] = useState("");
  const [agentPrivateModel, setAgentPrivateModel] = useState("");
  const [agentEnhancedBaseUrl, setAgentEnhancedBaseUrl] = useState("https://api.openai.com/v1");
  const [agentEnhancedModel, setAgentEnhancedModel] = useState("");
  const [agentApiKey, setAgentApiKey] = useState("");

  const [events, setEvents] = useState<Event[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [personIdentities, setPersonIdentities] = useState<PersonIdentityDetail[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const [eventDetail, setEventDetail] = useState<EventDetail>();
  const [revisions, setRevisions] = useState<EventRevision[]>([]);
  const [eventForm, setEventForm] = useState<EventForm>(EMPTY_FORM);
  const [queryText, setQueryText] = useState("");
  const [queryStatus, setQueryStatus] = useState("");
  const [queryPerson, setQueryPerson] = useState("");
  const [queryFrom, setQueryFrom] = useState("");
  const [queryTo, setQueryTo] = useState("");
  const [personName, setPersonName] = useState("");

  const [assets, setAssets] = useState<Asset[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [preview, setPreview] = useState<PreviewState>();
  const [importRuns, setImportRuns] = useState<ImportRun[]>([]);
  const [selectedImportId, setSelectedImportId] = useState<string>();
  const [importDetail, setImportDetail] = useState<ImportRunDetail>();
  const [backfillRuns, setBackfillRuns] = useState<BackfillRun[]>([]);
  const [candidates, setCandidates] = useState<CandidateSummary[]>([]);
  const [candidateDetail, setCandidateDetail] = useState<CandidateDetail>();
  const [backfillFrom, setBackfillFrom] = useState("");
  const [backfillTo, setBackfillTo] = useState("");
  const [backfillTags, setBackfillTags] = useState("");
  const [backfillBatchSize, setBackfillBatchSize] = useState("25");
  const [mergeTargetId, setMergeTargetId] = useState("");

  const [unifiedQuery, setUnifiedQuery] = useState("");
  const [unifiedHits, setUnifiedHits] = useState<UnifiedSearchHit[]>([]);
  const [semanticSearch, setSemanticSearch] = useState(false);
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingIndexStatus>();
  const [timeline, setTimeline] = useState<TimelineResult>();
  const [timelinePerson, setTimelinePerson] = useState("");
  const [timelineFrom, setTimelineFrom] = useState("");
  const [timelineTo, setTimelineTo] = useState("");
  const [selectedPerson, setSelectedPerson] = useState<PersonIdentityDetail>();
  const [mergeSuggestions, setMergeSuggestions] = useState<PersonMergeSuggestion[]>([]);
  const [aliasValue, setAliasValue] = useState("");
  const [relations, setRelations] = useState<EventRelation[]>([]);
  const [relationTargetId, setRelationTargetId] = useState("");
  const [relationKind, setRelationKind] = useState<EventRelation["kind"]>("similar");
  const [reviews, setReviews] = useState<ReviewRun[]>([]);
  const [selectedReview, setSelectedReview] = useState<ReviewRun>();
  const today = new Date().toISOString().slice(0, 10);
  const [reviewFrom, setReviewFrom] = useState(`${today.slice(0, 7)}-01`);
  const [reviewTo, setReviewTo] = useState(today);
  const [globalClarifications, setGlobalClarifications] = useState<import("@grudge-vault/domain").Clarification[]>([]);
  const [sourceDetail, setSourceDetail] = useState<SourceReferenceDetail>();
  const [processorStatus, setProcessorStatus] = useState<LocalProcessorStatus>();
  const [importFolderStatus, setImportFolderStatus] = useState<ImportFolderStatus>();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [reviewAutomation, setReviewAutomation] = useState<ReviewAutomationSettings>();
  const agentRunByAssistantMessage = useMemo(() => new Map(
    agentRuns.filter(({ assistantMessageId }) => Boolean(assistantMessageId)).map((run) => [run.assistantMessageId!, run])
  ), [agentRuns]);

  const searchEvents = useCallback(async () => {
    const result = await window.grudgeVault.events.search({
      ...(queryText.trim() ? { text: queryText.trim() } : {}),
      ...(queryStatus ? { status: queryStatus as Event["status"] } : {}),
      ...(queryPerson ? { personId: queryPerson } : {}),
      ...(queryFrom ? { from: queryFrom } : {}),
      ...(queryTo ? { to: queryTo } : {})
    });
    if (result.ok) setEvents(result.data);
    else setError(result.error.message);
  }, [queryFrom, queryPerson, queryStatus, queryText, queryTo]);

  const refreshLists = useCallback(async () => {
    const [conversationResult, eventResult, peopleResult, assetResult, jobResult, importResult, backfillResult, candidateResult,
      embeddingResult, reviewResult, clarificationResult, identityResult, agentSettingsResult, processorResult,
      importFolderResult, reminderResult, reviewAutomationResult] = await Promise.all([
      window.grudgeVault.conversations.list(), window.grudgeVault.events.search({}),
      window.grudgeVault.people.list(), window.grudgeVault.assets.list(), window.grudgeVault.jobs.list(),
      window.grudgeVault.imports.list(), window.grudgeVault.backfill.list(), window.grudgeVault.candidates.list(),
      window.grudgeVault.search.getEmbeddingStatus(), window.grudgeVault.reviews.list(), window.grudgeVault.clarifications.list(),
      window.grudgeVault.people.listIdentities(), window.grudgeVault.agent.getSettings(),
      window.grudgeVault.localIntelligence.status(), window.grudgeVault.importFolder.status(),
      window.grudgeVault.reminders.list(), window.grudgeVault.reminders.getSettings()
    ]);
    if (conversationResult.ok) {
      setConversations(conversationResult.data);
      setSelectedConversationId((current) => current && conversationResult.data.some(({ id }) => id === current)
        ? current : conversationResult.data[0]?.id);
    } else setError(conversationResult.error.message);
    if (eventResult.ok) setEvents(eventResult.data); else setError(eventResult.error.message);
    if (peopleResult.ok) setPeople(peopleResult.data); else setError(peopleResult.error.message);
    if (assetResult.ok) setAssets(assetResult.data); else setError(assetResult.error.message);
    if (jobResult.ok) setJobs(jobResult.data); else setError(jobResult.error.message);
    if (importResult.ok) {
      setImportRuns(importResult.data);
      setSelectedImportId((current) => current && importResult.data.some(({ id }) => id === current) ? current : importResult.data[0]?.id);
    } else setError(importResult.error.message);
    if (backfillResult.ok) setBackfillRuns(backfillResult.data); else setError(backfillResult.error.message);
    if (candidateResult.ok) setCandidates(candidateResult.data); else setError(candidateResult.error.message);
    if (embeddingResult.ok) {
      setEmbeddingStatus(embeddingResult.data);
      setSemanticSearch(embeddingResult.data.enabled);
    } else setError(embeddingResult.error.message);
    if (reviewResult.ok) {
      setReviews(reviewResult.data);
      setSelectedReview((current) => current ? reviewResult.data.find(({ id }) => id === current.id) : reviewResult.data[0]);
    } else setError(reviewResult.error.message);
    if (clarificationResult.ok) setGlobalClarifications(clarificationResult.data); else setError(clarificationResult.error.message);
    if (identityResult.ok) setPersonIdentities(identityResult.data); else setError(identityResult.error.message);
    if (agentSettingsResult.ok) {
      const settings = agentSettingsResult.data;
      setAgentSettings(settings); setAgentMode(settings.mode);
      setAgentPrivateBaseUrl(settings.privateEndpoint?.baseUrl ?? "");
      setAgentPrivateModel(settings.privateEndpoint?.model ?? "");
      setAgentEnhancedBaseUrl(settings.enhancedEndpoint?.baseUrl ?? "https://api.openai.com/v1");
      setAgentEnhancedModel(settings.enhancedEndpoint?.model ?? "");
    } else setError(agentSettingsResult.error.message);
    if (processorResult.ok) setProcessorStatus(processorResult.data); else setError(processorResult.error.message);
    if (importFolderResult.ok) setImportFolderStatus(importFolderResult.data); else setError(importFolderResult.error.message);
    if (reminderResult.ok) setReminders(reminderResult.data); else setError(reminderResult.error.message);
    if (reviewAutomationResult.ok) setReviewAutomation(reviewAutomationResult.data); else setError(reviewAutomationResult.error.message);
  }, []);

  const refresh = useCallback(async () => {
    const status = await window.grudgeVault.workspace.status();
    if (!status.ok) return setError(status.error.message);
    setLockState(status.data);
    if (status.data.status === "locked") {
      setWorkspace(null);
      return;
    }
    const current = await window.grudgeVault.workspace.current();
    if (!current.ok) return setError(current.error.message);
    setWorkspace(current.data);
    if (!current.data) return;
    await refreshLists();
  }, [refreshLists]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  useEffect(() => window.grudgeVault.jobs.onChanged(() => void refreshLists()), [refreshLists]);
  useEffect(() => window.grudgeVault.reminders.onDue((reminderId, shouldOpen) => {
    void refreshLists();
    if (!shouldOpen) return;
    setView("review");
    void Promise.all([window.grudgeVault.reminders.list(), window.grudgeVault.reviews.list()]).then(async ([reminderResult, reviewResult]) => {
      if (!reminderResult.ok) return setError(reminderResult.error.message);
      const reminder = reminderResult.data.find(({ id }) => id === reminderId);
      if (!reminder) return;
      const readResult = await window.grudgeVault.reminders.markRead(reminder.id);
      if (readResult.ok) setReminders((items) => items.map((item) => item.id === readResult.data.id ? readResult.data : item));
      if (reminder.reviewId && reviewResult.ok) setSelectedReview(reviewResult.data.find(({ id }) => id === reminder.reviewId));
    });
  }), [refreshLists]);
  useEffect(() => {
    if (!selectedConversationId) { setMessages([]); setAgentRuns([]); setPendingAgentRun(undefined); return; }
    void Promise.all([
      window.grudgeVault.conversations.listMessages(selectedConversationId),
      window.grudgeVault.agent.listRuns(selectedConversationId)
    ]).then(([messageResult, runResult]) => {
      if (messageResult.ok) setMessages(messageResult.data); else setError(messageResult.error.message);
      if (runResult.ok) {
        setAgentRuns(runResult.data);
        setPendingAgentRun(runResult.data.find(({ status }) => status === "awaiting_consent"));
      } else setError(runResult.error.message);
    });
  }, [selectedConversationId]);
  useEffect(() => {
    if (!selectedImportId) return setImportDetail(undefined);
    void window.grudgeVault.imports.get(selectedImportId).then((result) => {
      if (result.ok) setImportDetail(result.data); else setError(result.error.message);
    });
  }, [selectedImportId, importRuns]);
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview]);
  const clearSensitiveRendererState = useCallback(() => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview(undefined); setSourceDetail(undefined); setWorkspace(null); setMessages([]); setEvents([]); setPeople([]);
    setPersonIdentities([]); setAssets([]); setImportDetail(undefined); setCandidateDetail(undefined); setSelectedReview(undefined);
    setAgentRuns([]); setPendingAgentRun(undefined); setConversations([]); setTimeline(undefined); setUnifiedHits([]);
    setProcessorStatus(undefined); setImportFolderStatus(undefined); setReminders([]); setReviewAutomation(undefined);
    setLockState((current) => current.status === "open"
      ? { status: "locked", workspaceId: current.workspace.id, workspaceName: current.workspace.name }
      : current);
  }, [preview]);
  useEffect(() => window.grudgeVault.workspace.onLocked(clearSensitiveRendererState), [clearSensitiveRendererState]);

  const runWorkspaceAction = async (action: () => Promise<IpcResult<Workspace | null>>) => {
    setBusy(true); setError(undefined);
    const result = await action();
    setBusy(false);
    if (!result.ok) return setError(result.error.message);
    if (result.data) await refresh();
  };

  const openEvent = async (id: string, preserveForm = false) => {
    setSelectedEventId(id); setBusy(true);
    const [detailResult, revisionResult, relationResult] = await Promise.all([
      window.grudgeVault.events.get(id), window.grudgeVault.events.listRevisions(id),
      window.grudgeVault.relations.listForEvent(id)
    ]);
    setBusy(false);
    if (!detailResult.ok) return setError(detailResult.error.message);
    setEventDetail(detailResult.data);
    if (!preserveForm) setEventForm(eventToForm(detailResult.data.event));
    if (revisionResult.ok) setRevisions(revisionResult.data);
    if (relationResult.ok) setRelations(relationResult.data);
    setView("events");
  };

  const createConversationAction = async () => {
    if (!newConversationTitle.trim()) return;
    const result = await window.grudgeVault.conversations.create(newConversationTitle);
    if (!result.ok) return setError(result.error.message);
    setNewConversationTitle("");
    await refreshLists();
    setSelectedConversationId(result.data.id);
  };

  const refreshAgentConversation = async () => {
    if (!selectedConversationId) return;
    const [messageResult, runResult] = await Promise.all([
      window.grudgeVault.conversations.listMessages(selectedConversationId),
      window.grudgeVault.agent.listRuns(selectedConversationId)
    ]);
    if (messageResult.ok) setMessages(messageResult.data); else setError(messageResult.error.message);
    if (runResult.ok) {
      setAgentRuns(runResult.data);
      setPendingAgentRun(runResult.data.find(({ status }) => status === "awaiting_consent"));
    } else setError(runResult.error.message);
  };

  const sendMessage = async () => {
    if (!selectedConversationId || !messageText.trim()) return;
    setBusy(true); setError(undefined); setLastDraft(undefined);
    if (composerMode === "agent") {
      const result = await window.grudgeVault.agent.send({ conversationId: selectedConversationId, content: messageText });
      setBusy(false);
      if (!result.ok) return setError(result.error.message);
      setMessageText("");
      if (result.data.run.status === "awaiting_consent") setPendingAgentRun(result.data.run);
      await refreshAgentConversation();
      await refreshLists();
      return;
    }
    const result = await window.grudgeVault.conversations.send({
      conversationId: selectedConversationId, content: messageText, createDraft: composerMode === "quick"
    });
    setBusy(false);
    if (!result.ok) return setError(result.error.message);
    setMessageText("");
    setMessages((current) => [...current, result.data.message]);
    if (result.data.draft) setLastDraft(result.data.draft);
    if (result.data.draftError) setNotice(t("draftFailed"));
    await refreshLists();
  };

  const resumeAgentRun = async () => {
    const run = pendingAgentRun;
    if (!run?.disclosure) return;
    setBusy(true); setError(undefined);
    const result = await window.grudgeVault.agent.resume(run.id, run.disclosure.id);
    setBusy(false);
    if (!result.ok) return setError(result.error.message);
    setPendingAgentRun(undefined);
    await refreshAgentConversation(); await refreshLists();
  };

  const cancelAgentRun = async () => {
    if (!pendingAgentRun) return;
    const result = await window.grudgeVault.agent.cancel(pendingAgentRun.id);
    if (!result.ok) return setError(result.error.message);
    setPendingAgentRun(undefined); await refreshAgentConversation();
  };

  const resolveAgentAction = async (action: AgentAction, approve: boolean) => {
    const result = approve
      ? await window.grudgeVault.agent.approveAction(action.id)
      : await window.grudgeVault.agent.rejectAction(action.id);
    if (!result.ok) return setError(result.error.message);
    await refreshAgentConversation(); await refreshLists();
  };

  const saveAgentSettings = async () => {
    setBusy(true); setError(undefined);
    const endpoint = agentMode === "private"
      ? (agentPrivateBaseUrl.trim() && agentPrivateModel.trim() ? {
          privateEndpoint: {
            baseUrl: agentPrivateBaseUrl, model: agentPrivateModel,
            ...(agentApiKey.trim() ? { apiKey: agentApiKey } : {})
          }
        } : {})
      : {
          enhancedEndpoint: {
            baseUrl: agentEnhancedBaseUrl, model: agentEnhancedModel,
            ...(agentApiKey.trim() ? { apiKey: agentApiKey } : {})
          }
        };
    const result = await window.grudgeVault.agent.updateSettings({ mode: agentMode, ...endpoint });
    setBusy(false);
    if (!result.ok) return setError(result.error.message);
    setAgentSettings(result.data); setAgentApiKey(""); setNotice(t("agentSettingsSaved"));
  };

  const clearAgentCredential = async () => {
    const result = await window.grudgeVault.agent.clearCredential(agentMode);
    if (!result.ok) return setError(result.error.message);
    setAgentSettings(result.data); setNotice(t("credentialCleared"));
  };

  const createManualEvent = async () => {
    const result = await window.grudgeVault.events.create({
      title: language === "zh-CN" ? "新事件" : "New event", status: "candidate",
      occurredAt: { kind: "unknown" }, facts: [], interpretations: [], emotions: [], interests: [],
      participants: [], sourceRefs: [], assetRefs: [], reason: "Manual event created"
    });
    if (!result.ok) return setError(result.error.message);
    await refreshLists();
    await openEvent(result.data.id);
  };

  const saveEvent = async () => {
    if (!eventDetail || !eventForm.title.trim()) return setError(t("emptyRequired"));
    if (eventForm.temporalKind !== "unknown" && !eventForm.temporalValue && !eventForm.temporalEnd) {
      return setError(t("emptyRequired"));
    }
    setBusy(true); setError(undefined);
    const result = await window.grudgeVault.events.update({
      eventId: eventDetail.event.id, expectedRevision: eventDetail.event.currentRevision,
      ...formFields(eventForm, eventDetail.event), reason: "Edited by user"
    });
    setBusy(false);
    if (!result.ok) {
      if (result.error.code === "EVENT_REVISION_CONFLICT") {
        setError(t("revisionConflict"));
        await openEvent(eventDetail.event.id, true);
      } else setError(result.error.message);
      return;
    }
    await refreshLists();
    await openEvent(result.data.id);
  };

  const changeStatus = async (status: "confirmed" | "archived") => {
    if (!eventDetail) return;
    const apiCall = status === "confirmed" ? window.grudgeVault.events.confirm : window.grudgeVault.events.archive;
    const result = await apiCall(eventDetail.event.id, eventDetail.event.currentRevision);
    if (!result.ok) return setError(result.error.message);
    await refreshLists();
    await openEvent(result.data.id);
  };

  const addPerson = async () => {
    if (!personName.trim()) return;
    const result = await window.grudgeVault.people.create(personName);
    if (!result.ok) return setError(result.error.message);
    setPersonName("");
    await refreshLists();
    setEventForm((current) => ({ ...current, personIds: [...current.personIds, result.data.id] }));
  };

  const answerClarification = async (id: string) => {
    if (!eventDetail) return;
    const answer = window.prompt(t("answerPrompt"));
    if (!answer?.trim()) return;
    const result = await window.grudgeVault.clarifications.answer({
      clarificationId: id, answer, expectedRevision: eventDetail.event.currentRevision
    });
    if (!result.ok) return setError(result.error.message);
    await refreshLists(); await openEvent(result.data.id);
  };

  const dismissClarification = async (id: string) => {
    if (!eventDetail) return;
    const result = await window.grudgeVault.clarifications.dismiss(id, eventDetail.event.currentRevision);
    if (!result.ok) return setError(result.error.message);
    await refreshLists(); await openEvent(result.data.id);
  };

  const attachFiles = async (files: File[]) => {
    if (!eventDetail || files.length === 0) return;
    const result = await window.grudgeVault.assets.importForEvent(
      files, eventDetail.event.id, eventDetail.event.currentRevision
    );
    if (!result.ok) return setError(result.error.message);
    await refreshLists(); await openEvent(result.data.id);
  };

  const importVaultFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const result = await window.grudgeVault.assets.importDropped(files);
    if (!result.ok) setError(result.error.message);
    await refreshLists();
  };

  const chooseDayOneZip = async () => {
    setBusy(true); setError(undefined);
    const result = await window.grudgeVault.imports.chooseDayOneZip();
    setBusy(false);
    if (!result.ok) return setError(result.error.message);
    if (result.data) {
      setSelectedImportId(result.data.id);
      setNotice(t("importQueued"));
      await refreshLists();
    }
  };

  const chooseImportFolder = async () => {
    const result = await window.grudgeVault.importFolder.choose();
    if (!result.ok) return setError(result.error.message);
    if (result.data) setImportFolderStatus(result.data);
  };

  const updateImportFolder = async (enabled: boolean) => {
    const result = await window.grudgeVault.importFolder.setEnabled(enabled);
    if (!result.ok) return setError(result.error.message);
    setImportFolderStatus(result.data);
  };

  const scanImportFolder = async () => {
    const result = await window.grudgeVault.importFolder.scanNow();
    if (!result.ok) return setError(result.error.message);
    setImportFolderStatus(result.data);
    await refreshLists();
  };

  const chooseProcessorPath = async (kind: "tesseract" | "poppler" | "ffmpeg" | "whisper" | "whisper_model") => {
    const result = await window.grudgeVault.localIntelligence.choosePath(kind);
    if (!result.ok) return setError(result.error.message);
    if (result.data) setProcessorStatus(result.data);
  };

  const updateMediaSettings = async (patch: Partial<MediaProcessingSettings>) => {
    if (!processorStatus) return;
    const result = await window.grudgeVault.localIntelligence.updateSettings({ ...processorStatus.settings, ...patch });
    if (!result.ok) return setError(result.error.message);
    setProcessorStatus(result.data);
  };

  const probeProcessors = async () => {
    const result = await window.grudgeVault.localIntelligence.probe();
    if (!result.ok) return setError(result.error.message);
    setProcessorStatus(result.data);
  };

  const processHistoricalMedia = async () => {
    const count = processorStatus?.eligibleHistoricalAssets ?? 0;
    if (count === 0) return;
    const message = language === "zh-CN" ? `将为 ${count} 个历史附件创建本地处理任务，继续吗？`
      : `Create local processing tasks for ${count} historical attachments?`;
    if (!window.confirm(message)) return;
    const result = await window.grudgeVault.localIntelligence.processHistorical();
    if (!result.ok) return setError(result.error.message);
    setNotice(language === "zh-CN" ? `已排队 ${result.data.length} 个媒体任务。` : `${result.data.length} media tasks queued.`);
    await refreshLists();
  };

  const updateAutomation = async (patch: Partial<ReviewAutomationSettings>) => {
    if (!reviewAutomation) return;
    const result = await window.grudgeVault.reminders.updateSettings({ ...reviewAutomation, ...patch });
    if (!result.ok) return setError(result.error.message);
    setReviewAutomation(result.data);
  };

  const openReminder = async (reminder: Reminder) => {
    const result = await window.grudgeVault.reminders.markRead(reminder.id);
    if (!result.ok) return setError(result.error.message);
    setReminders((items) => items.map((item) => item.id === result.data.id ? result.data : item));
    if (reminder.reviewId) {
      const review = reviews.find(({ id }) => id === reminder.reviewId);
      if (review) setSelectedReview(review);
    }
    setView("review");
  };

  const startBackfill = async () => {
    const importRunId = selectedImportId && importRuns.find(({ id }) => id === selectedImportId)?.state === "succeeded"
      ? selectedImportId : undefined;
    const result = await window.grudgeVault.backfill.start({
      ...(importRunId ? { importRunId } : {}), ...(backfillFrom ? { from: backfillFrom } : {}),
      ...(backfillTo ? { to: backfillTo } : {}), tags: backfillTags.split(",").map((tag) => tag.trim()).filter(Boolean),
      batchSize: Number(backfillBatchSize) || 25
    });
    if (!result.ok) return setError(result.error.message);
    setNotice(t("backfillQueued"));
    await refreshLists();
  };

  const changeBackfill = async (run: BackfillRun, action: "pause" | "resume" | "cancel") => {
    const result = await window.grudgeVault.backfill[action](run.id);
    if (!result.ok) return setError(result.error.message);
    await refreshLists();
  };

  const inspectCandidate = async (eventId: string) => {
    const result = await window.grudgeVault.candidates.get(eventId);
    if (!result.ok) return setError(result.error.message);
    setCandidateDetail(result.data);
    setMergeTargetId("");
  };

  const reviewCandidate = async (action: "confirm" | "ignore") => {
    if (!candidateDetail) return;
    const result = await window.grudgeVault.candidates[action](
      candidateDetail.event.id, candidateDetail.event.currentRevision
    );
    if (!result.ok) return setError(result.error.message);
    setCandidateDetail(undefined);
    await refreshLists();
  };

  const mergeCandidate = async () => {
    if (!candidateDetail || !mergeTargetId) return;
    const target = events.find(({ id }) => id === mergeTargetId);
    if (!target) return;
    const result = await window.grudgeVault.candidates.merge({
      candidateEventId: candidateDetail.event.id,
      candidateExpectedRevision: candidateDetail.event.currentRevision,
      targetEventId: target.id,
      targetExpectedRevision: target.currentRevision
    });
    if (!result.ok) return setError(result.error.message);
    setCandidateDetail(undefined); setMergeTargetId("");
    await refreshLists();
  };

  const editPerson = async (person: Person) => {
    const displayName = window.prompt(t("personName"), person.displayName);
    if (!displayName?.trim()) return;
    const notes = window.prompt(t("personNotes"), person.notes ?? "") ?? person.notes;
    const result = await window.grudgeVault.people.update({
      id: person.id, displayName, ...(notes === undefined ? {} : { notes })
    });
    if (!result.ok) setError(result.error.message); else await refreshLists();
  };

  const runUnifiedSearch = async () => {
    const result = await window.grudgeVault.search.query({ text: unifiedQuery, semantic: semanticSearch, limit: 50 });
    if (!result.ok) setError(result.error.message); else setUnifiedHits(result.data);
  };

  const toggleSemanticSearch = async (enabled: boolean) => {
    const result = await window.grudgeVault.search.setSemanticEnabled(enabled);
    if (!result.ok) return setError(result.error.message);
    setSemanticSearch(enabled); setEmbeddingStatus(result.data);
  };

  const openSource = async (sourceItemId: string) => {
    const result = await window.grudgeVault.sources.getReference(sourceItemId);
    if (!result.ok) setError(result.error.message); else setSourceDetail(result.data);
  };

  const loadTimeline = async () => {
    const result = await window.grudgeVault.timeline.query({
      ...(timelinePerson ? { personId: timelinePerson } : {}),
      ...(timelineFrom ? { from: timelineFrom } : {}), ...(timelineTo ? { to: timelineTo } : {})
    });
    if (!result.ok) setError(result.error.message); else setTimeline(result.data);
  };

  const openPerson = async (id: string) => {
    const result = await window.grudgeVault.people.get(id);
    if (!result.ok) setError(result.error.message); else setSelectedPerson(result.data);
  };

  const loadMergeSuggestions = async () => {
    const result = await window.grudgeVault.people.listMergeSuggestions();
    if (!result.ok) setError(result.error.message); else setMergeSuggestions(result.data);
  };

  const addAlias = async () => {
    if (!selectedPerson || !aliasValue.trim()) return;
    const result = await window.grudgeVault.people.addAlias({ personId: selectedPerson.canonicalPerson.id, value: aliasValue });
    if (!result.ok) return setError(result.error.message);
    setAliasValue("");
    await openPerson(selectedPerson.canonicalPerson.id);
    await loadMergeSuggestions();
  };

  const mergePeople = async (suggestion: PersonMergeSuggestion) => {
    const result = await window.grudgeVault.people.merge({
      sourcePersonId: suggestion.personAId, targetPersonId: suggestion.personBId, suggestionId: suggestion.id
    });
    if (!result.ok) return setError(result.error.message);
    await refreshLists(); await loadMergeSuggestions(); await openPerson(result.data.targetPersonId);
  };

  const rejectPersonMerge = async (id: string) => {
    const result = await window.grudgeVault.people.rejectMergeSuggestion(id);
    if (!result.ok) setError(result.error.message); else await loadMergeSuggestions();
  };

  const revertPersonMerge = async (id: string) => {
    const result = await window.grudgeVault.people.revertMerge(id);
    if (!result.ok) return setError(result.error.message);
    await refreshLists(); await loadMergeSuggestions();
    if (selectedPerson) await openPerson(selectedPerson.canonicalPerson.id);
  };

  const refreshRelations = async () => {
    const result = await window.grudgeVault.relations.refreshSuggestions();
    if (!result.ok) return setError(result.error.message);
    if (eventDetail) {
      const related = await window.grudgeVault.relations.listForEvent(eventDetail.event.id);
      if (related.ok) setRelations(related.data);
    }
  };

  const createRelation = async () => {
    if (!eventDetail || !relationTargetId) return;
    const result = await window.grudgeVault.relations.create({
      sourceEventId: eventDetail.event.id, targetEventId: relationTargetId, kind: relationKind
    });
    if (!result.ok) return setError(result.error.message);
    setRelationTargetId("");
    const related = await window.grudgeVault.relations.listForEvent(eventDetail.event.id);
    if (related.ok) setRelations(related.data);
  };

  const decideRelation = async (relation: EventRelation, action: "confirm" | "reject" | "remove") => {
    const result = await window.grudgeVault.relations[action](relation.id);
    if (!result.ok) return setError(result.error.message);
    if (!eventDetail) return;
    const related = await window.grudgeVault.relations.listForEvent(eventDetail.event.id);
    if (related.ok) setRelations(related.data);
  };

  const generateReview = async () => {
    const result = await window.grudgeVault.reviews.generate({ from: reviewFrom, to: reviewTo });
    if (!result.ok) return setError(result.error.message);
    setSelectedReview(result.data);
    await refreshLists();
  };

  const setReviewPreset = (preset: "month" | "quarter") => {
    const now = new Date();
    const year = now.getFullYear();
    const startMonth = preset === "month" ? now.getMonth() : Math.floor(now.getMonth() / 3) * 3;
    const endMonth = preset === "month" ? now.getMonth() : startMonth + 2;
    const pad = (value: number) => String(value).padStart(2, "0");
    setReviewFrom(`${year}-${pad(startMonth + 1)}-01`);
    setReviewTo(`${year}-${pad(endMonth + 1)}-${pad(new Date(year, endMonth + 1, 0).getDate())}`);
  };

  const changeClarificationPriority = async (
    id: string, priority: import("@grudge-vault/domain").Clarification["priority"]
  ) => {
    const result = await window.grudgeVault.clarifications.setPriority(id, priority);
    if (!result.ok) setError(result.error.message); else await refreshLists();
  };

  const answerGlobalClarification = async (item: import("@grudge-vault/domain").Clarification) => {
    const answer = window.prompt(t("answerPrompt"));
    if (!answer?.trim()) return;
    const detail = await window.grudgeVault.events.get(item.eventId);
    if (!detail.ok) return setError(detail.error.message);
    const result = await window.grudgeVault.clarifications.answer({
      clarificationId: item.id, answer, expectedRevision: detail.data.event.currentRevision
    });
    if (!result.ok) setError(result.error.message); else await refreshLists();
  };

  const dismissGlobalClarification = async (item: import("@grudge-vault/domain").Clarification) => {
    const detail = await window.grudgeVault.events.get(item.eventId);
    if (!detail.ok) return setError(detail.error.message);
    const result = await window.grudgeVault.clarifications.dismiss(item.id, detail.data.event.currentRevision);
    if (!result.ok) setError(result.error.message); else await refreshLists();
  };

  const previewAsset = async (assetId: string) => {
    setError(undefined);
    const result = await window.grudgeVault.assets.preview(assetId);
    if (!result.ok) return setError(result.error.code === "ASSET_PREVIEW_UNAVAILABLE" ? t("previewUnavailable") : result.error.message);
    const bytes = Uint8Array.from(result.data.bytes);
    if (result.data.mimeType.startsWith("text/") || result.data.mimeType === "application/json") {
      setPreview({ fileName: result.data.fileName, mimeType: result.data.mimeType, text: new window.TextDecoder().decode(bytes) });
    } else {
      const url = URL.createObjectURL(new window.Blob([bytes.buffer], { type: result.data.mimeType }));
      setPreview({ fileName: result.data.fileName, mimeType: result.data.mimeType, url });
    }
  };

  const setAppLanguage = (next: Language) => {
    window.localStorage.setItem("grudge-vault.language", next);
    document.documentElement.lang = next;
    setLanguage(next);
  };

  if (lockState.status === "locked") {
    const unlock = async () => {
      setBusy(true); setError(undefined);
      const result = await window.grudgeVault.workspace.unlock();
      setBusy(false);
      if (!result.ok) return setError(result.error.message);
      await refresh();
    };
    const recover = async () => {
      setBusy(true); setError(undefined);
      const result = await window.grudgeVault.workspace.recover({ passphrase: recoveryPassphrase });
      setRecoveryPassphrase(""); setBusy(false);
      if (!result.ok) return setError(result.error.message);
      await refresh();
    };
    return <main className="landing locked-landing"><section className="landing-card">
      <div className="language-pills"><button className={language === "zh-CN" ? "active" : ""} onClick={() => setAppLanguage("zh-CN")}>中文</button>
        <button className={language === "en" ? "active" : ""} onClick={() => setAppLanguage("en")}>EN</button></div>
      <p className="eyebrow">WORKSPACE LOCKED</p><h1>{language === "zh-CN" ? "工作区已锁定" : "Workspace locked"}</h1>
      <p className="lede">{language === "zh-CN" ? "实体正文、预览和本地路径已从界面清除。使用系统钥匙串解锁。" : "Entity content, previews, and local paths have been cleared. Unlock with the OS key store."}</p>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="landing-actions"><button className="primary" disabled={busy} onClick={() => void unlock()}>{language === "zh-CN" ? "使用系统钥匙串解锁" : "Unlock with OS key store"}</button></div>
      <details className="recovery-unlock"><summary>{language === "zh-CN" ? "钥匙串不可用？重新绑定恢复包" : "Key store unavailable? Rebind a recovery package"}</summary>
        <p className="security-note">{language === "zh-CN" ? "恢复包只用于重新绑定钥匙串，不会直接解锁日常会话。" : "Recovery packages only rebind the key store; they are not a routine unlock method."}</p>
        <label className="field"><span>{language === "zh-CN" ? "恢复口令（不少于 12 字符）" : "Recovery passphrase (12+ characters)"}</span>
          <input type="password" value={recoveryPassphrase} onChange={(event) => setRecoveryPassphrase(event.target.value)} /></label>
        <button disabled={busy || Array.from(recoveryPassphrase).length < 12} onClick={() => void recover()}>{language === "zh-CN" ? "选择 .gvrecovery 并重新绑定" : "Choose .gvrecovery and rebind"}</button>
      </details>
    </section></main>;
  }

  if (!workspace) {
    return <main className="landing"><section className="landing-card">
      <div className="language-pills">
        <button className={language === "zh-CN" ? "active" : ""} onClick={() => setAppLanguage("zh-CN")}>中文</button>
        <button className={language === "en" ? "active" : ""} onClick={() => setAppLanguage("en")}>EN</button>
      </div>
      <p className="eyebrow">{t("localFirst")}</p><h1>{t("appName")}</h1><p className="lede">{t("landingLede")}</p>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <label className="field"><span>{t("workspaceName")}</span>
        <input value={workspaceName} maxLength={120} onChange={(event) => setWorkspaceName(event.target.value)} />
      </label>
      <div className="landing-actions">
        <button className="primary" disabled={busy || !workspaceName.trim()}
          onClick={() => void runWorkspaceAction(() => window.grudgeVault.workspace.create(workspaceName))}>{t("createWorkspace")}</button>
        <button disabled={busy} onClick={() => void runWorkspaceAction(() => window.grudgeVault.workspace.open())}>{t("openWorkspace")}</button>
      </div><p className="security-note">{t("securityNote")}</p>
    </section></main>;
  }

  return <main className="app-shell">
    <aside className="app-sidebar">
      <div className="brand"><p className="eyebrow">GRUDGE VAULT</p><h1>{t("appName")}</h1></div>
      <nav>
        {(["chat", "events", "search", "timeline", "people", "review", "backfill", "vault", "evidence", "cases", "settings"] as View[]).map((item) =>
          <button key={item} className={view === item ? "active" : ""} onClick={() => {
            setView(item);
            if (item === "timeline") void loadTimeline();
            if (item === "people") {
              void loadMergeSuggestions();
              if (!selectedPerson && personIdentities[0]) void openPerson(personIdentities[0].canonicalPerson.id);
            }
          }}>{t(item)}</button>)}
      </nav>
      <div className="workspace-card"><strong>{workspace.name}</strong><span>{workspace.rootPath}</span><em>{t("encryptedLocally")}</em></div>
    </aside>
    <section className="workspace-view">
      {(error || notice) && <div className={error ? "error-banner sticky" : "notice-banner sticky"} role="alert">
        <span>{error ?? notice}</span><button onClick={() => { setError(undefined); setNotice(undefined); }}>×</button>
      </div>}

      {view === "chat" && <div className="chat-layout">
        <aside className="conversation-panel panel">
          <div className="section-heading"><div><p className="eyebrow">CHAT SOURCES</p><h2>{t("conversations")}</h2></div></div>
          <div className="inline-create"><input aria-label={t("conversationTitle")} placeholder={t("conversationTitle")}
            value={newConversationTitle} onChange={(event) => setNewConversationTitle(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void createConversationAction(); }} />
            <button onClick={() => void createConversationAction()}>＋</button></div>
          <div className="conversation-list">{conversations.map((conversation) =>
            <article key={conversation.id} className={selectedConversationId === conversation.id ? "selected" : ""}
              onClick={() => setSelectedConversationId(conversation.id)}>
              <strong>{conversation.title}</strong><span>{new Date(conversation.updatedAt).toLocaleString(language)}</span>
              <div className="row-actions">
                <button onClick={(event) => { event.stopPropagation(); const title = window.prompt(t("conversationTitle"), conversation.title); if (title?.trim()) void window.grudgeVault.conversations.rename(conversation.id, title).then(refreshLists); }}>{t("rename")}</button>
                <button onClick={(event) => { event.stopPropagation(); if (window.confirm(t("deletedConversationWarning"))) void window.grudgeVault.conversations.delete(conversation.id).then(refreshLists); }}>{t("delete")}</button>
              </div>
            </article>)}</div>
        </aside>
        <section className="chat-main panel">
          {!selectedConversationId ? <div className="empty">{t("noConversation")}</div> : <>
            <div className="message-list">{messages.length === 0 ? <div className="empty">{t("noMessages")}</div> : messages.map((message) => {
              const run = agentRunByAssistantMessage.get(message.id);
              return <article className={`message-bubble ${message.role}`} key={message.id}>
                <p>{message.content ?? t("sourceDeleted")}</p>
                <span>{new Date(message.createdAt).toLocaleString(language)}</span>
                {run && <div className="agent-turn">
                  <div className="agent-run-meta"><em>{run.intent}</em><em className={`status ${run.status}`}>{run.status}</em>
                    {run.errorCode && <span>{t("agentFallback")}: {run.errorCode}</span>}</div>
                  {run.analysis && <div className="agent-analysis">{[
                    [t("confirmedFacts"), run.analysis.confirmedFacts],
                    [t("unknownFacts"), run.analysis.disputedOrUnknown],
                    [t("interpretations"), run.analysis.interpretations],
                    [t("emotions"), run.analysis.emotions],
                    [t("interests"), run.analysis.interests],
                    [t("historicalPatterns"), run.analysis.historicalPatterns],
                    [t("risks"), run.analysis.risks]
                  ].map(([label, items]) => Array.isArray(items) && items.length > 0 && <section key={String(label)}>
                    <h4>{String(label)}</h4>{items.map((item) => <p key={item.id}>
                      {item.kind === "interpretation.agent" ? `${t("agentInterpretation")}: ${item.text}` : item.text}
                    </p>)}
                  </section>)}
                  {run.analysis.options.length > 0 && <section><h4>{t("actionOptions")}</h4>
                    <div className="agent-options">{run.analysis.options.map((option) => <article key={option.id}>
                      <strong>{option.title}</strong><p>{option.description}</p>
                      <span>{t("benefits")}: {option.benefits.join(" · ")}</span>
                      <span>{t("risks")}: {option.risks.join(" · ") || t("unknown")}</span>
                    </article>)}</div></section>}
                  {(run.analysis.actionPlan ?? []).length > 0 && <section><h4>{t("actionPlan")}</h4><ol>
                    {(run.analysis.actionPlan ?? []).map((step) => <li key={step}>{step}</li>)}</ol></section>}</div>}
                  {run.citations.length > 0 && <div className="agent-citations"><strong>{t("citations")}</strong>
                    {run.citations.map((citation) => <button key={citation.id} disabled={!citation.available} onClick={() => {
                      if (citation.kind === "event") void openEvent(citation.targetId);
                      else if (citation.kind === "asset") void previewAsset(citation.targetId);
                      else void openSource(citation.targetId);
                    }}>{citation.label}{citation.available ? "" : ` · ${t("invalidCitation")}`}</button>)}</div>}
                  {run.actions.map((action) => <div className={`agent-action ${action.status}`} key={action.id}>
                    <strong>{action.summary}</strong><em>{action.status}</em>
                    {action.status === "pending" && <div className="row-actions permanent">
                      <button className="primary" onClick={() => void resolveAgentAction(action, true)}>{t("approveAction")}</button>
                      <button onClick={() => void resolveAgentAction(action, false)}>{t("reject")}</button>
                    </div>}
                  </div>)}
                </div>}
              </article>;
            })}</div>
            {lastDraft && <div className="draft-card"><div><strong>{t("draftCreated")}</strong><span>{lastDraft.title}</span></div>
              <button onClick={() => void openEvent(lastDraft.id)}>{t("openEvent")}</button></div>}
            <div className="composer"><textarea aria-label={t("messagePlaceholder")} placeholder={t("messagePlaceholder")}
              value={messageText} onChange={(event) => setMessageText(event.target.value)} />
              <div><div className="composer-modes">
                <button className={composerMode === "agent" ? "active" : ""} onClick={() => setComposerMode("agent")}>{t("agentMode")}</button>
                <button className={composerMode === "quick" ? "active" : ""} onClick={() => setComposerMode("quick")}>{t("quickRecord")}</button>
                <button className={composerMode === "source" ? "active" : ""} onClick={() => setComposerMode("source")}>{t("saveSource")}</button>
              </div><button className="primary" disabled={busy || !messageText.trim()} onClick={() => void sendMessage()}>
                  {composerMode === "agent" ? t("askAgent") : t("send")}</button></div></div>
          </>}
        </section>
      </div>}

      {view === "events" && <div className="events-layout">
        <aside className="event-list-panel panel">
          <div className="section-heading"><div><p className="eyebrow">EVENT MEMORY</p><h2>{t("events")}</h2></div>
            <button onClick={() => void createManualEvent()}>＋</button></div>
          <div className="filters"><input placeholder={t("searchPlaceholder")} value={queryText} onChange={(event) => setQueryText(event.target.value)} />
            <select value={queryStatus} onChange={(event) => setQueryStatus(event.target.value)}><option value="">{t("allStatuses")}</option>
              <option value="candidate">{t("candidate")}</option><option value="confirmed">{t("confirmed")}</option><option value="archived">{t("archived")}</option></select>
            <select value={queryPerson} onChange={(event) => setQueryPerson(event.target.value)}><option value="">{t("allPeople")}</option>
              {people.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select>
            <div className="date-filter"><input type="date" aria-label={t("from")} value={queryFrom} onChange={(event) => setQueryFrom(event.target.value)} />
              <input type="date" aria-label={t("to")} value={queryTo} onChange={(event) => setQueryTo(event.target.value)} /></div>
            <button className="primary" onClick={() => void searchEvents()}>{t("search")}</button></div>
          <div className="event-list">{events.length === 0 ? <div className="empty compact">{t("noEvents")}</div> : events.map((event) =>
            <article key={event.id} className={selectedEventId === event.id ? "selected" : ""} onClick={() => void openEvent(event.id)}>
              <div><strong>{event.title}</strong><span>{new Date(event.updatedAt).toLocaleString(language)}</span></div>
              <em className={`status ${event.status}`}>{t(event.status)}</em></article>)}</div>
        </aside>
        <section className="event-editor panel">
          {!eventDetail ? <div className="empty">{t("newEvent")}</div> : <>
            <div className="editor-heading"><div><p className="eyebrow">{t("currentRevision")} {eventDetail.event.currentRevision}</p><h2>{t("eventDetails")}</h2></div>
              <div><button onClick={() => void changeStatus("confirmed")}>{t("confirm")}</button><button onClick={() => void changeStatus("archived")}>{t("archive")}</button></div></div>
            <div className="editor-form">
              <label className="field"><span>{t("title")}</span><input value={eventForm.title} onChange={(event) => setEventForm({ ...eventForm, title: event.target.value })} /></label>
              <div className="form-row"><label className="field"><span>{t("status")}</span><select value={eventForm.status} onChange={(event) => setEventForm({ ...eventForm, status: event.target.value as Event["status"] })}>
                <option value="candidate">{t("candidate")}</option><option value="confirmed">{t("confirmed")}</option><option value="archived">{t("archived")}</option></select></label>
                <label className="field"><span>{t("occurredAt")}</span><select value={eventForm.temporalKind} onChange={(event) => setEventForm({ ...eventForm, temporalKind: event.target.value as TemporalValue["kind"], temporalValue: "", temporalEnd: "" })}>
                  {(["unknown", "date", "month", "range", "relative", "instant"] as const).map((kind) => <option key={kind} value={kind}>{t(kind)}</option>)}</select></label></div>
              {eventForm.temporalKind !== "unknown" && <div className="form-row"><input
                type={eventForm.temporalKind === "month" ? "month" : eventForm.temporalKind === "relative" ? "text" : eventForm.temporalKind === "instant" ? "datetime-local" : "date"}
                placeholder={eventForm.temporalKind === "relative" ? t("relativeValue") : t("monthValue")}
                value={eventForm.temporalValue} onChange={(event) => setEventForm({ ...eventForm, temporalValue: event.target.value })} />
                {eventForm.temporalKind === "range" && <input type="date" aria-label={t("endValue")} value={eventForm.temporalEnd} onChange={(event) => setEventForm({ ...eventForm, temporalEnd: event.target.value })} />}</div>}
              <label className="field"><span>{t("narrative")}</span><textarea value={eventForm.narrative} onChange={(event) => setEventForm({ ...eventForm, narrative: event.target.value })} /></label>
              <div className="form-row textareas"><label className="field"><span>{t("facts")}</span><textarea value={eventForm.facts} onChange={(event) => setEventForm({ ...eventForm, facts: event.target.value })} /><small>{t("factsHelp")}</small></label>
                <label className="field"><span>{t("interpretations")}</span><textarea value={eventForm.interpretations} onChange={(event) => setEventForm({ ...eventForm, interpretations: event.target.value })} /></label></div>
              <div className="form-row textareas"><label className="field"><span>{t("emotions")}</span><textarea value={eventForm.emotions} onChange={(event) => setEventForm({ ...eventForm, emotions: event.target.value })} /><small>{t("emotionsHelp")}</small></label>
                <label className="field"><span>{t("interests")}</span><textarea value={eventForm.interests} onChange={(event) => setEventForm({ ...eventForm, interests: event.target.value })} /><small>{t("interestsHelp")}</small></label></div>
              <fieldset><legend>{t("people")}</legend><div className="people-picker">{people.map((person) => <label className="check" key={person.id}>
                <input type="checkbox" checked={eventForm.personIds.includes(person.id)} onChange={(event) => setEventForm((current) => ({ ...current,
                  personIds: event.target.checked ? [...current.personIds, person.id] : current.personIds.filter((id) => id !== person.id) }))} />{person.displayName}</label>)}</div>
                <div className="inline-create"><input placeholder={t("personName")} value={personName} onChange={(event) => setPersonName(event.target.value)} /><button onClick={() => void addPerson()}>＋</button></div></fieldset>
              <button className="primary wide" disabled={busy} onClick={() => void saveEvent()}>{t("save")}</button>
            </div>
            <section className="subsection drop-target" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
              event.preventDefault(); void attachFiles(Array.from(event.dataTransfer.files));
            }}><div className="subsection-heading"><h3>{t("attachments")}</h3>
              <button onClick={() => void window.grudgeVault.assets.chooseAndImportForEvent(eventDetail.event.id, eventDetail.event.currentRevision).then(async (result) => {
                if (!result.ok) setError(result.error.message); else if (result.data) { await refreshLists(); await openEvent(result.data.id); }
              })}>{t("attachFiles")}</button></div>
              <input id="event-asset-file-input" hidden multiple type="file" onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length === 0) return;
                void attachFiles(files);
              }} />
              <p className="drop-hint">{t("dropFiles")}</p>
              <div className="mini-list">{eventDetail.assets.map((asset) => <article key={asset.id}><div><strong>{asset.originalFileName}</strong><span>{formatBytes(asset.byteSize)}</span></div>
                <button onClick={() => void previewAsset(asset.id)}>{t("preview")}</button><button onClick={() => void window.grudgeVault.assets.exportCopy(asset.id)}>{t("exportCopy")}</button></article>)}</div></section>
            <section className="subsection"><h3>{t("clarifications")}</h3><div className="mini-list">{eventDetail.clarifications.map((item) => <article key={item.id}>
              <div><strong>{item.question}</strong><span>{item.reason}</span></div><em className={`status ${item.status}`}>{item.status}</em>
              {item.status === "open" && <><button onClick={() => void answerClarification(item.id)}>{t("answer")}</button><button onClick={() => void dismissClarification(item.id)}>{t("dismiss")}</button></>}</article>)}</div></section>
            <section className="subsection"><div className="subsection-heading"><h3>{t("sourceRecord")}</h3></div>
              <div className="chip-list">{eventDetail.event.sourceRefs.map((sourceRef) =>
                <button key={sourceRef} onClick={() => void openSource(sourceRef)}>{t("openSource")} · {sourceRef.slice(0, 8)}</button>)}</div></section>
            <section className="subsection"><div className="subsection-heading"><h3>{t("relatedEvents")}</h3>
              <button onClick={() => void refreshRelations()}>{t("refreshSuggestions")}</button></div>
              <div className="inline-create"><select aria-label={t("relationKind")} value={relationKind}
                onChange={(event) => setRelationKind(event.target.value as EventRelation["kind"])}>
                <option value="similar">{t("similar")}</option><option value="precedes">{t("precedes")}</option>
                <option value="same_topic">{t("sameTopic")}</option><option value="same_case">{t("sameCase")}</option></select>
                <select aria-label={t("mergeTarget")} value={relationTargetId} onChange={(event) => setRelationTargetId(event.target.value)}>
                  <option value="">{t("mergeTarget")}</option>{events.filter(({ id }) => id !== eventDetail.event.id).map((item) =>
                    <option key={item.id} value={item.id}>{item.title}</option>)}</select>
                <button disabled={!relationTargetId} onClick={() => void createRelation()}>{t("createRelation")}</button></div>
              <div className="mini-list">{relations.length === 0 ? <p className="muted">{t("noRelations")}</p> : relations.map((relation) => {
                const otherId = relation.sourceEventId === eventDetail.event.id ? relation.targetEventId : relation.sourceEventId;
                const other = events.find(({ id }) => id === otherId);
                return <article key={relation.id}><div><strong>{other?.title ?? otherId}</strong>
                  <span>{relation.kind} · {relation.algorithmIdentity ? `${relation.algorithmIdentity} v${relation.algorithmVersion} · ` : ""}
                    {relation.basis.map(({ label }) => label).join("；")}</span></div>
                  <em className={`status ${relation.status}`}>{relation.status}</em>
                  <button onClick={() => void openEvent(otherId)}>{t("openEvent")}</button>
                  {relation.status === "suggested" && <><button onClick={() => void decideRelation(relation, "confirm")}>{t("confirm")}</button>
                    <button onClick={() => void decideRelation(relation, "reject")}>{t("reject")}</button></>}
                  {relation.origin === "algorithm" && relation.status === "confirmed" &&
                    <button onClick={() => void decideRelation(relation, "reject")}>{t("reject")}</button>}
                  {relation.origin === "user" && <button onClick={() => void decideRelation(relation, "remove")}>{t("delete")}</button>}</article>;
              })}</div></section>
            <section className="subsection"><h3>{t("revisions")}</h3><div className="revision-list">{revisions.map((revision) => <article key={revision.id}>
              <strong>{t("revision")} {revision.revision}</strong><span>{revision.reason} · {new Date(revision.createdAt).toLocaleString(language)}</span></article>)}</div></section>
          </>}
        </section>
      </div>}

      {view === "search" && <div className="phase-three-grid single">
        <section className="panel phase-three-panel">
          <div className="section-heading"><div><p className="eyebrow">FTS5 + OPTIONAL EMBEDDINGS</p>
            <h2>{t("unifiedSearch")}</h2><p className="muted">{t("unifiedSearchHelp")}</p></div></div>
          <div className="search-toolbar"><input aria-label={t("unifiedSearch")} placeholder={t("searchPlaceholder")}
            value={unifiedQuery} onChange={(event) => setUnifiedQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void runUnifiedSearch(); }} />
            <label className="check"><input type="checkbox" disabled={!embeddingStatus?.available}
              checked={semanticSearch && Boolean(embeddingStatus?.available)}
              onChange={(event) => void toggleSemanticSearch(event.target.checked)} />{t("semanticSearch")}</label>
            {embeddingStatus?.available && <button onClick={() => void window.grudgeVault.search.rebuildEmbeddings().then(async (result) => {
              if (!result.ok) setError(result.error.message); else await refreshLists();
            })}>{t("refresh")}</button>}
            <button className="primary" onClick={() => void runUnifiedSearch()}>{t("search")}</button></div>
          <p className="capability-note">{t("embeddingStatus")}: {embeddingStatus?.state ?? t("unavailable")}
            {embeddingStatus?.adapterIdentity ? ` · ${embeddingStatus.adapterIdentity} v${embeddingStatus.adapterVersion}` : ""}</p>
          <h3>{t("searchResults")}</h3>
          <div className="memory-results">{unifiedHits.length === 0 ? <div className="empty compact">{t("noSearchResults")}</div> : unifiedHits.map((hit) =>
            <article key={`${hit.kind}:${hit.id}`}><div><em className="kind-badge">{hit.kind === "event" ? t("events") : hit.kind === "journal_entry" ? t("journalEntry") : t("transcript")}</em>
              <strong>{hit.title}</strong><p>{hit.excerpt}</p><span>{hit.occurredAt ?? t("unknown")}</span></div>
              <div className="row-actions permanent">{hit.eventId && <button onClick={() => void openEvent(hit.eventId!)}>{t("openEvent")}</button>}
                {(hit.derivedArtifactId ?? hit.sourceItemId ?? hit.sourceRefs[0]) && <button onClick={() => void openSource(
                  (hit.derivedArtifactId ?? hit.sourceItemId ?? hit.sourceRefs[0])!
                )}>{t("openSource")}</button>}</div>
            </article>)}</div>
        </section>
      </div>}

      {view === "timeline" && <div className="phase-three-grid single">
        <section className="panel phase-three-panel"><div className="section-heading"><div><p className="eyebrow">CURRENT EVENT PROJECTIONS</p>
          <h2>{t("timeline")}</h2><p className="muted">{t("timelineHelp")}</p></div></div>
          <div className="search-toolbar"><select aria-label={t("people")} value={timelinePerson} onChange={(event) => setTimelinePerson(event.target.value)}>
            <option value="">{t("allPeople")}</option>{people.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select>
            <input type="date" aria-label={t("from")} value={timelineFrom} onChange={(event) => setTimelineFrom(event.target.value)} />
            <input type="date" aria-label={t("to")} value={timelineTo} onChange={(event) => setTimelineTo(event.target.value)} />
            <button className="primary" onClick={() => void loadTimeline()}>{t("refresh")}</button></div>
          <div className="timeline-groups">{timeline?.groups.map((group) => <section key={group.key}><h3>{group.label}</h3>
            {group.events.map((item) => <article key={item.id} onClick={() => void openEvent(item.id)}><span className="timeline-dot" />
              <div><strong>{item.title}</strong><p>{item.narrative}</p><em className={`status ${item.status}`}>{t(item.status)}</em></div></article>)}</section>)}</div>
        </section>
      </div>}

      {view === "people" && <div className="phase-three-grid people-memory">
        <aside className="panel people-index"><div className="section-heading"><div><p className="eyebrow">CANONICAL IDENTITIES</p><h2>{t("people")}</h2></div></div>
          <div className="event-list">{personIdentities.map((identity) => <article key={identity.canonicalPerson.id}
            className={selectedPerson?.canonicalPerson.id === identity.canonicalPerson.id ? "selected" : ""}
            onClick={() => void openPerson(identity.canonicalPerson.id)}><div><strong>{identity.canonicalPerson.displayName}</strong>
              <span>{identity.identities.length > 1 ? `${identity.identities.length} ${t("identityMembers")}` : identity.canonicalPerson.notes}</span></div></article>)}</div>
          <div className="subsection"><div className="subsection-heading"><h3>{t("mergeSuggestions")}</h3>
            <button onClick={() => void loadMergeSuggestions()}>{t("refresh")}</button></div>
            {mergeSuggestions.filter(({ status }) => status === "pending").length === 0 ? <p className="muted">{t("noMergeSuggestions")}</p> :
              mergeSuggestions.filter(({ status }) => status === "pending").map((suggestion) => <article className="suggestion-card" key={suggestion.id}>
                <strong>{people.find(({ id }) => id === suggestion.personAId)?.displayName} ↔ {people.find(({ id }) => id === suggestion.personBId)?.displayName}</strong>
                <span>{Math.round(suggestion.score * 100)}% · {suggestion.basis.join("；")}</span><div className="row-actions permanent">
                  <button className="primary" onClick={() => void mergePeople(suggestion)}>{t("mergePeople")}</button>
                  <button onClick={() => void rejectPersonMerge(suggestion.id)}>{t("reject")}</button></div></article>)}</div>
        </aside>
        <section className="panel phase-three-panel">{!selectedPerson ? <div className="empty">{t("personIdentity")}</div> : <>
          <div className="section-heading"><div><p className="eyebrow">{t("canonical")}</p><h2>{selectedPerson.canonicalPerson.displayName}</h2></div></div>
          <section className="subsection"><h3>{t("identityMembers")}</h3><div className="chip-list">{selectedPerson.identities.map((person) =>
            <span key={person.id}>{person.displayName}</span>)}</div></section>
          <section className="subsection"><h3>{t("aliases")}</h3><div className="chip-list">{selectedPerson.aliases.map((alias) =>
            <span className={alias.status === "inactive" ? "inactive" : ""} key={alias.id}>{alias.value}
              {alias.status === "active" && <button aria-label={t("delete")} onClick={() => void window.grudgeVault.people.deactivateAlias(alias.id).then(async (result) => {
                if (!result.ok) setError(result.error.message); else await openPerson(selectedPerson.canonicalPerson.id);
              })}>×</button>}</span>)}</div>
            <div className="inline-create"><input placeholder={t("aliasPlaceholder")} value={aliasValue} onChange={(event) => setAliasValue(event.target.value)} />
              <button onClick={() => void addAlias()}>{t("addAlias")}</button></div></section>
          <section className="subsection"><h3>{t("revertMerge")}</h3><div className="mini-list">{selectedPerson.activeMerges.map((merge) =>
            <article key={merge.id}><div><strong>{people.find(({ id }) => id === merge.sourcePersonId)?.displayName} → {people.find(({ id }) => id === merge.targetPersonId)?.displayName}</strong>
              <span>{new Date(merge.createdAt).toLocaleString(language)}</span></div><button onClick={() => void revertPersonMerge(merge.id)}>{t("revertMerge")}</button></article>)}</div></section>
          <section className="subsection"><h3>{t("timeline")}</h3><div className="memory-results">{selectedPerson.events.map((item) =>
            <article key={item.id} onClick={() => void openEvent(item.id)}><div><strong>{item.title}</strong><p>{item.narrative}</p></div></article>)}</div></section>
        </>}</section>
      </div>}

      {view === "review" && <div className="phase-three-grid review-memory">
        <aside className="panel review-controls"><div className="section-heading"><div><p className="eyebrow">TRACEABLE ANALYSIS</p><h2>{t("review")}</h2></div></div>
          <div className="backfill-form"><label className="field"><span>{t("from")}</span><input type="date" value={reviewFrom} onChange={(event) => setReviewFrom(event.target.value)} /></label>
            <label className="field"><span>{t("to")}</span><input type="date" value={reviewTo} onChange={(event) => setReviewTo(event.target.value)} /></label>
            <div className="row-actions permanent"><button onClick={() => setReviewPreset("month")}>{t("monthly")}</button>
              <button onClick={() => setReviewPreset("quarter")}>{t("quarterly")}</button></div>
            <button className="primary" onClick={() => void generateReview()}>{t("generateReview")}</button></div>
          <h3>{t("reviewHistory")}</h3>{reviews.length === 0 ? <p className="muted">{t("noReviews")}</p> : <div className="run-list">{reviews.map((review) =>
            <article key={review.id} className={selectedReview?.id === review.id ? "selected" : ""} onClick={() => setSelectedReview(review)}>
              <div><strong>{review.from} — {review.to}</strong><span>{new Date(review.createdAt).toLocaleString(language)}</span></div>
              {review.stale && <em className="status failed">stale</em>}</article>)}</div>}
          {reviewAutomation && <section className="subsection"><h3>{language === "zh-CN" ? "持续回顾" : "Continuous review"}</h3>
            <div className="people-picker"><label className="check"><input type="checkbox" checked={reviewAutomation.monthly}
              onChange={(event) => void updateAutomation({ monthly: event.target.checked })} />{language === "zh-CN" ? "月度回顾" : "Monthly reviews"}</label>
              <label className="check"><input type="checkbox" checked={reviewAutomation.quarterly}
                onChange={(event) => void updateAutomation({ quarterly: event.target.checked })} />{language === "zh-CN" ? "季度回顾" : "Quarterly reviews"}</label>
              <label className="check"><input type="checkbox" checked={reviewAutomation.clarificationWeekly}
                onChange={(event) => void updateAutomation({ clarificationWeekly: event.target.checked })} />{language === "zh-CN" ? "每周高价值待补全提醒" : "Weekly high-value clarification digest"}</label>
              <label className="check"><input type="checkbox" checked={reviewAutomation.systemNotifications}
                onChange={(event) => void updateAutomation({ systemNotifications: event.target.checked })} />{language === "zh-CN" ? "系统通知（仅通用文案）" : "System notifications (generic text only)"}</label></div></section>}
          <section className="subsection"><h3>{language === "zh-CN" ? "应用内提醒" : "In-app reminders"}</h3>
            {reminders.filter(({ status }) => status !== "dismissed").length === 0 ? <p className="muted">{language === "zh-CN" ? "暂无到期提醒。" : "No due reminders."}</p> :
              <div className="mini-list">{reminders.filter(({ status }) => status !== "dismissed").map((reminder) => <article key={reminder.id}>
                <div><strong>{reminder.kind}</strong><span>{new Date(reminder.dueAt).toLocaleString(language)} · {reminder.status}</span></div>
                <button onClick={() => void openReminder(reminder)}>{language === "zh-CN" ? "打开" : "Open"}</button>
                <button onClick={() => void window.grudgeVault.reminders.dismiss(reminder.id).then(async (result) => {
                  if (!result.ok) setError(result.error.message); else await refreshLists();
                })}>{t("dismiss")}</button></article>)}</div>}</section>
          <section className="subsection"><h3>{t("globalClarifications")}</h3><div className="mini-list">{globalClarifications.filter(({ status }) => status === "open").map((item) =>
            <article key={item.id}><div><strong>{item.question}</strong><span>{item.reason}</span></div>
              <select aria-label={t("priority")} value={item.priority} onChange={(event) => void changeClarificationPriority(item.id, event.target.value as typeof item.priority)}>
                <option value="normal">{t("normal")}</option><option value="important">{t("important")}</option><option value="rights_related">{t("rightsRelated")}</option></select>
              <button onClick={() => void answerGlobalClarification(item)}>{t("answer")}</button>
              <button onClick={() => void dismissGlobalClarification(item)}>{t("dismiss")}</button>
              <button onClick={() => void openEvent(item.eventId)}>{t("openEvent")}</button></article>)}</div></section>
        </aside>
        <section className="panel phase-three-panel">{!selectedReview ? <div className="empty">{t("noReviews")}</div> : <>
          <div className="section-heading"><div><p className="eyebrow">{selectedReview.generatorIdentity} v{selectedReview.generatorVersion}</p>
            <h2>{selectedReview.from} — {selectedReview.to}</h2></div></div>
          {selectedReview.stale && <div className="notice-banner">{t("staleReview")}</div>}
          <h3>{t("patterns")}</h3><div className="pattern-list">{selectedReview.patterns.length === 0 ? <div className="empty compact">{t("noPatterns")}</div> :
            selectedReview.patterns.map((pattern) => <article key={pattern.id}><em className="kind-badge">{pattern.kind}</em><h3>{pattern.title}</h3><p>{pattern.summary}</p>
              <strong>{t("supportingEvents")}</strong><div className="chip-list">{pattern.eventIds.map((eventId) =>
                <button key={eventId} onClick={() => void openEvent(eventId)}>{events.find(({ id }) => id === eventId)?.title ?? eventId}</button>)}</div>
              <div className="chip-list">{pattern.sourceRefs.map((sourceRef) => <button key={sourceRef} onClick={() => void openSource(sourceRef)}>{t("openSource")} · {sourceRef.slice(0, 8)}</button>)}</div>
            </article>)}</div>
        </>}</section>
      </div>}

      {view === "backfill" && <div className="backfill-layout">
        <section className="panel import-panel">
          <div className="section-heading"><div><p className="eyebrow">DAY ONE SOURCE MEMORY</p><h2>{t("dayOneImports")}</h2></div>
            <button className="primary" disabled={busy} onClick={() => void chooseDayOneZip()}>{t("chooseDayOneZip")}</button></div>
          {importFolderStatus && <section className="subsection"><div className="subsection-heading"><div><p className="eyebrow">INCREMENTAL IMPORT FOLDER</p>
            <h3>{language === "zh-CN" ? "Day One 增量目录" : "Incremental Day One folder"}</h3></div></div>
            <p className="path-value">{importFolderStatus.displayPath ?? (language === "zh-CN" ? "尚未选择目录" : "No folder selected")}</p>
            <p className="muted">{language === "zh-CN" ? "仅处理顶层常规 ZIP；原始路径只保存在本机配置中。" : "Only top-level regular ZIP files are processed; the original path stays in machine-local settings."}</p>
            <div className="row-actions permanent"><button onClick={() => void chooseImportFolder()}>{language === "zh-CN" ? "选择目录" : "Choose folder"}</button>
              <label className="check"><input type="checkbox" disabled={!importFolderStatus.configured} checked={importFolderStatus.enabled}
                onChange={(event) => void updateImportFolder(event.target.checked)} />{language === "zh-CN" ? "启用监听" : "Watch folder"}</label>
              <button disabled={!importFolderStatus.configured} onClick={() => void scanImportFolder()}>{language === "zh-CN" ? "立即扫描" : "Scan now"}</button></div>
            <p className="muted">{importFolderStatus.watching ? (language === "zh-CN" ? "监听中" : "Watching") : (language === "zh-CN" ? "未监听" : "Not watching")}
              {` · ${importFolderStatus.importedCount} imported · ${importFolderStatus.failedCount} failed`}</p>
            {importFolderStatus.lastError && <p className="error-banner">{importFolderStatus.lastError}</p>}</section>}
          {importRuns.length === 0 ? <div className="empty compact">{t("noImports")}</div> : <div className="run-list">{importRuns.map((run) =>
            <article key={run.id} className={selectedImportId === run.id ? "selected" : ""} onClick={() => setSelectedImportId(run.id)}>
              <div><strong>{run.archiveFileName}</strong><span>{new Date(run.createdAt).toLocaleString(language)}</span></div>
              <em className={`status ${run.state}`}>{run.state}</em>
              <progress max={1} value={run.progress} />
              <span>{t("entries")}: {run.counts.totalEntries} · +{run.counts.newEntries} · ↻{run.counts.updatedEntries} · ={run.counts.skippedEntries}</span>
              <span>{t("media")}: {run.counts.mediaImported} · {t("issues")}: {run.counts.errorCount + run.counts.mediaMissing}</span>
            </article>)}</div>}
          {importDetail && <div className="issue-list"><h3>{t("importReport")}</h3>
            {importDetail.issues.length === 0 ? <p className="muted">{t("noIssues")}</p> : importDetail.issues.map((issue) =>
              <article key={issue.id}><em className={`status ${issue.severity === "error" ? "failed" : "archived"}`}>{issue.code}</em>
                <div><strong>{issue.message}</strong><span>{issue.entryExternalId ?? issue.archivePath ?? ""}</span></div></article>)}</div>}
        </section>

        <section className="panel backfill-controls">
          <div className="section-heading"><div><p className="eyebrow">RECOVERABLE BACKFILL</p><h2>{t("backfillRuns")}</h2></div></div>
          <div className="backfill-form"><div className="date-filter"><label className="field"><span>{t("from")}</span><input type="date" value={backfillFrom} onChange={(event) => setBackfillFrom(event.target.value)} /></label>
            <label className="field"><span>{t("to")}</span><input type="date" value={backfillTo} onChange={(event) => setBackfillTo(event.target.value)} /></label></div>
            <label className="field"><span>{t("tagFilter")}</span><input value={backfillTags} placeholder={t("tagFilterHelp")} onChange={(event) => setBackfillTags(event.target.value)} /></label>
            <label className="field"><span>{t("batchSize")}</span><input type="number" min={1} max={100} value={backfillBatchSize} onChange={(event) => setBackfillBatchSize(event.target.value)} /></label>
            <button className="primary" disabled={importRuns.length === 0} onClick={() => void startBackfill()}>{t("startBackfill")}</button></div>
          <div className="run-list">{backfillRuns.map((run) => <article key={run.id}>
            <div><strong>{run.detectorIdentity} v{run.detectorVersion}</strong><span>{run.processedItems}/{run.totalItems} · {run.candidateCount} {t("candidates")}</span></div>
            <em className={`status ${run.state}`}>{run.state}</em><progress max={Math.max(1, run.totalItems)} value={run.processedItems} />
            <div className="row-actions permanent">{(run.state === "queued" || run.state === "running") && <button onClick={() => void changeBackfill(run, "pause")}>{t("pause")}</button>}
              {(run.state === "paused" || run.state === "failed") && <button onClick={() => void changeBackfill(run, "resume")}>{t("resume")}</button>}
              {!["completed", "cancelled"].includes(run.state) && <button onClick={() => void changeBackfill(run, "cancel")}>{t("cancel")}</button>}</div>
          </article>)}</div>
        </section>

        <section className="panel candidate-inbox">
          <div className="section-heading"><div><p className="eyebrow">CANDIDATE INBOX</p><h2>{t("candidateInbox")}</h2></div><span className="count-badge">{candidates.length}</span></div>
          {candidates.length === 0 ? <div className="empty compact">{t("noCandidates")}</div> : <div className="candidate-list">{candidates.map((candidate) =>
            <article key={candidate.event.id} className={candidateDetail?.event.id === candidate.event.id ? "selected" : ""} onClick={() => void inspectCandidate(candidate.event.id)}>
              <div><strong>{candidate.event.title}</strong><span>{candidate.journalEntry.journalDate} · {candidate.journalEntry.tags.join(", ")}</span>
                <p>{candidate.excerpt}</p></div><em className="status candidate">v{candidate.extraction.detectorVersion}</em></article>)}</div>}
        </section>

        <section className="panel candidate-source">
          {!candidateDetail ? <div className="empty">{t("selectCandidate")}</div> : <>
            <div className="section-heading"><div><p className="eyebrow">{candidateDetail.extraction.detectorIdentity} v{candidateDetail.extraction.detectorVersion}</p><h2>{candidateDetail.event.title}</h2></div>
              <button onClick={() => void openEvent(candidateDetail.event.id)}>{t("openEvent")}</button></div>
            <div className="source-card"><div className="source-meta"><span>{formatJournalTimestamp(
              candidateDetail.journalEntry.creationDate, language, candidateDetail.journalEntry.timeZone
            )}</span>
              <span>{candidateDetail.journalEntry.timeZone ?? t("unknown")}</span><span>{candidateDetail.journalEntry.tags.join(", ")}</span></div>
              <h3>{t("sourceExcerpt")}</h3><pre>{candidateDetail.excerpt}</pre>
              <p className="muted">{t("candidateTimeSource")}: {candidateDetail.extraction.temporalBasis === "source-text"
                ? t("timeFromSource") : candidateDetail.extraction.temporalBasis === "relative" ? t("timeFromRelative") : t("timeFromJournal")}</p>
              <p className="muted">{t("sourceVersion")} {candidateDetail.sourceVersion.version} · {candidateDetail.sourceVersion.contentHash}</p>
              <div className="candidate-actions"><button className="primary" onClick={() => void reviewCandidate("confirm")}>{t("confirm")}</button>
                <button onClick={() => void reviewCandidate("ignore")}>{t("ignoreCandidate")}</button>
                <select aria-label={t("mergeTarget")} value={mergeTargetId} onChange={(event) => setMergeTargetId(event.target.value)}>
                  <option value="">{t("mergeTarget")}</option>{events.filter(({ id, status }) => id !== candidateDetail.event.id && status !== "archived").map((event) =>
                    <option key={event.id} value={event.id}>{event.title}</option>)}</select>
                <button disabled={!mergeTargetId} onClick={() => void mergeCandidate()}>{t("mergeCandidate")}</button></div>
            </div></>}
        </section>
      </div>}

      {view === "evidence" && <EvidencePanel language={language} onError={setError} onNotice={setNotice} />}

      {view === "cases" && <CasesPanel language={language} events={events} people={people} evidence={assets}
        onError={setError} onNotice={setNotice} />}

      {view === "vault" && <div className="vault-grid">
        <section className="panel drop-target" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
          event.preventDefault(); void importVaultFiles(Array.from(event.dataTransfer.files));
        }}><div className="section-heading"><div><p className="eyebrow">OBJECT VAULT</p><h2>{t("originals")}</h2></div>
          <button className="primary" onClick={() => void window.grudgeVault.assets.chooseAndImport().then(refreshLists)}>{t("chooseFiles")}</button></div>
          <input id="asset-file-input" hidden multiple type="file" onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length > 0) void importVaultFiles(files);
          }} />
          {assets.length === 0 ? <div className="empty">{t("noAssets")}</div> : <div className="asset-list">{assets.map((asset) => <article className="asset-row" key={asset.id}>
            <div><strong>{asset.originalFileName}</strong><span>{formatBytes(asset.byteSize)} · {asset.mimeType}</span></div><code>{asset.sha256}</code>
            <em className={`status ${asset.integrityStatus}`}>{asset.integrityStatus}</em>
            <div className="row-actions"><button onClick={() => void previewAsset(asset.id)}>{t("preview")}</button><button onClick={() => void window.grudgeVault.assets.exportCopy(asset.id)}>{t("exportCopy")}</button>
              <button onClick={() => void window.grudgeVault.assets.verify(asset.id)}>{t("verify")}</button>
              <button onClick={() => void window.grudgeVault.localIntelligence.processAsset(asset.id).then(async (result) => {
                if (!result.ok) setError(result.error.message); else await refreshLists();
              })}>{language === "zh-CN" ? "本地处理" : "Process locally"}</button></div></article>)}</div>}
        </section>
        <aside className="panel"><div className="section-heading"><div><p className="eyebrow">JOBS</p><h2>{t("tasks")}</h2></div></div>
          {jobs.length === 0 ? <div className="empty compact">{t("noJobs")}</div> : jobs.map((job) => <article className="job-row" key={job.id}>
            <div><strong>{job.type}</strong><span>{t("attempt")} {job.attempts}/{job.maxAttempts}</span></div><em className={`status ${job.state}`}>{job.state}</em>
            <progress max={1} value={job.progress ?? 0} />{job.lastError && <p>{job.lastError}</p>}
            {job.state === "failed" && <button onClick={() => void window.grudgeVault.jobs.retry(job.id)}>{t("retry")}</button>}
            {(job.state === "queued" || job.state === "running") && <button onClick={() => void window.grudgeVault.jobs.cancel(job.id).then(async (result) => {
              if (!result.ok) setError(result.error.message); else await refreshLists();
            })}>{t("cancel")}</button>}</article>)}</aside>
      </div>}

      {view === "settings" && <div className="settings-grid">
        <WorkspaceSecurityPanel language={language} onError={setError} onNotice={setNotice}
          onLocked={clearSensitiveRendererState} />
        <section className="panel settings-card"><p className="eyebrow">LANGUAGE</p><h2>{t("language")}</h2>
          <div className="language-pills"><button className={language === "zh-CN" ? "active" : ""} onClick={() => setAppLanguage("zh-CN")}>{t("chinese")}</button>
            <button className={language === "en" ? "active" : ""} onClick={() => setAppLanguage("en")}>{t("english")}</button></div></section>
        {processorStatus && <section className="panel settings-card"><p className="eyebrow">LOCAL MEDIA INTELLIGENCE</p>
          <h2>{language === "zh-CN" ? "本地媒体引擎" : "Local media engines"}</h2>
          <p>{language === "zh-CN" ? "仅运行用户选择的本地程序和模型；不会下载或联网。" : "Only user-selected local programs and models run; nothing is downloaded or sent online."}</p>
          <div className="settings-list"><article><div><strong>OCR · {processorStatus.ocr.available ? "ready" : "unavailable"}</strong>
            <span>{processorStatus.ocr.displayNames.join(" · ") || (language === "zh-CN" ? "未配置" : "Not configured")}</span></div>
            <button onClick={() => void chooseProcessorPath("tesseract")}>Tesseract</button><button onClick={() => void chooseProcessorPath("poppler")}>Poppler</button></article>
            <article><div><strong>ASR · {processorStatus.asr.available ? "ready" : "unavailable"}</strong>
              <span>{processorStatus.asr.displayNames.join(" · ") || (language === "zh-CN" ? "未配置" : "Not configured")}</span></div>
              <button onClick={() => void chooseProcessorPath("ffmpeg")}>FFmpeg</button><button onClick={() => void chooseProcessorPath("whisper")}>whisper.cpp</button>
              <button onClick={() => void chooseProcessorPath("whisper_model")}>{language === "zh-CN" ? "模型" : "Model"}</button></article></div>
          <label className="field"><span>{language === "zh-CN" ? "OCR 语言（+ 分隔）" : "OCR languages (+ separated)"}</span>
            <input key={processorStatus.settings.ocrLanguages.join("+")} defaultValue={processorStatus.settings.ocrLanguages.join("+")}
              onBlur={(event) => void updateMediaSettings({ ocrLanguages: event.target.value.split("+").map((item) => item.trim()).filter(Boolean) })} /></label>
          <label className="field"><span>{language === "zh-CN" ? "资源档位" : "Resource profile"}</span><select value={processorStatus.settings.resourceProfile}
            onChange={(event) => void updateMediaSettings({ resourceProfile: event.target.value as MediaProcessingSettings["resourceProfile"] })}>
            <option value="conservative">conservative</option><option value="balanced">balanced</option><option value="performance">performance</option></select></label>
          <div className="people-picker"><label className="check"><input type="checkbox" checked={processorStatus.settings.autoProcessNew}
            onChange={(event) => void updateMediaSettings({ autoProcessNew: event.target.checked })} />{language === "zh-CN" ? "自动处理新附件" : "Automatically process new attachments"}</label>
            <label className="check"><input type="checkbox" checked={processorStatus.settings.whisperGpu === "auto"}
              onChange={(event) => void updateMediaSettings({ whisperGpu: event.target.checked ? "auto" : "cpu" })} />{language === "zh-CN" ? "Whisper 自动使用 GPU" : "Whisper GPU auto"}</label></div>
          {[...processorStatus.ocr.warnings, ...processorStatus.asr.warnings].map((warning) => <p className="warning-copy" key={warning}>{warning}</p>)}
          <div className="landing-actions"><button onClick={() => void probeProcessors()}>{language === "zh-CN" ? "重新探测" : "Probe again"}</button>
            <button disabled={processorStatus.eligibleHistoricalAssets === 0} onClick={() => void processHistoricalMedia()}>{language === "zh-CN"
              ? `处理历史附件（${processorStatus.eligibleHistoricalAssets}）` : `Process historical (${processorStatus.eligibleHistoricalAssets})`}</button></div>
          <p className="muted">{language === "zh-CN" ? "OCR/转写搜索正文会存储在未加密 SQLite 元数据中。" : "OCR/transcript search text is stored in unencrypted SQLite metadata."}</p>
        </section>}
        <section className="panel settings-card agent-settings-card"><p className="eyebrow">HARNESS AGENT</p><h2>{t("agentSettings")}</h2>
          <p>{t("agentSettingsHelp")}</p>
          <label className="field"><span>{t("agentExecutionMode")}</span><select value={agentMode}
            onChange={(event) => setAgentMode(event.target.value as AgentModelSettings["mode"])}>
            <option value="private">Private</option><option value="enhanced">Enhanced</option></select></label>
          {agentMode === "private" ? <>
            <label className="field"><span>{t("modelBaseUrl")}</span><input aria-label={t("modelBaseUrl")} value={agentPrivateBaseUrl}
              placeholder="http://127.0.0.1:11434/v1" onChange={(event) => setAgentPrivateBaseUrl(event.target.value)} /></label>
            <label className="field"><span>{t("modelName")}</span><input aria-label={t("modelName")} value={agentPrivateModel}
              placeholder="local-model" onChange={(event) => setAgentPrivateModel(event.target.value)} /></label>
          </> : <>
            <label className="field"><span>{t("modelBaseUrl")}</span><input aria-label={t("modelBaseUrl")} value={agentEnhancedBaseUrl}
              onChange={(event) => setAgentEnhancedBaseUrl(event.target.value)} /></label>
            <label className="field"><span>{t("modelName")}</span><input aria-label={t("modelName")} value={agentEnhancedModel}
              onChange={(event) => setAgentEnhancedModel(event.target.value)} /></label>
          </>}
          <label className="field"><span>{t("apiKey")}</span><input aria-label={t("apiKey")} type="password" value={agentApiKey}
            placeholder={agentMode === "private" ? t("optional") : "••••••••"} onChange={(event) => setAgentApiKey(event.target.value)} /></label>
          <p className="muted">{t("credentialStatus")}: {(agentMode === "private" ? agentSettings?.privateEndpoint : agentSettings?.enhancedEndpoint)?.credentialConfigured
            ? t("configured") : t("notConfigured")}</p>
          <p className="muted">{t("consentedCategories")}: {agentSettings?.consentedDataCategories.join(", ") || t("none")}</p>
          <div className="landing-actions"><button className="primary" disabled={busy} onClick={() => void saveAgentSettings()}>{t("saveAgentSettings")}</button>
            <button onClick={() => void clearAgentCredential()}>{t("clearCredential")}</button></div>
        </section>
        <section className="panel settings-card"><p className="eyebrow">ENCRYPTED SNAPSHOT</p><h2>{t("backup")}</h2><p>{t("backupHelp")}</p>
          <div className="landing-actions"><button className="primary" onClick={() => void window.grudgeVault.backups.createSnapshot().then((result) => {
            if (!result.ok) setError(result.error.message); else if (result.data) setNotice(`${t("backupCreated")}: ${result.data.path}`);
          })}>{t("createBackup")}</button><button onClick={() => { if (window.confirm(t("restoreWarning"))) void window.grudgeVault.backups.restoreSnapshot().then(async (result) => {
            if (!result.ok) setError(result.error.message); else if (result.data) await refresh();
          }); }}>{t("restoreBackup")}</button></div></section>
        <section className="panel settings-card"><p className="eyebrow">WORKSPACE</p><h2>{t("activeWorkspace")}</h2><p className="path-value">{workspace.rootPath}</p></section>
        <section className="panel settings-card"><p className="eyebrow">PEOPLE</p><h2>{t("people")}</h2>
          <div className="settings-list">{people.map((person) => <article key={person.id}><div><strong>{person.displayName}</strong><span>{person.notes}</span></div>
            <button onClick={() => void editPerson(person)}>{t("edit")}</button>
            <button onClick={() => void window.grudgeVault.people.archive(person.id).then(async (result) => {
              if (!result.ok) setError(result.error.message); else await refreshLists();
            })}>{t("archivePerson")}</button></article>)}</div></section>
      </div>}
    </section>

    {pendingAgentRun?.disclosure && <div className="modal-backdrop"><section className="preview-modal consent-modal">
      <div className="section-heading"><div><p className="eyebrow">ENHANCED CONTEXT</p><h2>{t("externalContextConsent")}</h2></div></div>
      <p>{t("externalContextHelp")}</p>
      <div className="disclosure-list">{pendingAgentRun.disclosure.categories.map((category) => <article key={category}>
        <strong>{category}</strong><span>{pendingAgentRun.disclosure?.categoryCounts[category] ?? 0}</span>
      </article>)}</div>
      <p className="muted">{t("redactionPolicy")} v{pendingAgentRun.disclosure.policyVersion} · {pendingAgentRun.disclosure.contextHash}</p>
      <div className="landing-actions"><button className="primary" disabled={busy} onClick={() => void resumeAgentRun()}>{t("allowAndContinue")}</button>
        <button disabled={busy} onClick={() => void cancelAgentRun()}>{t("cancel")}</button></div>
    </section></div>}
    {preview && <div className="modal-backdrop" onClick={() => setPreview(undefined)}><section className="preview-modal" onClick={(event) => event.stopPropagation()}>
      <div className="section-heading"><h2>{preview.fileName}</h2><button onClick={() => setPreview(undefined)}>×</button></div>
      <div className="preview-content">{preview.text !== undefined ? <pre>{preview.text}</pre> : preview.mimeType.startsWith("image/") ? <img src={preview.url} alt={preview.fileName} />
        : preview.mimeType.startsWith("audio/") ? <audio controls src={preview.url} /> : preview.mimeType.startsWith("video/") ? <video controls src={preview.url} />
          : <iframe title={preview.fileName} src={preview.url} />}</div></section></div>}
    {sourceDetail && <div className="modal-backdrop" onClick={() => setSourceDetail(undefined)}><section className="preview-modal source-modal" onClick={(event) => event.stopPropagation()}>
      <div className="section-heading"><div><p className="eyebrow">{sourceDetail.kind}</p><h2>{sourceDetail.title}</h2></div>
        <button onClick={() => setSourceDetail(undefined)}>×</button></div>
      <div className="source-meta"><span>{new Date(sourceDetail.recordedAt).toLocaleString(language)}</span>
        {sourceDetail.sourceVersion && <span>{t("sourceVersion")} {sourceDetail.sourceVersion}</span>}
        {sourceDetail.contentHash && <code>{sourceDetail.contentHash}</code>}</div>
      <pre className="source-body">{sourceDetail.excerpt || t("sourceDeleted")}</pre>
      <div className="chip-list">{sourceDetail.eventIds.map((eventId) =>
        <button key={eventId} onClick={() => { setSourceDetail(undefined); void openEvent(eventId); }}>{t("openEvent")}</button>)}</div>
      {sourceDetail.conversationId && <div className="chip-list"><button onClick={() => {
        setSelectedConversationId(sourceDetail.conversationId); setSourceDetail(undefined); setView("chat");
      }}>{t("openConversation")}</button></div>}
    </section></div>}
  </main>;
}
