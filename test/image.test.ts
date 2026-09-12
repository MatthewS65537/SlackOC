import { describe, expect, it } from "vitest";
import { Jimp, JimpMime } from "jimp";
import { MAX_ATTACHMENT_BYTES, TARGET_IMAGE_BYTES, shrinkImage } from "../src/image.js";

/** Build a `w`×`h` noise PNG (worst case for encoders: no spatial correlation). */
async function noisePng(w: number, h: number): Promise<Buffer> {
  const img = new Jimp({ width: w, height: h });
  let s = 7;
  img.scan(0, 0, w, h, (_x, _y, i) => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    img.bitmap.data[i] = s & 0xff;
    img.bitmap.data[i + 1] = (s >> 8) & 0xff;
    img.bitmap.data[i + 2] = (s >> 16) & 0xff;
    img.bitmap.data[i + 3] = 255;
  });
  return img.getBuffer(JimpMime.png);
}

describe("shrinkImage", () => {
  it("returns null for a non-image mime", async () => {
    expect(await shrinkImage(Buffer.from("hello"), "application/pdf", "doc.pdf", MAX_ATTACHMENT_BYTES)).toBeNull();
  });

  it("returns null when the bytes can't be decoded as an image", async () => {
    expect(await shrinkImage(Buffer.from("not really an image"), "image/png", "shot.png", MAX_ATTACHMENT_BYTES)).toBeNull();
  });

  it("shrinks an oversized image to a JPEG under the cap, swapping the extension", async () => {
    const png = await noisePng(400, 300);
    const out = await shrinkImage(png, "image/png", "shot.png", 200_000);
    expect(out).not.toBeNull();
    expect(out!.mime).toBe("image/jpeg");
    expect(out!.filename).toBe("shot.jpg");
    expect(out!.data.length).toBeLessThanOrEqual(200_000);
    // output is a decodable JPEG
    const back = await Jimp.read(out!.data);
    expect(back.bitmap.width).toBeGreaterThan(0);
  });

  it("returns null when no target gets it under the cap", async () => {
    const png = await noisePng(400, 300);
    expect(await shrinkImage(png, "image/png", "shot.png", 100)).toBeNull();
  });

  it("compresses a large worst-case noise image under the 1MB provider target", async () => {
    // 3000x2000 noise = worst case for JPEG (no spatial correlation). Must land
    // under TARGET_IMAGE_BYTES so the data URI stays safe for provider gateways.
    const png = await noisePng(3000, 2000);
    expect(png.length).toBeGreaterThan(TARGET_IMAGE_BYTES);
    const out = await shrinkImage(png, "image/png", "wall.png", TARGET_IMAGE_BYTES);
    expect(out).not.toBeNull();
    expect(out!.data.length).toBeLessThanOrEqual(TARGET_IMAGE_BYTES);
    const back = await Jimp.read(out!.data);
    expect(back.bitmap.width).toBeGreaterThan(0);
  });

  it("appends .jpg to a filename that has no extension", async () => {
    const png = await noisePng(400, 300);
    const out = await shrinkImage(png, "image/png", "screenshot", 200_000);
    expect(out!.filename).toBe("screenshot.jpg");
  });
});
