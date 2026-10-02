import { describe, expect, it, vi } from "vitest";
import type { NativeImageConversionPort, NativeImageRepresentation } from "./redesign";
import { needsNativeImageConversion, prepareNativeImage } from "./native-image";

const input = { mimeType: "image/heic", bytes: Uint8Array.from([1, 2, 3]) };
const result: NativeImageRepresentation = { mimeType: "image/png", bytes: Uint8Array.from([4, 5, 6]), width: 96, height: 64 };
describe("native image representation boundary", () => {
  it("converts only HEIC/HEIF and preserves already supported inputs", async () => {
    const convert = vi.fn(async () => result);
    expect(needsNativeImageConversion("image/heic")).toBe(true); expect(needsNativeImageConversion("image/heif")).toBe(true);
    const jpeg = { ...input, mimeType: "image/jpeg" };
    expect(await prepareNativeImage(jpeg, { convert })).toEqual({ ...jpeg, converted: false });
    expect(convert).not.toHaveBeenCalled();
    expect(await prepareNativeImage(input, { convert })).toEqual({ bytes: result.bytes, mimeType: "image/png", converted: true });
  });
  it("rejects unavailable conversion and oversize before processing", async () => {
    const convert = vi.fn(async () => result);
    await expect(prepareNativeImage(input)).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
    await expect(prepareNativeImage({ ...input, bytes: new Uint8Array(20 * 1024 * 1024 + 1) }, { convert })).rejects.toMatchObject({ code: "MODALITY_UNAVAILABLE" });
    expect(convert).not.toHaveBeenCalled();
  });
  it.each([{ ...result, width: 0 }, { ...result, height: 0 }, { ...result, width: 50_000, height: 50_000 },
    { ...result, bytes: new Uint8Array() }, { ...result, bytes: new Uint8Array(7_000_001) },
    { ...result, mimeType: "image/heic" }, { ...result, width: 0.5 }])("rejects malformed representations", async (invalid) => {
    await expect(prepareNativeImage(input, { convert: async () => invalid } as NativeImageConversionPort)).rejects.toMatchObject({ code: "MEDIA_PROCESSING_FAILED" });
  });
  it("discards late converted images after cancellation", async () => {
    const controller = new AbortController();
    const reason = new globalThis.DOMException("Synthetic cancellation", "AbortError");
    await expect(prepareNativeImage(input, { convert: async () => { controller.abort(reason); return result; } }, controller.signal)).rejects.toBe(reason);
  });
});
