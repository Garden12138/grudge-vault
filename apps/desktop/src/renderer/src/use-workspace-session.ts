import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingReview, WorkspaceLockState } from "@grudge-vault/domain";

export interface WorkspaceSessionAccess {
  status(): Promise<WorkspaceLockState>;
  pending(): Promise<PendingReview[]>;
  onLocked(listener: () => void): () => void;
}
interface RendererSession { version: number; workspaceId?: string; }
const readFailure = (cause: unknown): Error => cause instanceof Error ? cause : new Error("状态读取未完成，请重试。");

/** Renderer-only ownership. Never serialize this token or retain a reply from a revoked session. */
export function useWorkspaceSession(access: WorkspaceSessionAccess, onRevoked: () => void) {
  const [status, setStatus] = useState<WorkspaceLockState>({ status: "closed" });
  const [ready, setReady] = useState(false), [error, setError] = useState<unknown>();
  const [pending, setPending] = useState<PendingReview[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false), [pendingError, setPendingError] = useState<unknown>();
  const mounted = useRef(false), workspaceRead = useRef(0), pendingRead = useRef(0);
  const [session, setSession] = useState<RendererSession>(() => ({ version: 0 }));
  const currentSession = useRef(session);
  const revoke = useCallback((workspaceId?: string) => {
    currentSession.current = { version: currentSession.current.version + 1, ...(workspaceId ? { workspaceId } : {}) };
    pendingRead.current++;
    setSession(currentSession.current); setPending([]); setPendingLoading(false); setPendingError(undefined);
    onRevoked();
  }, [onRevoked]);
  const refreshWorkspace = useCallback(async (): Promise<void> => {
    if (!mounted.current) return;
    const request = ++workspaceRead.current;
    try {
      const next = await access.status();
      if (!mounted.current || request !== workspaceRead.current) return;
      const workspaceId = next.status === "open" ? next.workspace.id : undefined;
      if (workspaceId !== currentSession.current.workspaceId) revoke(workspaceId);
      setStatus(next); setError(undefined); setReady(true);
    } catch (cause) {
      if (!mounted.current || request !== workspaceRead.current) return;
      // The status is unknown, not proof of a closed or unlocked workspace. Hide scoped content.
      revoke(); setStatus({ status: "closed" }); setError(readFailure(cause)); setReady(true);
    }
  }, [access, revoke]);
  const isCurrentSession = useCallback((candidate: RendererSession): boolean =>
    mounted.current && Boolean(candidate.workspaceId) && candidate === currentSession.current, []);
  const refreshPending = useCallback(async (): Promise<void> => {
    const scope = currentSession.current;
    if (!isCurrentSession(scope)) return;
    const request = ++pendingRead.current;
    setPendingLoading(true); setPendingError(undefined);
    try {
      const items = await access.pending();
      if (!isCurrentSession(scope) || request !== pendingRead.current) return;
      setPending(items);
    } catch (cause) {
      if (!isCurrentSession(scope) || request !== pendingRead.current) return;
      setPending([]); setPendingError(readFailure(cause));
    } finally {
      if (isCurrentSession(scope) && request === pendingRead.current) setPendingLoading(false);
    }
  }, [access, isCurrentSession]);
  useEffect(() => {
    const workspaceReads = workspaceRead, pendingReads = pendingRead;
    mounted.current = true;
    // Subscribe first so even a synchronous notification during the initial read invalidates it.
    const unsubscribe = access.onLocked(() => {
      if (!mounted.current) return;
      workspaceRead.current++; revoke(); setStatus({ status: "closed" }); setError(undefined); setReady(false);
      void refreshWorkspace();
    });
    void refreshWorkspace();
    return () => {
      mounted.current = false; workspaceReads.current++; pendingReads.current++;
      currentSession.current = { version: currentSession.current.version + 1 }; unsubscribe();
    };
  }, [access, refreshWorkspace, revoke]);
  useEffect(() => { if (session.workspaceId) void refreshPending(); }, [session, refreshPending]);
  return { status, ready, error, session, isCurrentSession, refreshWorkspace, pending, pendingLoading, pendingError, refreshPending };
}
