/**
 * Locally generated MPEG-1 Layer III silence: 128 kbit/s, 32 kHz, mono.
 * Each complete 576-byte frame represents 1,152 samples. Zero side information
 * has no reservoir dependency or encoded spectral values; no ID3/Xing data or
 * private recordings are used. The native/Chromium gates must actually decode
 * it: a valid-looking signature alone is not format compatibility evidence.
 * Header layout/frame sizing cross-checked against the primary decoder source:
 * https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/mpegaudiodecheader.c
 */
export function syntheticSilentMp3(): Buffer {
  const frameBytes = 576;
  const frameCount = 112;
  const bytes = Buffer.alloc(frameBytes * frameCount);
  for (let frame = 0; frame < frameCount; frame++) bytes.writeUInt32BE(0xfffb98c0, frame * frameBytes);
  return bytes;
}
