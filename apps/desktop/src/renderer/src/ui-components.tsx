import { useEffect, useState, type PropsWithChildren } from "react";

export function Icon({ name, className = "" }: { name: "timeline" | "search" | "settings" | "plus" | "close" | "chevron" | "record" | "lock"; className?: string }) {
  const paths = {
    lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
    timeline: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
    settings: <><path d="m9 3-1 3-3 1-2 3 2 2v3l3 1 1 3h4l1-3 3-1v-3l2-2-2-3-3-1-1-3Z" /><circle cx="11" cy="11" r="3" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chevron: <path d="m8 10 4 4 4-4" />,
    record: <><path d="M6 3h12v18H6a3 3 0 0 1 0-6h12M6 3a3 3 0 0 0-3 3v12M8 7h6M8 10h4" /></>
  };
  return <svg className={`ui-icon ${className}`} viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

export function Disclosure({ title, children, className = "", forceOpen = false, defaultOpen = false }: PropsWithChildren<{
  title: string; className?: string; forceOpen?: boolean; defaultOpen?: boolean;
}>) {
  const [open, setOpen] = useState(defaultOpen || forceOpen);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  return <details className={`disclosure ${className}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span>{title}</span><Icon name="chevron" /></summary><div className="disclosure-content">{children}</div>
  </details>;
}
