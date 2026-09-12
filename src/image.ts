import { Jimp, JimpMime } from "jimp";

/** Inbound attachment size cap for non-images (bytes). Larger non-images are skipped. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/**
 * Inbound image target (bytes). Any image above this is JPEG-re-encoded to
 * fit. Kept small on purpose: the base64 data URI is ~4/3 the raw size, and
 * LLM provider gateways 413 ("request entity too large") on large request
 * bodies — 8MB raw (10.7MB data URI) kept failing downstream even after the
 * 2026-09-11 auto-downscale. 1MB raw → ≤1.37MB data URI, safe under any
 * sane gateway limit.
 */
export const TARGET_IMAGE_BYTES = 1024 * 1024;

/** Never attempt to decode an image above this — Jimp is pure-JS (OOM guard). */
export const MAX_IMAGE_DOWNLOAD_BYTES = 64 * 1024 * 1024;

/**
 * Longest-edge cap + JPEG quality, tried in order until the result fits.
 * 1568px is the vision-model input ceiling (providers downscale anything
 * larger), so the top rung encodes no resolution the model would discard.
 */
const TARGETS = [
  { maxEdge: 1568, quality: 80 },
  { maxEdge: 1200, quality: 70 },
  { maxEdge: 800, quality: 60 },
  { maxEdge: 500, quality: 50 },
];

export interface ShrinkResult {
  data: Buffer;
  mime: string;
  filename: string;
}

/**
 * Downscale + JPEG-re-encode an oversized image until it fits under maxBytes.
 * Returns null when the mime isn't an image, the bytes can't be decoded, or no
 * target gets it under maxBytes — the caller then falls back to skip+warn.
 */
export async function shrinkImage(
  buf: Buffer,
  mime: string,
  filename: string,
  maxBytes: number,
): Promise<ShrinkResult | null> {
  if (!mime.startsWith("image/")) return null;
  const img = await Jimp.read(buf).catch(() => null);
  if (!img) return null;
  for (const t of TARGETS) {
    const copy = img.clone();
    const longest = Math.max(copy.bitmap.width, copy.bitmap.height);
    if (longest > t.maxEdge) copy.scale({ f: t.maxEdge / longest });
    const data = await copy.getBuffer(JimpMime.jpeg, { quality: t.quality });
    if (data.length <= maxBytes) {
      return { data, mime: JimpMime.jpeg, filename: withExt(filename, "jpg") };
    }
  }
  return null;
}

/** Swap the extension for `ext` (no-op-safe: files without one just get it). */
function withExt(filename: string, ext: string): string {
  return `${filename.replace(/\.[^.]+$/, "")}.${ext}`;
}
