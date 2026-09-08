import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { scanDaemon, isolatedPreview } from "../src/processing.ts";
import { buildApp } from "../src/app.ts";
const execute = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "handoff-services-"));
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  const clean = join(directory, "clean.png");
  const image = await sharp({
    create: { width: 320, height: 200, channels: 3, background: "#bada55" },
  })
    .png()
    .toBuffer();
  await writeFile(clean, image);
  assert.equal(
    await scanDaemon(clean),
    true,
    "Clean image must pass live ClamAV",
  );
  const eicar = join(directory, "eicar.txt");
  await writeFile(
    eicar,
    Buffer.from(
      "WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=",
      "base64",
    ),
  );
  assert.equal(
    await scanDaemon(eicar),
    false,
    "EICAR must be blocked by live ClamAV",
  );
  const rendered = await isolatedPreview(image);
  assert.equal(rendered.mime, "image/png");
  assert.notDeepEqual(rendered.preview, image);
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Resources<<>>/Contents 4 0 R>>endobj\n4 0 obj<</Length 23>>stream\n0.5 g 0 0 300 200 re f\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF",
  );
  const pdfPreview = await isolatedPreview(pdf);
  assert.equal(pdfPreview.mime, "application/pdf");
  assert.equal((await sharp(pdfPreview.preview).metadata()).format, "jpeg");
  const movie = await execute(
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      "--memory=512m",
      "--cpus=1",
      "--entrypoint=ffmpeg",
      "handoff-media:local",
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
  const videoPreview = await isolatedPreview(movie.stdout);
  assert.equal(videoPreview.mime, "video/mp4");
  assert.equal(videoPreview.previewMime, "image/gif");
  assert.ok(
    (await sharp(videoPreview.preview, { animated: true }).metadata()).pages! >
      1,
  );
  await execute(
    "zip",
    ["-P", "test-password", join(directory, "encrypted.zip"), "clean.png"],
    { cwd: directory },
  );
  assert.equal(
    await scanDaemon(join(directory, "encrypted.zip")),
    false,
    "Encrypted archives must be quarantined",
  );
  app = await buildApp({
    directory: join(directory, ".sandbox-data"),
    sandbox: true,
    scan: scanDaemon,
    preview: isolatedPreview,
  });
  const origin = "http://localhost:5173";
  async function login(role: string) {
    const res = await app!.inject({
      method: "POST",
      url: "/api/demo/login",
      headers: { origin },
      payload: { role },
    });
    assert.equal(res.statusCode, 200);
    return String(res.headers["set-cookie"]).split(";")[0];
  }
  const creator = await login("creator");
  const client = await login("client");
  const created = await app.inject({
    method: "POST",
    url: "/api/handoffs",
    headers: { origin, cookie: creator },
    payload: {
      title: "Service smoke",
      description: "",
      clientLabel: "Demo",
      amount: "1",
      currency: "USDT",
      terms: "Demo license",
      deadline: new Date(Date.now() + 86400_000).toISOString(),
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().handoff.id;
  const body = Buffer.concat([
    Buffer.from(
      '--test\r\nContent-Disposition: form-data; name="file"; filename="original.png"\r\nContent-Type: image/png\r\n\r\n',
    ),
    image,
    Buffer.from("\r\n--test--\r\n"),
  ]);
  const uploaded = await app.inject({
    method: "POST",
    url: `/api/handoffs/${id}/files`,
    headers: {
      origin,
      cookie: creator,
      "content-type": "multipart/form-data; boundary=test",
    },
    payload: body,
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const file = uploaded.json().handoff.files[0];
  assert.equal(file.scan, "clean");
  for (const [path, payload] of [
    ["approve-previews", { fileIds: [file.id] }],
    ["publish", undefined],
  ] as const) {
    const res = await app.inject({
      method: "POST",
      url: `/api/handoffs/${id}/${path}`,
      headers: { origin, cookie: creator },
      payload,
    });
    assert.equal(res.statusCode, 200, res.body);
  }
  await app.inject({
    method: "POST",
    url: `/api/public/${id}/request-access`,
    headers: { origin, cookie: client },
  });
  const wallet = (
    await app.inject({ url: "/api/session", headers: { cookie: client } })
  ).json().user.address;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/handoffs/${id}/bind-client`,
        headers: { origin, cookie: creator },
        payload: { wallet },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/originals/${id}/${file.id}`,
        headers: { cookie: client },
      })
    ).statusCode,
    403,
  );
  const checkout = await app.inject({
    method: "POST",
    url: `/api/handoffs/${id}/checkout`,
    headers: { origin, cookie: client },
  });
  assert.equal(checkout.statusCode, 200, checkout.body);
  const payment = await app.inject({
    method: "POST",
    url: `/api/demo/pay/${checkout.json().intent.id}`,
    headers: { origin, cookie: client },
  });
  assert.equal(payment.statusCode, 200, payment.body);
  await app.close();
  app = await buildApp({
    directory: join(directory, ".sandbox-data"),
    sandbox: true,
    scan: scanDaemon,
    preview: isolatedPreview,
  });
  await app.ready();
  let paid = false;
  for (let count = 0; count < 100; count++) {
    const receipt = await app.inject({
      url: `/api/receipts/${id}`,
      headers: { cookie: client },
    });
    if (receipt.json().receipt) {
      paid = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(paid, "Restart must recover the simulated payment");
  const download = await app.inject({
    url: `/api/originals/${id}/${file.id}`,
    headers: { cookie: client },
  });
  assert.equal(download.statusCode, 200, download.body);
  assert.deepEqual(download.rawPayload, image);
  console.log(
    "PASS: real ClamAV clean/EICAR/encrypted archive, isolated image/PDF/animated video, full sandbox publication, payment restart recovery, exact original download.",
  );
  await app.close();
  app = undefined;
  const backup = join(directory, "backup");
  const restored = join(directory, "restored");
  await execute(process.execPath, [
    "--import",
    "tsx",
    "src/ops.ts",
    "backup",
    join(directory, ".sandbox-data"),
    backup,
  ]);
  await execute(process.execPath, [
    "--import",
    "tsx",
    "src/ops.ts",
    "restore",
    backup,
    restored,
  ]);
  assert.deepEqual(await readFile(join(restored, "originals", file.id)), image);
  console.log("PASS: backup/restore with original byte integrity.");
} finally {
  if (app) await app.close();
  await rm(directory, { recursive: true, force: true });
}
