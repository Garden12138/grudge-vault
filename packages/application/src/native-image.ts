import { AppError } from "@grudge-vault/shared";
import type { NativeImageConversionPort } from "./redesign";

export const NATIVE_IMAGE_COPY_NOTICE = "HEIC 本机转换副本：保留完整尺寸并应用照片方向，移除照片元数据；JPEG 副本可能有编码差异，请核对原件。";

export function needsNativeImageConversion(mimeType: string): boolean {
  return mimeType === "image/heic" || mimeType === "image/heif";
}

export async function prepareNativeImage(
  input: { mimeType: string; bytes: Uint8Array }, converter?: NativeImageConversionPort, signal?: AbortSignal
): Promise<{ mimeType: string; bytes: Uint8Array; converted: boolean }> {
  signal?.throwIfAborted();
  if (!needsNativeImageConversion(input.mimeType)) return { ...input, converted: false };
  if (!converter) throw new AppError("MODALITY_UNAVAILABLE", "当前环境没有私有 HEIC 转换能力，请保留原件并改用兼容格式。", true);
  if (!input.bytes.length || input.bytes.length > 20 * 1024 * 1024) {
    throw new AppError("MODALITY_UNAVAILABLE", "HEIC 超过当前图片转换输入上限。", true);
  }
  const result = await converter.convert(input, signal);
  signal?.throwIfAborted();
  if (!["image/png", "image/jpeg"].includes(result.mimeType) || !(result.bytes instanceof Uint8Array) ||
    !result.bytes.length || result.bytes.length > 7_000_000 || !Number.isSafeInteger(result.width) ||
    !Number.isSafeInteger(result.height) || result.width <= 0 || result.height <= 0 || result.width * result.height > 50_000_000) {
    throw new AppError("MEDIA_PROCESSING_FAILED", "图片转换副本的格式、尺寸或大小核对失败。", true);
  }
  return { mimeType: result.mimeType, bytes: result.bytes, converted: true };
}
