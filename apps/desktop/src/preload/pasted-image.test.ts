import { describe, expect, it, vi } from "vitest";
import { readPastedImage } from "./pasted-image";

describe("pasted image preparation", () => {
  it("reads a selected image in bounded chunks", async () => {
    const file = {
      size: 4,
      stream: () => new globalThis.ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 2]));
          controller.enqueue(Uint8Array.from([3, 4]));
          controller.close();
        }
      })
    };
    await expect(readPastedImage(file, new AbortController().signal)).resolves.toEqual(Uint8Array.from([1, 2, 3, 4]));
  });

  it("cancels an in-flight stream when the editor is closed", async () => {
    const cancelled = vi.fn();
    const file = {
      size: 4,
      stream: () => new globalThis.ReadableStream<Uint8Array<ArrayBuffer>>({ cancel: cancelled })
    };
    const controller = new AbortController();
    const reason = new Error("editor closed");
    const pending = readPastedImage(file, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("rejects a stream that produces more bytes than the selected file size", async () => {
    const file = {
      size: 1,
      stream: () => new globalThis.ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) { controller.enqueue(Uint8Array.from([1, 2])); }
      })
    };
    await expect(readPastedImage(file, new AbortController().signal))
      .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });
});
