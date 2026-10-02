// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "@grudge-vault/domain";
import type { AssetPreview, GrudgeVaultApi, IpcResult } from "@grudge-vault/shared";
import { AttachmentItem } from "./App";

const asset: Asset = { id: "00000000-0000-4000-8000-000000000061", originalFileName: "synthetic.heic", mimeType: "image/heic",
  byteSize: 100, sha256: "a".repeat(64), vaultFormat: 2, availabilityStatus: "available", integrityStatus: "verified", createdAt: "2026-09-28T00:00:00Z" };
const preview: IpcResult<AssetPreview> = { ok: true, data: { assetId: asset.id, fileName: asset.originalFileName,
  mimeType: "image/png", bytes: Uint8Array.from([1, 2, 3]), representation: "converted-image" } };

describe("converted attachment preview lifecycle", () => {
  let root: Root | undefined; let original: GrudgeVaultApi;
  const create = vi.fn(() => "blob:synthetic-heic-preview"), revoke = vi.fn();
  beforeEach(() => {
    original = window.grudgeVault; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("URL", class extends globalThis.URL {
      static createObjectURL() { return create(); }
      static revokeObjectURL(url: string) { revoke(url); }
    });
  });
  afterEach(async () => {
    if (root) await act(async () => root?.unmount()); root = undefined;
    window.grudgeVault = original; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); create.mockClear(); revoke.mockClear();
  });

  it("labels the converted preview but exports the original asset and releases the object URL", async () => {
    const exportCopy = vi.fn(async () => ({ ok: true, data: null }));
    window.grudgeVault = { assets: { preview: vi.fn(async () => preview), exportCopy } } as unknown as GrudgeVaultApi;
    const container = document.body.appendChild(document.createElement("div")); root = createRoot(container);
    await act(async () => root?.render(createElement(AttachmentItem, { asset })));
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "预览")!.click());
    expect(container.textContent).toContain("HEIC 转换预览"); expect(container.textContent).toContain("仍导出原始 HEIC");
    expect(container.querySelector("img")?.alt).toBe("synthetic.heic 转换预览");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "保存副本")!.click());
    expect(exportCopy).toHaveBeenCalledWith(asset.id);
    await act(async () => root?.unmount()); root = undefined;
    expect(revoke).toHaveBeenCalledWith("blob:synthetic-heic-preview");
  });

  it("does not create a blob or update a detached view after a slow HEIC conversion", async () => {
    let release!: (result: IpcResult<AssetPreview>) => void;
    const pending = new Promise<IpcResult<AssetPreview>>((resolve) => { release = resolve; });
    window.grudgeVault = { assets: { preview: () => pending } } as unknown as GrudgeVaultApi;
    const container = document.body.appendChild(document.createElement("div")); root = createRoot(container);
    await act(async () => root?.render(createElement(AttachmentItem, { asset })));
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "预览")!.click());
    await act(async () => root?.unmount()); root = undefined;
    await act(async () => release(preview));
    expect(create).not.toHaveBeenCalled(); expect(container.textContent).toBe("");
  });

  it("uses a revocable media URL instead of IPC bytes and closes it on unmount", async () => {
    const mediaAsset = { ...asset, mimeType: "audio/wav", originalFileName: "synthetic.wav", byteSize: 70 * 1024 * 1024 };
    const url = `gv-preview://media/${"a".repeat(64)}`;
    const openMediaPreview = vi.fn(async (input: { requestId: string; assetId: string }) => ({ ok: true, data: {
      ...input, url, mimeType: "audio/wav", byteSize: mediaAsset.byteSize
    } }));
    const closeMediaPreview = vi.fn(async () => ({ ok: true, data: true })); const inline = vi.fn();
    window.grudgeVault = { assets: { openMediaPreview, closeMediaPreview, preview: inline } } as unknown as GrudgeVaultApi;
    const container = document.body.appendChild(document.createElement("div")); root = createRoot(container);
    await act(async () => root?.render(createElement(AttachmentItem, { asset: mediaAsset })));
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "预览")!.click());
    expect(container.querySelector("audio")?.src).toBe(url); expect(inline).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    const requestId = openMediaPreview.mock.calls[0]![0].requestId;
    await act(async () => root?.unmount()); root = undefined;
    expect(closeMediaPreview).toHaveBeenCalledWith(requestId); expect(revoke).not.toHaveBeenCalled();
  });

  it.each(["cancel", "unmount", "replace"] as const)("revokes a pending media request on %s and discards its late reply", async (action) => {
    const mediaAsset = { ...asset, mimeType: "video/mp4", originalFileName: "synthetic.mp4" };
    let release!: (result: IpcResult<import("@grudge-vault/shared").AssetMediaPreview>) => void;
    const pending = new Promise<IpcResult<import("@grudge-vault/shared").AssetMediaPreview>>((resolve) => { release = resolve; });
    const openMediaPreview = vi.fn(() => pending), closeMediaPreview = vi.fn(async () => ({ ok: true, data: true }));
    window.grudgeVault = { assets: { openMediaPreview, closeMediaPreview } } as unknown as GrudgeVaultApi;
    const container = document.body.appendChild(document.createElement("div")); root = createRoot(container);
    await act(async () => root?.render(createElement(AttachmentItem, { asset: mediaAsset })));
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "预览")!.click());
    expect(container.textContent).toContain("正在认证私有原件预览副本");
    const requestId = (openMediaPreview.mock.calls[0] as unknown as [{ requestId: string }])[0].requestId;
    if (action === "cancel") await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "取消预览")!.click());
    else if (action === "replace") await act(async () => root?.render(createElement(AttachmentItem, { asset: { ...mediaAsset, id: "00000000-0000-4000-8000-000000000062" } })));
    else { await act(async () => root?.unmount()); root = undefined; }
    expect(closeMediaPreview).toHaveBeenCalledWith(requestId);
    await act(async () => release({ ok: true, data: { requestId, assetId: mediaAsset.id, mimeType: "video/mp4", byteSize: 100,
      url: `gv-preview://media/${"a".repeat(64)}` } }));
    expect(container.querySelector("video")).toBeNull(); expect(create).not.toHaveBeenCalled();
  });
});
