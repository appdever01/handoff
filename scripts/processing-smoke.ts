import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { buildProcessingService } from "../src/processing-service.ts";
import {
  createRemotePreview,
  checkPreviewWorker,
} from "../src/processing-client.ts";
import { mediaImage } from "../src/processing.ts";

const execute = promisify(execFile);
const secret = randomBytes(32).toString("hex");
const worker = await buildProcessingService({ secret });
try {
  const url = await worker.listen({ host: "127.0.0.1", port: 0 });
  const configuration = { url, secret };
  assert.equal(
    await checkPreviewWorker(configuration),
    true,
    "The private worker must be able to inspect its configured media image",
  );
  for (const authorization of [
    undefined,
    `Bearer ${randomBytes(32).toString("hex")}`,
  ]) {
    const response = await fetch(`${url}/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: "private original",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 401);
    await response.body?.cancel();
  }
  const preview = createRemotePreview(configuration);
  const image = await sharp({
    create: { width: 320, height: 200, channels: 3, background: "#5f9d91" },
  })
    .png()
    .toBuffer();
  const rendered = await preview(image);
  assert.equal(rendered.mime, "image/png");
  assert.equal(rendered.previewMime, "image/jpeg");
  assert.equal((await sharp(rendered.preview).metadata()).format, "jpeg");
  assert.notDeepEqual(rendered.preview, image);
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Resources<<>>/Contents 4 0 R>>endobj\n4 0 obj<</Length 23>>stream\n0.5 g 0 0 300 200 re f\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF",
  );
  const pdfPreview = await preview(pdf);
  assert.equal(pdfPreview.mime, "application/pdf");
  assert.equal((await sharp(pdfPreview.preview).metadata()).format, "jpeg");
  const movie = await execute(
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      "--read-only",
      "--user=1000:1000",
      "--memory=512m",
      "--cpus=1",
      "--pids-limit=64",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--entrypoint=ffmpeg",
      mediaImage(),
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:r=8",
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-movflags",
      "frag_keyframe+empty_moov",
      "-f",
      "mp4",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 5_000_000, timeout: 30_000 },
  );
  const video = await preview(movie.stdout);
  assert.equal(video.mime, "video/mp4");
  assert.equal(video.previewMime, "image/gif");
  assert.ok(
    (await sharp(video.preview, { animated: true }).metadata()).pages! > 1,
  );
  console.log(
    "PASS: authenticated private HTTP worker, rejected missing/wrong secrets, configured image readiness, isolated image/PDF/animated-video previews, no API Docker access required.",
  );
} finally {
  await worker.close();
}
