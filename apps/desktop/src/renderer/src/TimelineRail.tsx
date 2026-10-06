import { useState } from "react";
import type { EventRecord } from "@grudge-vault/domain";
import { recordTimeSourceLabel, temporalLabel, timelineGroupLabel } from "./record-time";

const categoryLabel = { grudge: "冲突", rights: "权益", danger: "危险" };
const originLabel = { manual: "手动记录", dayone: "Day One", zip: "ZIP 导入", migration: "旧数据迁移" };
const reportLabel = { queued: "等待分析", running: "分析中", partial: "部分完成", failed: "分析失败", complete: "已完成", stale: "报告待更新" };

export function RecordStatus({ record }: { record: EventRecord }) {
  const state = record.sourceReviewRequired ? "stale" : record.reportState;
  return <span className={`status status-${state}`}>{record.sourceReviewRequired ? "来源待核对" : reportLabel[state]}</span>;
}

/** Date-only imported titles convey no event; use the supplied summary without rewriting the saved record. */
function timelineHeading(record: Pick<EventRecord, "title" | "summary">): string {
  return /^\d{4}[年/-]\d{1,2}[月/-]\d{1,2}(日)?([，,\s]*(星期|周)[一二三四五六日天])?$/.test(record.title.trim()) && record.summary
    ? record.summary : record.title;
}

export function TimelineRail({ records, timeZone, onOpen }: { records: EventRecord[]; timeZone?: string | undefined; onOpen(id: string): void }) {
  const [preview, setPreview] = useState<{ id: string; above: boolean }>();
  const groups = new Map<string, EventRecord[]>();
  for (const record of records) {
    const date = timelineGroupLabel(record, timeZone);
    groups.set(date, [...(groups.get(date) ?? []), record]);
  }
  const show = (id: string, element: globalThis.HTMLElement) => {
    const box = element.getBoundingClientRect();
    setPreview({ id, above: globalThis.innerHeight - box.bottom < 270 && box.top > 270 });
  };
  return <div className="timeline-groups timeline-rail" aria-label="事件时间线">
    {[...groups].map(([date, items]) => <section className="timeline-group" key={date}>
      <h2>{date}</h2><ol className="timeline-events">{items.map(record => {
        const expanded = preview?.id === record.id;
        const heading = timelineHeading(record);
        return <li className={`timeline-item${expanded ? " previewing" : ""}${record.categories.includes("danger") ? " has-danger" : ""}`} key={record.id}
          onPointerEnter={event => { if (event.pointerType !== "touch") show(record.id, event.currentTarget); }}
          onPointerLeave={() => setPreview(current => current?.id === record.id ? undefined : current)}
          onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setPreview(undefined); } }}>
          <button className="record-card timeline-event" aria-label={`查看记录：${record.title}`} aria-describedby={expanded ? `preview-${record.id}` : undefined}
            onFocus={event => show(record.id, event.currentTarget)} onBlur={() => setPreview(undefined)} onClick={() => { setPreview(undefined); onOpen(record.id); }}>
            <span className="timeline-node" aria-hidden="true" />
            <div className="record-card-top"><span>{temporalLabel(record, timeZone)}{recordTimeSourceLabel(record) && <small className="record-time-source">{recordTimeSourceLabel(record)}</small>}</span><RecordStatus record={record} /></div>
            <strong className={heading === record.summary ? "summary-heading" : ""}>{heading}</strong>
            {heading !== record.summary && <p>{record.summary || "记录已保存，正在整理报告。"}</p>}
            {heading !== record.title && <span className="sr-only">{record.title}</span>}
          </button>
          {expanded && <div id={`preview-${record.id}`} className={`timeline-preview${preview.above ? " above" : ""}`} role="note" onClick={() => onOpen(record.id)}>
            <div className="timeline-preview-top"><span>{temporalLabel(record, timeZone)}</span><RecordStatus record={record} /></div>
            <h3>{record.title}</h3><p>{record.summary || "记录已保存，正在整理报告。"}</p>
            <div className="chips">{record.categories.map(category => <span className={`chip chip-${category}`} key={category}>{categoryLabel[category]}</span>)}<span className="chip subtle">{originLabel[record.origin]}</span>{record.attachmentCount > 0 && <span className="chip subtle">{record.attachmentCount} 个媒体</span>}</div>
            <span className="preview-open-hint">点击查看完整记录 <span aria-hidden="true">↗</span></span>
          </div>}
        </li>;
      })}</ol>
    </section>)}
  </div>;
}
