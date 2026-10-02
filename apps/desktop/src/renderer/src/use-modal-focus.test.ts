// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModalFocus } from "./use-modal-focus";

function Dialog({ id, empty = false }: { id: string; empty?: boolean }) {
  const ref = useModalFocus<globalThis.HTMLElement>();
  return createElement("div", { id: `${id}-backdrop` }, createElement("section", {
    ref, tabIndex: -1, role: "dialog", "aria-modal": true, id
  }, empty ? null : [
    createElement("button", { key: "close", id: `${id}-close` }, "Close"),
    createElement("textarea", { key: "input", autoFocus: id === "outer", id: `${id}-input` }),
    createElement("input", { key: "file", type: "file", id: `${id}-file`, style: { position: "absolute", width: 1, height: 1, clipPath: "inset(50%)" } }),
    createElement("button", { key: "disabled", disabled: true, id: `${id}-disabled` }, "Disabled"),
    createElement("div", { key: "hidden", style: { display: "none" } }, createElement("button", null, "Hidden")),
    createElement("button", { key: "last", id: `${id}-last` }, "Last")
  ]));
}

function Probe({ outer = true, inner = false, empty = false }: { outer?: boolean; inner?: boolean; empty?: boolean }) {
  return createElement("div", null,
    createElement("main", { id: "background" }, createElement("button", { id: "background-action" }, "Background")),
    outer ? createElement(Dialog, { id: "outer", empty }) : null,
    inner ? createElement(Dialog, { id: "inner" }) : null);
}

describe("modal keyboard and background lifecycle", () => {
  let root: Root;
  let opener: globalThis.HTMLButtonElement;
  const element = (id: string) => document.getElementById(id)!;
  const tab = (shiftKey = false) => {
    const event = new globalThis.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, shiftKey });
    document.activeElement!.dispatchEvent(event); return event;
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    opener = document.body.appendChild(document.createElement("button")); opener.textContent = "Open"; opener.focus();
    root = createRoot(document.body.appendChild(document.createElement("div")));
  });
  afterEach(async () => {
    await act(async () => root.unmount()); document.body.replaceChildren(); document.body.removeAttribute("style"); vi.unstubAllGlobals();
  });

  it("retains autofocus, makes the background inert and restores the initiating control and scroll policy", async () => {
    document.body.style.setProperty("overflow", "auto", "important");
    await act(async () => root.render(createElement(Probe)));
    expect(document.activeElement).toBe(element("outer-input"));
    expect(element("background").hasAttribute("inert")).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    await act(async () => root.render(createElement(Probe, { outer: false })));
    expect(document.activeElement).toBe(opener); expect(opener.hasAttribute("inert")).toBe(false);
    expect(element("background").hasAttribute("inert")).toBe(false);
    expect(document.body.style.getPropertyValue("overflow")).toBe("auto");
    expect(document.body.style.getPropertyPriority("overflow")).toBe("important");
  });

  it("wraps Tab in both directions, skips disabled/hidden controls and keeps a clipped file input keyboard-accessible", async () => {
    await act(async () => root.render(createElement(Probe)));
    element("outer-last").focus(); expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(element("outer-close"));
    expect(tab(true).defaultPrevented).toBe(true); expect(document.activeElement).toBe(element("outer-last"));
    element("outer-file").focus(); expect(tab().defaultPrevented).toBe(false);
  });

  it("contains programmatic focus and wraps safely if the focused control becomes disabled", async () => {
    await act(async () => root.render(createElement(Probe)));
    element("background-action").focus(); expect(document.activeElement).toBe(element("outer-input"));
    const last = element("outer-last") as globalThis.HTMLButtonElement; last.focus(); last.disabled = true;
    expect(tab().defaultPrevented).toBe(true); expect(document.activeElement).toBe(element("outer-close"));
  });

  it("gives only the top drawer focus and restores the still-open editor without releasing background isolation", async () => {
    await act(async () => root.render(createElement(Probe)));
    element("outer-last").focus();
    await act(async () => root.render(createElement(Probe, { inner: true })));
    expect(document.activeElement).toBe(element("inner-close"));
    expect(element("outer-backdrop").hasAttribute("inert")).toBe(true);
    element("inner-last").focus(); tab(); expect(document.activeElement).toBe(element("inner-close"));
    await act(async () => root.render(createElement(Probe)));
    expect(document.activeElement).toBe(element("outer-last"));
    expect(element("outer-backdrop").hasAttribute("inert")).toBe(false);
    expect(element("background").hasAttribute("inert")).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    tab(); expect(document.activeElement).toBe(element("outer-close"));
    await act(async () => root.render(createElement(Probe, { outer: false })));
    expect(document.activeElement).toBe(opener);
  });

  it("releases reference-counted isolation when the editor unmounts before the drawer", async () => {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => root.render(createElement(Probe, { inner: true })));
    await act(async () => root.render(createElement(Probe, { outer: false, inner: true })));
    expect(element("background").hasAttribute("inert")).toBe(true); expect(document.body.style.overflow).toBe("hidden");
    await act(async () => root.render(createElement(Probe, { outer: false })));
    expect(element("background").hasAttribute("inert")).toBe(false); expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
  });

  it("restores an original inert attribute instead of enabling previously disabled background content", async () => {
    const protectedContent = document.body.appendChild(document.createElement("div")); protectedContent.setAttribute("inert", "original");
    await act(async () => root.render(createElement(Probe)));
    await act(async () => root.render(createElement(Probe, { outer: false })));
    expect(protectedContent.getAttribute("inert")).toBe("original");
  });

  it("focuses the panel itself when no enabled controls exist and never restores a removed opener", async () => {
    await act(async () => root.render(createElement(Probe, { empty: true })));
    expect(document.activeElement).toBe(element("outer")); expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(element("outer"));
    opener.remove();
    await act(async () => root.render(createElement(Probe, { outer: false })));
    expect(document.activeElement).toBe(document.body);
  });

  it("balances focus and isolation through the app's StrictMode setup/cleanup replay", async () => {
    await act(async () => root.render(createElement(StrictMode, null, createElement(Probe))));
    expect(element("outer").contains(document.activeElement)).toBe(true);
    expect(element("background").hasAttribute("inert")).toBe(true);
    await act(async () => root.render(createElement(StrictMode, null, createElement(Probe, { outer: false }))));
    expect(element("background").hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).toBe(""); expect(document.activeElement).toBe(opener);
  });
});
