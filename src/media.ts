import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

sharp.concurrency(2);
sharp.cache({ memory: 32, files: 0, items: 20 });
const execute = promisify(execFile);
export const scanFile = async (path: string): Promise<boolean> => {
  try {
    await execute("clamscan", ["--no-summary", path], {
      timeout: 30_000,
      maxBuffer: 4096,
    });
    return true;
  } catch {
    return false;
  }
};

export async function createPreview(
  bytes: Buffer,
): Promise<{ preview: Buffer; previewMime: string; mime: string }> {
  const input = sharp(bytes, {
    limitInputPixels: 24_000_000,
    failOn: "warning",
    animated: false,
  });
  const metadata = await input.metadata();
  if (
    !["jpeg", "png", "webp"].includes(metadata.format ?? "") ||
    (metadata.pages ?? 1) > 1
  )
    throw new Error("Use a still JPEG, PNG or WebP image");
  const resized = await input
    .rotate()
    .resize({
      width: 1400,
      height: 1400,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 75 })
    .toBuffer({ resolveWithObject: true });
  const { width, height } = resized.info;
  const font = Math.max(12, Math.min(38, Math.floor(width / 12)));
  const watermark = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="mark" width="${font * 9}" height="${font * 4}" patternUnits="userSpaceOnUse" patternTransform="rotate(-25)"><text x="8" y="${font * 2}" font-family="sans-serif" font-weight="700" font-size="${font}" fill="white" stroke="black" stroke-width="0.5" paint-order="stroke" opacity="0.6">HANDOFF • PREVIEW</text></pattern></defs><rect width="100%" height="100%" fill="url(#mark)"/><rect y="${Math.max(0, height - font * 2)}" width="100%" height="${font * 2}" fill="black" opacity="0.5"/><text x="${width / 2}" y="${height - font / 2}" text-anchor="middle" font-family="sans-serif" font-size="${font}" fill="white">HANDOFF PREVIEW</text></svg>`,
  );
  const preview = await sharp(resized.data)
    .composite([{ input: watermark }])
    .jpeg({ quality: 78 })
    .toBuffer();
  return {
    preview,
    previewMime: "image/jpeg",
    mime:
      metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`,
  };
}

export function sourceType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 4).toString() === "8BPS")
    return "image/vnd.adobe.photoshop";
  if (bytes.subarray(0, 7).toString() === "BLENDER")
    return "application/x-blender";
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
    return "application/zip";
}
export async function sourcePlaceholder() {
  return sharp({
    create: { width: 800, height: 500, channels: 3, background: "#e7e7e7" },
  })
    .jpeg()
    .toBuffer();
}
