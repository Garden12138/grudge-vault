import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingReview, ScreenAndSaveResult } from "@grudge-vault/domain";
import { APP_ERROR_CODES } from "@grudge-vault/shared";
import { displayError, UiError, unwrap } from "./ui-errors";
import { useMediaProgress } from "./use-media-progress";

type IntakeState = "editing" | "preparing" | "screening" | "skipped" | "review" | "failed";
const subscribeProgress = (listener: Parameters<typeof window.grudgeVault.intake.onMediaProgress>[0]) => window.grudgeVault.intake.onMediaProgress(listener);

/** Complete input and sessions are volatile and owned by this editor lifetime. */
export function useRecordIntake({ initialPendingId, onSaved, onPendingChanged, onRescreenSettled }: {
  initialPendingId?: string; onSaved(id: string): void; onPendingChanged(): void; onRescreenSettled(): void;
}) {
  const [state, setState] = useState<IntakeState>("editing"), [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false), [pendingItem, setPendingItem] = useState<PendingReview>();
  const [pendingReadError, setPendingReadError] = useState("");
  const [configurationError, setConfigurationError] = useState(false);
  const pendingId = useRef(initialPendingId);
  const sessionId = useRef<string | undefined>(undefined), preparationId = useRef<string | undefined>(undefined);
  const submitting = useRef(false), active = useRef(false), epoch = useRef(0);
  const { progress, clear: clearProgress } = useMediaProgress(subscribeProgress, sessionId, submitting);
  const release = useCallback(async () => {
    epoch.current++;
    const requestId = preparationId.current, session = sessionId.current;
    preparationId.current = undefined; sessionId.current = undefined;
    await Promise.allSettled([
      ...(requestId ? [window.grudgeVault.intake.abandonPreparation(requestId)] : []),
      ...(session ? [window.grudgeVault.intake.abandon(session)] : [])
    ]);
  }, []);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; void release(); };
  }, [release]);
  const current = (scope: number) => active.current && epoch.current === scope;
  const resetFeedback = () => { if (submitting.current) return;
    setState("editing"); setMessage(""); setPendingItem(undefined); setPendingReadError(""); setConfigurationError(false);
  };
  const fail = (cause: unknown) => {
    setState("failed"); setMessage(displayError(cause));
    setConfigurationError(cause instanceof UiError && ["MODEL_NOT_CONFIGURED", "LLM_AUTHENTICATION_FAILED", "LLM_REGION_MISMATCH", "LLM_MODEL_NOT_FOUND", "LLM_TOOL_UNSUPPORTED", "LLM_CONFIGURATION_CHANGED"].includes(cause.code));
  };
  const readPending = async (scope = epoch.current) => {
    const id = pendingId.current;
    if (!id) return;
    setPendingReadError("");
    try {
      const item = unwrap(await window.grudgeVault.pending.list()).find((item) => item.id === id);
      if (!current(scope) || pendingId.current !== id) return;
      if (!item) { setPendingItem(undefined); setPendingReadError("这项待确认已变化，请重新提供完整内容并判断。"); return; }
      setPendingItem(item);
    } catch (cause) { if (current(scope)) { setPendingItem(undefined); setPendingReadError(displayError(cause)); } }
  };
  const acceptResult = async (result: ScreenAndSaveResult, scope: number) => {
    if (!current(scope)) return;
    setConfigurationError(false);
    if (result.kind !== "failed" && initialPendingId) onRescreenSettled();
    if (result.kind === "saved") { sessionId.current = undefined; pendingId.current = undefined; onSaved(result.recordId); return; }
    if (result.kind === "skipped") { pendingId.current = undefined; setPendingItem(undefined); setState("skipped");
      setMessage("不属于收录范围，尚未保存。你可以补充具体经过后重新判断。"); onPendingChanged(); return; }
    if (result.kind === "needs_review") {
      pendingId.current = result.pendingId; setState("review"); setMessage("需要你确认是否留存。当前只保存了短摘录，完整内容尚未入库。");
      onPendingChanged(); await readPending(scope); return;
    }
    const code = APP_ERROR_CODES.find((code) => code === result.code);
    fail(code ? new UiError(code, "未完成判断，请重试。", result.retryable) : new Error("未完成判断，请重试。"));
  };
  const submit = async (text: string, files: File[]) => {
    if (submitting.current || !active.current) return;
    const scope = ++epoch.current;
    submitting.current = true; setBusy(true); clearProgress(); setMessage(""); setState("preparing");
    try {
      if (sessionId.current) { const old = sessionId.current; sessionId.current = undefined; unwrap(await window.grudgeVault.intake.abandon(old)); }
      if (!current(scope)) return;
      const requestId = globalThis.crypto.randomUUID(); preparationId.current = requestId;
      const prepared = unwrap(await window.grudgeVault.intake.prepare({ requestId, text, files }));
      if (preparationId.current === requestId) preparationId.current = undefined;
      if (!current(scope)) { void window.grudgeVault.intake.abandon(prepared.sessionId); return; }
      sessionId.current = prepared.sessionId; setState("screening");
      const id = pendingId.current;
      const result = unwrap(await (id ? window.grudgeVault.pending.rescreenManual(id, prepared.sessionId)
        : window.grudgeVault.intake.screenAndSave(prepared.sessionId, globalThis.crypto.randomUUID())));
      await acceptResult(result, scope);
    } catch (cause) { if (current(scope)) { preparationId.current = undefined; fail(cause); } }
    finally { submitting.current = false; if (current(scope)) setBusy(false); }
  };
  const resolve = async (action: "keep" | "ignore"): Promise<boolean> => {
    const id = pendingId.current;
    if (!id || submitting.current || !active.current || state !== "review") return false;
    if (action === "keep" && !pendingItem?.sessionAvailable) return false;
    const scope = ++epoch.current;
    submitting.current = true; setBusy(true); setPendingReadError("");
    try {
      const result = unwrap(await window.grudgeVault.pending.resolve(id, action, globalThis.crypto.randomUUID()));
      if (!current(scope)) return false;
      onPendingChanged();
      if (action === "ignore") {
        await release();
        if (!active.current) return false;
        pendingId.current = undefined; setPendingItem(undefined); setState("editing"); setMessage("已忽略并清空，未建立正式记录。"); setBusy(false); return true;
      }
      if (result) await acceptResult(result, scope);
      else { await readPending(scope); if (current(scope)) setPendingReadError("这项待确认已变化，请重新判断。"); }
    } catch (cause) { if (current(scope)) { await readPending(scope); if (current(scope)) setPendingReadError(displayError(cause)); } }
    finally { submitting.current = false; if (current(scope)) setBusy(false); }
    return false;
  };
  return { state, message, busy, progress, pendingItem, pendingReadError, configurationError, submitting,
    resetFeedback, submit, resolve, readPending, release };
}
