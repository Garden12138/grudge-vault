import { useState } from "react";
import type { PendingReview } from "@grudge-vault/domain";
import { displayError, unwrap } from "./ui-errors";

export function PendingReviewDetails({ item, onChanged, onReprovide }: {
  item: PendingReview; onChanged?(): Promise<void>; onReprovide?(): void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<PendingReview>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = async () => {
    setBusy(true); setError("");
    try { setDetail(unwrap(await window.grudgeVault.pending.get(item.id))); }
    catch (cause) { setError(displayError(cause)); }
    finally { setBusy(false); }
  };
  const restore = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = unwrap(await window.grudgeVault.pending.restoreDetails(item.id));
      if (!result) return;
      setDetail(result.detail);
      setNotice(result.restored > 1 ? `已补全 ${result.restored} 条待确认的全文。` : "全文已补全。");
      await onChanged?.();
    } catch (cause) { setError(displayError(cause)); }
    finally { setBusy(false); }
  };
  return <div className="pending-details">
    <button className="text-button" aria-expanded={open} onClick={() => { setOpen(!open); if (!open && detail?.text === undefined && !busy) void load(); }}>{open ? "收起详情" : "查看详情"}</button>
    {open && <section aria-label="待确认详情">
      {busy && <p role="status">正在读取…</p>}
      {error && <div className="banner error" role="alert">{error}<button onClick={() => void load()}>重新读取详情</button></div>}
      {notice && <p role="status">{notice}</p>}
      {detail && <>
        <p className="muted">记录日期：{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(detail.recordedAt ?? detail.createdAt))}</p>
        <pre>{detail.text ?? detail.excerpt}</pre>
        {detail.text === undefined && <div className="pending-recover"><p className="muted">目前只有摘录。</p>
          {detail.origin === "zip" || detail.origin === "migration" ? <button disabled={busy} onClick={() => void restore()}>{detail.origin === "zip" ? "选择原 ZIP，补全全文" : "选择旧工作区，补全全文"}</button>
            : onReprovide && <button disabled={busy} onClick={onReprovide}>补充原文</button>}
        </div>}
        {detail.text === "" && <p className="muted">这条内容没有文字，请结合附件核对。</p>}
        {Boolean(detail.attachmentNames?.length) && <><h3>附件</h3><ul>{detail.attachmentNames!.map((name, index) => <li key={index}>{name}</li>)}</ul></>}
      </>}
    </section>}
  </div>;
}
