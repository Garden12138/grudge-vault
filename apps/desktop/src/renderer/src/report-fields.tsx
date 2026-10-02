import type { AnalysisReportContent, ReportFieldSource, ReportPerson, TemporalValue } from "@grudge-vault/domain";

function SourceBadge({ source }: { source: ReportFieldSource }) {
  const labels: Record<ReportFieldSource, string> = { user: "你已补充", source: "来自原始材料", ai: "AI 整理" };
  return <em title="来源标识不等于事实已核实">{labels[source] ?? "来源待核对"}</em>;
}

export function ReportField({ label, value, prompt, source }: {
  label: string; value?: string; prompt?: string; source?: ReportFieldSource;
}) {
  return <div className="report-field"><span>{label}</span><div>
    <strong>{value?.trim() || prompt?.trim() || "待补充"}</strong>{source && <SourceBadge source={source} />}
  </div></div>;
}

export function ReportTimeField({ field, userValue, userSupplied = false, userKind }: {
  field: AnalysisReportContent["time"]; userValue?: string; userSupplied?: boolean; userKind?: TemporalValue["kind"];
}) {
  const time = field.value;
  const precision = { exact: "明确时间", approximate: "大约时间", range: "时间范围", unknown: "时间待补充" };
  const userPrecision = { instant: "具体时刻", date: "日期", month: "月份", range: "时间范围", relative: "相对时间", unknown: "时间待补充" };
  // An unknown precision cannot promote a conflicting model value to a fact.
  const value = userSupplied ? userValue && userKind !== "unknown" ? `${userValue}${userKind ? `（${userPrecision[userKind]}）` : ""}` : undefined
    : time?.value.trim() && time.precision !== "unknown"
    ? `${time.value}（${precision[time.precision]}）` : undefined;
  return <ReportField label="时间" {...(value ? { value } : {})}
    prompt={field.prompt || "待补充：大约何时发生？"} source={userSupplied ? "user" : field.source} />;
}

export function ReportPeopleField({ people, onSupplement, disabled = false }: {
  people: ReportPerson[]; onSupplement(): void; disabled?: boolean;
}) {
  const known = people.filter(({ name }) => name.trim());
  return <div className="report-field report-people-field"><span>人物</span>
    {known.length ? <ul className="report-person-list">{known.map(({ name, role, source }, index) =>
      <li key={index}><strong>{name}{role?.trim() ? `（${role}）` : ""}</strong><SourceBadge source={source} /></li>
    )}</ul> : <div><strong>待补充：有哪些相关人物？</strong></div>}
    <button className="text-button" disabled={disabled} onClick={onSupplement}>补充人物信息</button>
  </div>;
}
