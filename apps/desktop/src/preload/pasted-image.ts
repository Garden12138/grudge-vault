import { AppError } from "@grudge-vault/shared";

export async function readPastedImage(
  file: { size: number; stream(): ReturnType<File["stream"]> }, signal: AbortSignal
): Promise<Uint8Array> {
  if (signal.aborted) throw signal.reason;
  const reader = file.stream().getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const bytes = new Uint8Array(file.size);
    let byteSize = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      if (byteSize + value.byteLength > bytes.byteLength) {
        await reader.cancel();
        throw new AppError("SOURCE_UNAVAILABLE", "粘贴图片在读取时发生变化，请重新粘贴。", true);
      }
      bytes.set(value, byteSize);
      byteSize += value.byteLength;
    }
    if (byteSize !== file.size) throw new AppError("SOURCE_UNAVAILABLE", "粘贴图片在读取时发生变化，请重新粘贴。", true);
    return bytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
