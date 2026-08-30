import type { ComponentPropsWithoutRef, PropsWithChildren, ReactNode } from "react";

interface ProductPageProps extends PropsWithChildren {
  className?: string;
}

function pageClass(section: string, className?: string): string {
  return ["product-page", `${section}-product-page`, className].filter(Boolean).join(" ");
}

export function AppShell({ sidebar, children }: PropsWithChildren<{ sidebar: ReactNode }>) {
  return <main className="app-shell"><aside className="app-sidebar">{sidebar}</aside>
    <section className="workspace-view">{children}</section></main>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{actions}</header>;
}

export function PageTabs({ label, children }: PropsWithChildren<{ label: string }>) {
  return <nav className="section-tabs" aria-label={label}>{children}</nav>;
}

export function Section({ children, className, ...props }: PropsWithChildren<ComponentPropsWithoutRef<"section">>) {
  return <section {...props} className={["panel", "product-section", className].filter(Boolean).join(" ")}>{children}</section>;
}

export function FieldRow({ children, className }: ProductPageProps) {
  return <div className={["field-row", className].filter(Boolean).join(" ")}>{children}</div>;
}

export function EmptyState({ children }: PropsWithChildren) {
  return <div className="empty" role="status">{children}</div>;
}

export function StatusBadge({ status, children }: PropsWithChildren<{ status: string }>) {
  return <span className={`status ${status}`}>{children}</span>;
}

export function SplitPane({ children, className }: ProductPageProps) {
  return <div className={["split-pane", className].filter(Boolean).join(" ")}>{children}</div>;
}

export function RecordPage({ children, className }: ProductPageProps) {
  return <div className={pageClass("record", className)}>{children}</div>;
}

export function MemoryPage({ children, className }: ProductPageProps) {
  return <div className={pageClass("memory", className)}>{children}</div>;
}

export function ReviewPage({ children, className }: ProductPageProps) {
  return <div className={pageClass("review", className)}>{children}</div>;
}

export function MaterialsPage({ children, className }: ProductPageProps) {
  return <div className={pageClass("materials", className)}>{children}</div>;
}

export function SettingsPage({ children, className }: ProductPageProps) {
  return <div className={pageClass("settings", className)}>{children}</div>;
}
