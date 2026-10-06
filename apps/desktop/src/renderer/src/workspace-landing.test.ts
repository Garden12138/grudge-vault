// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceLockState } from "@grudge-vault/domain";
import { App } from "./App";

let root: Root | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals();
});

it("refreshes a failed opening's locked recovery state even without a pushed event", async () => {
  let state: WorkspaceLockState = { status: "closed" };
  const status = vi.fn(async () => ({ ok: true, data: state }));
  Object.defineProperty(window, "grudgeVault", { configurable: true, value: {
    workspace: {
      status, onLocked: () => () => {},
      open: async () => {
        state = { status: "locked", workspaceId: "synthetic", workspaceName: "合成待恢复工作区" };
        return { ok: false, error: { code: "WORKSPACE_KEY_UNAVAILABLE", message: "合成系统密钥暂不可用。", retryable: true } };
      }
    }
  } });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root?.render(createElement(App)));
  const button = Array.from(document.querySelectorAll("button")).find(({ textContent }) => textContent === "打开已有账本")!;
  await act(async () => button.click());
  expect(status).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain("合成待恢复工作区");
  expect(document.body.textContent).toContain("暂时打开账本");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("合成系统密钥暂不可用。");
  expect(document.body.textContent).not.toContain("创建账本");
});
