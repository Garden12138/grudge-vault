import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Asset, Conversation, Event, EventDetail, EventRevision, Job, Message, Person,
  StatementKind, TemporalValue, Workspace
} from "@grudge-vault/domain";
import type { EventWriteFields, IpcResult } from "@grudge-vault/shared";
import { detectLanguage, translator, type Language } from "./i18n";

type View = "chat" | "events" | "vault" | "settings";

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
  const [createDraft, setCreateDraft] = useState(true);
  const [lastDraft, setLastDraft] = useState<Event>();

  const [events, setEvents] = useState<Event[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
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
    const [conversationResult, eventResult, peopleResult, assetResult, jobResult] = await Promise.all([
      window.grudgeVault.conversations.list(), window.grudgeVault.events.search({}),
      window.grudgeVault.people.list(), window.grudgeVault.assets.list(), window.grudgeVault.jobs.list()
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
  }, []);

  const refresh = useCallback(async () => {
    const current = await window.grudgeVault.workspace.current();
    if (!current.ok) return setError(current.error.message);
    setWorkspace(current.data);
    if (!current.data) return;
    await refreshLists();
  }, [refreshLists]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  useEffect(() => window.grudgeVault.jobs.onChanged(() => void refreshLists()), [refreshLists]);
  useEffect(() => {
    if (!selectedConversationId) return setMessages([]);
    void window.grudgeVault.conversations.listMessages(selectedConversationId).then((result) => {
      if (result.ok) setMessages(result.data); else setError(result.error.message);
    });
  }, [selectedConversationId]);
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview]);

  const runWorkspaceAction = async (action: () => Promise<IpcResult<Workspace | null>>) => {
    setBusy(true); setError(undefined);
    const result = await action();
    setBusy(false);
    if (!result.ok) return setError(result.error.message);
    if (result.data) await refresh();
  };

  const openEvent = async (id: string, preserveForm = false) => {
    setSelectedEventId(id); setBusy(true);
    const [detailResult, revisionResult] = await Promise.all([
      window.grudgeVault.events.get(id), window.grudgeVault.events.listRevisions(id)
    ]);
    setBusy(false);
    if (!detailResult.ok) return setError(detailResult.error.message);
    setEventDetail(detailResult.data);
    if (!preserveForm) setEventForm(eventToForm(detailResult.data.event));
    if (revisionResult.ok) setRevisions(revisionResult.data);
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

  const sendMessage = async () => {
    if (!selectedConversationId || !messageText.trim()) return;
    setBusy(true); setError(undefined); setLastDraft(undefined);
    const result = await window.grudgeVault.conversations.send({
      conversationId: selectedConversationId, content: messageText, createDraft
    });
    setBusy(false);
    if (!result.ok) return setError(result.error.message);
    setMessageText("");
    setMessages((current) => [...current, result.data.message]);
    if (result.data.draft) setLastDraft(result.data.draft);
    if (result.data.draftError) setNotice(t("draftFailed"));
    await refreshLists();
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

  const editPerson = async (person: Person) => {
    const displayName = window.prompt(t("personName"), person.displayName);
    if (!displayName?.trim()) return;
    const notes = window.prompt(t("personNotes"), person.notes ?? "") ?? person.notes;
    const result = await window.grudgeVault.people.update({
      id: person.id, displayName, ...(notes === undefined ? {} : { notes })
    });
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
        {(["chat", "events", "vault", "settings"] as View[]).map((item) =>
          <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>{t(item)}</button>)}
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
            <div className="message-list">{messages.length === 0 ? <div className="empty">{t("noMessages")}</div> : messages.map((message) =>
              <article className="message-bubble" key={message.id}><p>{message.content ?? t("sourceDeleted")}</p>
                <span>{new Date(message.createdAt).toLocaleString(language)}</span></article>)}</div>
            {lastDraft && <div className="draft-card"><div><strong>{t("draftCreated")}</strong><span>{lastDraft.title}</span></div>
              <button onClick={() => void openEvent(lastDraft.id)}>{t("openEvent")}</button></div>}
            <div className="composer"><textarea aria-label={t("messagePlaceholder")} placeholder={t("messagePlaceholder")}
              value={messageText} onChange={(event) => setMessageText(event.target.value)} />
              <div><label className="check"><input type="checkbox" checked={createDraft} onChange={(event) => setCreateDraft(event.target.checked)} />{t("createDraft")}</label>
                <button className="primary" disabled={busy || !messageText.trim()} onClick={() => void sendMessage()}>{t("send")}</button></div></div>
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
            <section className="subsection"><h3>{t("revisions")}</h3><div className="revision-list">{revisions.map((revision) => <article key={revision.id}>
              <strong>{t("revision")} {revision.revision}</strong><span>{revision.reason} · {new Date(revision.createdAt).toLocaleString(language)}</span></article>)}</div></section>
          </>}
        </section>
      </div>}

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
              <button onClick={() => void window.grudgeVault.assets.verify(asset.id)}>{t("verify")}</button></div></article>)}</div>}
        </section>
        <aside className="panel"><div className="section-heading"><div><p className="eyebrow">JOBS</p><h2>{t("tasks")}</h2></div></div>
          {jobs.length === 0 ? <div className="empty compact">{t("noJobs")}</div> : jobs.map((job) => <article className="job-row" key={job.id}>
            <div><strong>{job.type}</strong><span>{t("attempt")} {job.attempts}/{job.maxAttempts}</span></div><em className={`status ${job.state}`}>{job.state}</em>
            <progress max={1} value={job.progress ?? 0} />{job.lastError && <p>{job.lastError}</p>}
            {job.state === "failed" && <button onClick={() => void window.grudgeVault.jobs.retry(job.id)}>{t("retry")}</button>}</article>)}</aside>
      </div>}

      {view === "settings" && <div className="settings-grid">
        <section className="panel settings-card"><p className="eyebrow">LANGUAGE</p><h2>{t("language")}</h2>
          <div className="language-pills"><button className={language === "zh-CN" ? "active" : ""} onClick={() => setAppLanguage("zh-CN")}>{t("chinese")}</button>
            <button className={language === "en" ? "active" : ""} onClick={() => setAppLanguage("en")}>{t("english")}</button></div></section>
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

    {preview && <div className="modal-backdrop" onClick={() => setPreview(undefined)}><section className="preview-modal" onClick={(event) => event.stopPropagation()}>
      <div className="section-heading"><h2>{preview.fileName}</h2><button onClick={() => setPreview(undefined)}>×</button></div>
      <div className="preview-content">{preview.text !== undefined ? <pre>{preview.text}</pre> : preview.mimeType.startsWith("image/") ? <img src={preview.url} alt={preview.fileName} />
        : preview.mimeType.startsWith("audio/") ? <audio controls src={preview.url} /> : preview.mimeType.startsWith("video/") ? <video controls src={preview.url} />
          : <iframe title={preview.fileName} src={preview.url} />}</div></section></div>}
  </main>;
}
