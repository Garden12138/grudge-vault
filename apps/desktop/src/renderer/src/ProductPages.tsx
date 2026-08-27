import type { PropsWithChildren } from "react";

interface ProductPageProps extends PropsWithChildren {
  className?: string;
}

function pageClass(section: string, className?: string): string {
  return ["product-page", `${section}-product-page`, className].filter(Boolean).join(" ");
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
