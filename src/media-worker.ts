import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { createPreview } from "./media.ts";
const execute = promisify(execFile);
const chunks: Buffer[] = [];
let length = 0;
for await (const chunk of process.stdin) {
  length += chunk.length;
  if (length > 16 * 1024 * 1024) throw new Error("File too large");
  chunks.push(chunk);
}
const bytes = Buffer.concat(chunks);
let image = bytes;
let mime: string | undefined;
await writeFile("/tmp/input", bytes);
if (bytes.subarray(0, 5).toString() === "%PDF-") {
  await execute(
    "pdftoppm",
    [
      "-f",
      "1",
      "-l",
      "3",
      "-scale-to",
      "1400",
      "-png",
      "/tmp/input",
      "/tmp/page",
    ],
    { timeout: 20_000, maxBuffer: 4096 },
  );
  const { readdir } = await import("node:fs/promises");
  const pages = (await readdir("/tmp"))
    .filter((name) => /^page-\d+\.png$/.test(name))
    .sort();
  const previews = await Promise.all(
    pages.map(async (name) =>
      sharp(await readFile(`/tmp/${name}`))
        .resize({
          width: 700,
          height: 900,
          fit: "contain",
          background: "white",
        })
        .png()
        .toBuffer(),
    ),
  );
  image = await sharp({
    create: {
      width: 700 * previews.length,
      height: 900,
      channels: 3,
      background: "white",
    },
  })
    .composite(
      previews.map((input, index) => ({ input, left: 700 * index, top: 0 })),
    )
    .png()
    .toBuffer();
  mime = "application/pdf";
} else if (bytes.subarray(4, 8).toString() === "ftyp") {
  const mark =
    "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='HANDOFF PREVIEW':fontcolor=white@0.75:borderw=1:bordercolor=black@0.6:fontsize=22:x=(w-tw)/2";
  await execute(
    "ffmpeg",
    [
      "-v",
      "error",
      "-threads",
      "1",
      "-i",
      "/tmp/input",
      "-t",
      "12",
      "-an",
      "-vf",
      `fps=4,scale=640:480:force_original_aspect_ratio=decrease,${mark}:y=h*0.2,${mark}:y=h*0.5,${mark}:y=h*0.8`,
      "-threads",
      "1",
      "-loop",
      "0",
      "/tmp/preview.gif",
    ],
    { timeout: 25_000, maxBuffer: 4096 },
  );
  const preview = await readFile("/tmp/preview.gif");
  if (preview.length > 5_000_000)
    throw new Error("Video preview exceeds size limit");
  process.stdout.write(
    JSON.stringify({
      preview: preview.toString("base64"),
      mime: "video/mp4",
      previewMime: "image/gif",
    }),
  );
  process.exit(0);
}
const result = await createPreview(image);
process.stdout.write(
  JSON.stringify({
    preview: result.preview.toString("base64"),
    mime: mime ?? result.mime,
    previewMime: "image/jpeg",
  }),
);
