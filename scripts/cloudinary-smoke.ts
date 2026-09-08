import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import {
  cloudinaryConfiguration,
  cloudinaryStatus,
  createCloudinaryPreview,
} from "../src/cloudinary.ts";

function pdfFixture() {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R 5 0 R 7 0 R 9 0 R]/Count 4>>",
  ];
  for (let page = 0; page < 4; page++) {
    const stream = `${0.2 + page * 0.2} g 0 0 300 200 re f\n`;
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Resources<<>>/Contents ${4 + page * 2} 0 R>>`,
      `<</Length ${Buffer.byteLength(stream)}>>\nstream\n${stream}endstream`,
    );
  }
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(body);
}

try {
  const config = cloudinaryConfiguration();
  assert.equal(
    await cloudinaryStatus(config),
    true,
    "Cloudinary authentication and cleanup readiness failed",
  );
  const preview = createCloudinaryPreview(config);
  const outputDirectory = process.env.CLOUDINARY_SMOKE_OUTPUT_DIR;
  if (outputDirectory)
    await mkdir(resolve(outputDirectory), { recursive: true, mode: 0o700 });
  const base = await sharp({
    create: { width: 640, height: 400, channels: 3, background: "#568c7e" },
  })
    .png()
    .toBuffer();
  const fixtures = [
    { name: "png", mime: "image/png", bytes: base },
    {
      name: "jpeg",
      mime: "image/jpeg",
      bytes: await sharp(base).jpeg().toBuffer(),
    },
    {
      name: "webp",
      mime: "image/webp",
      bytes: await sharp(base).webp().toBuffer(),
    },
    { name: "pdf", mime: "application/pdf", bytes: pdfFixture() },
  ];
  if (process.env.CLOUDINARY_SMOKE_MP4_FILE) {
    fixtures.push({
      name: "mp4",
      mime: "video/mp4",
      bytes: await readFile(resolve(process.env.CLOUDINARY_SMOKE_MP4_FILE)),
    });
  }
  for (const fixture of fixtures) {
    const result = await preview(fixture.bytes);
    assert.equal(result.mime, fixture.mime);
    assert.equal(
      result.previewMime,
      fixture.name === "mp4" ? "image/gif" : "image/jpeg",
    );
    assert.notDeepEqual(result.preview, fixture.bytes);
    const metadata = await sharp(result.preview, {
      animated: fixture.name === "mp4",
    }).metadata();
    assert.equal(metadata.format, fixture.name === "mp4" ? "gif" : "jpeg");
    if (fixture.name === "pdf") {
      assert.equal(metadata.width, 2100);
      assert.equal(metadata.height, 900);
    }
    if (fixture.name === "mp4") {
      assert.ok(
        (metadata.pages ?? 0) > 1,
        "Use a moving MP4 fixture to verify animation",
      );
      assert.ok((metadata.pages ?? 0) <= 48);
      assert.ok(
        (metadata.delay?.reduce((sum, delay) => sum + delay, 0) ?? Infinity) <=
          12_000,
      );
    }
    if (outputDirectory)
      await writeFile(
        join(
          resolve(outputDirectory),
          `${fixture.name}.${fixture.name === "mp4" ? "gif" : "jpg"}`,
        ),
        result.preview,
        { mode: 0o600 },
      );
    assert.equal(
      (await readdir(config.cleanupDirectory)).filter(
        (name) =>
          name.startsWith(`${config.cloudName}-`) && name.endsWith(".json"),
      ).length,
      0,
      "Temporary Cloudinary assets still require cleanup",
    );
    console.log(
      `PASS: ${fixture.name} authenticated preview and confirmed temporary-asset cleanup`,
    );
  }
  assert.equal(await cloudinaryStatus(config), true);
  if (!process.env.CLOUDINARY_SMOKE_MP4_FILE)
    console.log(
      "SKIP: MP4 live check requires CLOUDINARY_SMOKE_MP4_FILE pointing to a synthetic moving video.",
    );
} catch {
  console.error(
    "FAIL: Cloudinary live preview check failed. Credentials and provider responses are intentionally omitted; inspect readiness and private cleanup records.",
  );
  process.exitCode = 1;
}
