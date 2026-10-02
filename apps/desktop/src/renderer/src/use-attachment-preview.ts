import { useCallback, useEffect, useRef, useState } from "react";
import type { IpcResult } from "@grudge-vault/shared";

type Resource = { kind: "blob"; url: string } | { kind: "media"; requestId: string };

/** A pending lease belongs to the view that opened it, even when its IPC reply arrives after unmount. */
export function useAttachmentPreview(assetId: string, mimeType: string,
  unwrap: <T>(result: IpcResult<T>) => T, formatError: (error: unknown) => string) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [converted, setConverted] = useState(false);
  const [pendingMedia, setPendingMedia] = useState(false);
  const resource = useRef<Resource | undefined>(undefined);
  const sequence = useRef(0), live = useRef(true);
  const media = /^(audio|video)\//.test(mimeType);
  const release = useCallback(async (value: Resource) => {
    if (value.kind === "blob") URL.revokeObjectURL(value.url);
    else unwrap(await window.grudgeVault.assets.closeMediaPreview(value.requestId));
  }, [unwrap]);
  useEffect(() => {
    live.current = true;
    setUrl(""); setBusy(false); setError(""); setConverted(false); setPendingMedia(false);
    return () => {
      live.current = false; sequence.current += 1;
      const value = resource.current; resource.current = undefined;
      // Main process reports cleanup failures and prevents further leases until recovery.
      if (value) void release(value).catch(() => {});
    };
  }, [assetId, release]);
  const toggle = useCallback(async () => {
    const request = ++sequence.current;
    const current = resource.current;
    setError(""); setBusy(true); setConverted(false);
    if (current) {
      resource.current = undefined; setUrl(""); setPendingMedia(false);
      try { await release(current); }
      catch (cause) { if (live.current && sequence.current === request) setError(formatError(cause)); }
      finally { if (live.current && sequence.current === request) setBusy(false); }
      return;
    }
    const pending: Resource | undefined = media ? { kind: "media", requestId: globalThis.crypto.randomUUID() } : undefined;
    resource.current = pending;
    setPendingMedia(Boolean(pending));
    try {
      if (pending?.kind === "media") {
        const value = unwrap(await window.grudgeVault.assets.openMediaPreview({ requestId: pending.requestId, assetId }));
        if (!live.current || sequence.current !== request) { await release(pending); return; }
        setUrl(value.url);
      } else {
        const value = unwrap(await window.grudgeVault.assets.preview(assetId));
        if (!live.current || sequence.current !== request) return;
        const bytes = Uint8Array.from(value.bytes);
        const blobUrl = URL.createObjectURL(new globalThis.Blob([bytes.buffer], { type: value.mimeType }));
        resource.current = { kind: "blob", url: blobUrl }; setUrl(blobUrl); setConverted(value.representation === "converted-image");
      }
    } catch (cause) {
      if (resource.current === pending) resource.current = undefined;
      if (pending) await release(pending).catch(() => {});
      if (live.current && sequence.current === request) setError(formatError(cause));
    } finally { if (live.current && sequence.current === request) { setBusy(false); setPendingMedia(false); } }
  }, [assetId, formatError, media, release, unwrap]);
  return { url, busy, error, converted, toggle, setError, setBusy, pendingMedia };
}
