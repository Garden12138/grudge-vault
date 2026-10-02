import { useLayoutEffect, useRef } from "react";

type ModalEntry = { element: globalThis.HTMLElement; lastFocus: globalThis.HTMLElement | null; restoreTargets: globalThis.HTMLElement[] };
type ModalState = {
  entries: ModalEntry[];
  inert: Map<globalThis.HTMLElement, { count: number; previous: string | null }>;
  overflow?: { value: string; priority: string };
};
const states = new WeakMap<globalThis.Document, ModalState>();
const FOCUSABLE = "button, input, textarea, select, a[href], [tabindex], [contenteditable=true], audio[controls], video[controls]";

function available(element: globalThis.HTMLElement): boolean {
  if (!element.isConnected || element.matches(":disabled") || element.closest("[inert], [hidden]")) return false;
  for (let current: globalThis.HTMLElement | null = element; current; current = current.parentElement) {
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === "none" || style?.visibility === "hidden") return false;
  }
  return true;
}

function controls(element: globalThis.HTMLElement): globalThis.HTMLElement[] {
  return Array.from(element.querySelectorAll<globalThis.HTMLElement>(FOCUSABLE))
    .filter((control) => control.tabIndex >= 0 && available(control));
}

function focusEntry(entry: ModalEntry): void {
  const preferred = entry.lastFocus && available(entry.lastFocus) ? entry.lastFocus : null;
  (preferred ?? controls(entry.element)[0] ?? entry.element).focus({ preventScroll: true });
}

/** Own only modal UI state. Nested drawers must not release the editor's focus or background isolation. */
export function useModalFocus<T extends globalThis.HTMLElement>() {
  const ref = useRef<T>(null);
  // Capture before React's autoFocus commit replaces the initiating control.
  const opener = useRef(typeof document !== "undefined" && document.activeElement instanceof globalThis.HTMLElement
    ? document.activeElement : null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const owner = element.ownerDocument;
    let state = states.get(owner);
    if (!state) { state = { entries: [], inert: new Map() }; states.set(owner, state); }
    const shared = state;
    const parentEntry = shared.entries.at(-1);
    const entry: ModalEntry = { element, lastFocus: null,
      restoreTargets: [...(opener.current ? [opener.current] : []), ...(parentEntry?.restoreTargets ?? [])] };
    if (!shared.entries.length) {
      shared.overflow = { value: owner.body.style.getPropertyValue("overflow"), priority: owner.body.style.getPropertyPriority("overflow") };
      owner.body.style.setProperty("overflow", "hidden");
    }
    shared.entries.push(entry);
    const isolated: globalThis.HTMLElement[] = [];
    for (let branch: globalThis.HTMLElement = element; branch.parentElement; branch = branch.parentElement) {
      const parent = branch.parentElement;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === branch || !(sibling instanceof globalThis.HTMLElement)) continue;
        const existing = shared.inert.get(sibling);
        if (existing) existing.count++;
        else shared.inert.set(sibling, { count: 1, previous: sibling.getAttribute("inert") });
        sibling.setAttribute("inert", ""); isolated.push(sibling);
      }
      if (parent === owner.body) break;
    }
    const isTop = () => shared.entries.at(-1) === entry;
    const trapTab = (event: globalThis.KeyboardEvent) => {
      if (!isTop() || event.key !== "Tab") return;
      const choices = controls(element);
      const active = owner.activeElement;
      if (!choices.length || !choices.includes(active as globalThis.HTMLElement)) {
        event.preventDefault(); (event.shiftKey ? choices.at(-1) : choices[0])?.focus();
        if (!choices.length) element.focus();
      } else if (event.shiftKey && active === choices[0]) {
        event.preventDefault(); choices.at(-1)!.focus();
      } else if (!event.shiftKey && active === choices.at(-1)) {
        event.preventDefault(); choices[0]!.focus();
      }
    };
    const containFocus = (event: globalThis.FocusEvent) => {
      if (!isTop() || !(event.target instanceof globalThis.HTMLElement)) return;
      if (element.contains(event.target)) entry.lastFocus = event.target;
      else focusEntry(entry);
    };
    owner.addEventListener("keydown", trapTab, true);
    owner.addEventListener("focusin", containFocus, true);
    const active = owner.activeElement;
    if (active instanceof globalThis.HTMLElement && element.contains(active) && available(active)) entry.lastFocus = active;
    else entry.lastFocus = controls(element).find((control) => control.hasAttribute("autofocus")) ?? null;
    focusEntry(entry);
    return () => {
      const wasTop = isTop();
      owner.removeEventListener("keydown", trapTab, true);
      owner.removeEventListener("focusin", containFocus, true);
      shared.entries.splice(shared.entries.indexOf(entry), 1);
      for (const sibling of isolated) {
        const held = shared.inert.get(sibling)!;
        if (--held.count > 0) continue;
        if (held.previous === null) sibling.removeAttribute("inert");
        else sibling.setAttribute("inert", held.previous);
        shared.inert.delete(sibling);
      }
      const top = shared.entries.at(-1);
      if (!top && shared.overflow) {
        if (shared.overflow.value) owner.body.style.setProperty("overflow", shared.overflow.value, shared.overflow.priority);
        else owner.body.style.removeProperty("overflow");
        delete shared.overflow;
      }
      if (!wasTop) return;
      const restore = entry.restoreTargets.find((target) => available(target) && (!top || top.element.contains(target)));
      if (restore) restore.focus({ preventScroll: true });
      else if (top) focusEntry(top);
    };
  }, []);
  return ref;
}
