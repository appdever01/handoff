import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrivateKey, PublicKey, Signature } from "@nimiq/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

function httpsOrigin(value: string | undefined, name: string) {
  assert.ok(value, `Set ${name} to the intended HTTPS origin`);
  const url = new URL(value);
  assert.ok(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    `${name} must be an HTTPS origin without credentials or paths`,
  );
  return url.origin;
}
const apiOrigin = httpsOrigin(
  process.env.RAILWAY_SMOKE_API_ORIGIN,
  "RAILWAY_SMOKE_API_ORIGIN",
);
const appOrigin = httpsOrigin(
  process.env.RAILWAY_SMOKE_APP_ORIGIN,
  "RAILWAY_SMOKE_APP_ORIGIN",
);
const cookies: string[] = [];
const drafts: { id: string; cookie: string }[] = [];

async function request(
  path: string,
  options: {
    cookie?: string;
    method?: string;
    body?: unknown;
    status?: number;
    origin?: string;
  } = {},
) {
  const multipart = options.body instanceof FormData;
  const response = await fetch(`${apiOrigin}/api${path}`, {
    method: options.method ?? "GET",
    headers: {
      Origin: options.origin ?? appOrigin,
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.body !== undefined && !multipart
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body: multipart
      ? (options.body as FormData)
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(90_000),
  });
  if (options.status !== undefined)
    assert.equal(
      response.status,
      options.status,
      `${options.method ?? "GET"} ${path}: unexpected HTTP status`,
    );
  return response;
}
async function json(path: string, options: Parameters<typeof request>[1] = {}) {
  const response = await request(path, { status: 200, ...options });
  return { response, data: await response.json() };
}
function retainCookie(response: Response) {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("handoff_session="));
  assert.ok(
    cookie &&
      /HttpOnly/i.test(cookie) &&
      /Secure/i.test(cookie) &&
      /SameSite=Strict/i.test(cookie),
    "Wallet authentication must set a secure private session cookie",
  );
  const pair = cookie.split(";")[0];
  cookies.push(pair);
  return pair;
}
function zipFixture(content: Buffer) {
  const name = Buffer.from("eicar.txt");
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + content.length, 16);
  return Buffer.concat([local, name, content, central, name, end]);
}
function fileBody(bytes: Buffer, name: string, type: string) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type }), name);
  return form;
}
function pdfFixture() {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[4 0 R 6 0 R 8 0 R]/Count 3>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  for (let page = 0; page < 3; page++) {
    const content = `0.2 0.4 0.3 rg 0 0 300 200 re f BT /F1 20 Tf 1 1 1 rg 20 90 Td (Handoff smoke page ${page + 1}) Tj ET`;
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Resources<</Font<</F1 3 0 R>>>>/Contents ${5 + page * 2} 0 R>>`,
    );
    objects.push(
      `<</Length ${Buffer.byteLength(content)}>>\nstream\n${content}\nendstream`,
    );
  }
  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  document += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}
async function mediaFixtures() {
  const image = sharp({
    create: { width: 320, height: 240, channels: 3, background: "#638766" },
  });
  const items = [
    {
      name: "smoke.png",
      mime: "image/png",
      bytes: await image.clone().png().toBuffer(),
    },
    {
      name: "smoke.jpg",
      mime: "image/jpeg",
      bytes: await image.clone().jpeg().toBuffer(),
    },
    {
      name: "smoke.webp",
      mime: "image/webp",
      bytes: await image.clone().webp().toBuffer(),
    },
    { name: "smoke.pdf", mime: "application/pdf", bytes: pdfFixture() },
  ];
  if (process.env.RAILWAY_SMOKE_VIDEO_FILE) {
    const bytes = await readFile(process.env.RAILWAY_SMOKE_VIDEO_FILE);
    assert.ok(
      bytes.length > 0 &&
        bytes.length <= 15 * 1024 * 1024 &&
        bytes.subarray(4, 8).toString() === "ftyp",
      "Video fixture must be a small synthetic MP4",
    );
    items.push({ name: "smoke.mp4", mime: "video/mp4", bytes });
  }
  return items;
}
let complete = false;
try {
  const health = (await json("/health")).data;
  assert.equal(
    health.checkoutEnabled,
    false,
    "Run this smoke only against a checkout-disabled preview deployment",
  );
  assert.equal(
    health.sandbox,
    false,
    "Public deployment must not permit simulated identities",
  );
  const readiness = await request("/ready", { status: 200 });
  assert.equal(
    (await readiness.json()).ok,
    true,
    "Storage, scanner and preview readiness must pass",
  );
  await request("/handoffs", {
    method: "POST",
    origin: "https://untrusted.invalid",
    body: {},
    status: 403,
  });

  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = (
    await json("/auth/challenge", {
      method: "POST",
      body: { currency: "USDT" },
    })
  ).data;
  const verified = await json("/auth/verify", {
    method: "POST",
    body: {
      currency: "USDT",
      challengeId: challenge.id,
      signature: await account.signMessage({ message: challenge.message }),
    },
  });
  const cookie = retainCookie(verified.response);
  assert.equal(verified.data.user.address, account.address);
  assert.equal(
    (await json("/session", { cookie })).data.user.address,
    account.address,
  );

  const nimChallenge = (
    await json("/auth/challenge", { method: "POST", body: { currency: "NIM" } })
  ).data;
  const key = new PrivateKey(randomBytes(32));
  const publicKey = PublicKey.derive(key);
  const digest = createHash("sha256")
    .update(
      "\x16Nimiq Signed Message:\n" +
        Buffer.byteLength(nimChallenge.message) +
        nimChallenge.message,
    )
    .digest();
  const nim = await json("/auth/verify", {
    method: "POST",
    body: {
      currency: "NIM",
      challengeId: nimChallenge.id,
      publicKey: publicKey.toHex(),
      signature: Signature.create(key, publicKey, digest).toHex(),
    },
  });
  const nimCookie = retainCookie(nim.response);
  assert.equal(
    nim.data.user.address,
    publicKey.toAddress().toUserFriendlyAddress(),
  );

  const created = (
    await json("/handoffs", {
      cookie,
      method: "POST",
      status: 201,
      body: {
        title: `Disposable deployment smoke ${randomUUID()}`,
        description: "Temporary automated deployment check; never published.",
        clientLabel: "Generated test identity",
        currency: "USDT",
        amount: "1.000001",
        terms: "Test-only draft. No payment.",
        deadline: new Date(Date.now() + 86400_000).toISOString(),
      },
    })
  ).data.handoff;
  drafts.push({ id: created.id, cookie });
  await request(`/public/${created.id}`, { status: 404 });
  await request(`/handoffs/${created.id}`, { cookie: nimCookie, status: 404 });
  const uploadedIds: string[] = [];
  const retained: { id: string; sha256: string; previewSha256: string }[] = [];
  const restartMode = process.env.RAILWAY_SMOKE_RESTART === "1";
  const allFixtures = await mediaFixtures();
  const fixtures = restartMode ? allFixtures.slice(0, 1) : allFixtures;
  for (const fixture of fixtures) {
    const uploaded = (
      await json(`/handoffs/${created.id}/files`, {
        cookie,
        method: "POST",
        status: 201,
        body: fileBody(fixture.bytes, fixture.name, fixture.mime),
      })
    ).data.handoff;
    const file = uploaded.files.find(
      (item: { name: string }) => item.name === fixture.name,
    );
    assert.equal(
      file.scan,
      "clean",
      `${fixture.mime} must pass the real scanner`,
    );
    assert.equal(
      file.mime,
      fixture.mime,
      "Original media type must match the fixture",
    );
    assert.ok(file.previewSha256, "Watermarked preview hash required");
    assert.equal(
      file.sha256,
      createHash("sha256").update(fixture.bytes).digest("hex"),
    );
    uploadedIds.push(file.id);
    retained.push({
      id: file.id,
      sha256: file.sha256,
      previewSha256: file.previewSha256,
    });
    const preview = await request(`/previews/${created.id}/${file.id}`, {
      cookie,
      status: 200,
    });
    const bytes = Buffer.from(await preview.arrayBuffer());
    assert.ok(bytes.length > 0 && bytes.length <= 5_000_000);
    assert.notDeepEqual(
      bytes,
      fixture.bytes,
      "Preview must not expose the original bytes",
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      file.previewSha256,
    );
    assert.equal(
      preview.headers.get("content-type")?.split(";")[0],
      file.previewMime,
    );
    const metadata = await sharp(bytes, { animated: true }).metadata();
    if (fixture.mime === "video/mp4") {
      assert.equal(file.previewMime, "image/gif");
      assert.ok(
        (metadata.pages ?? 1) > 1,
        "MP4 preview must contain more than one animated frame",
      );
    } else {
      assert.equal(file.previewMime, "image/jpeg");
      assert.equal(metadata.format, "jpeg");
    }
    await request(`/previews/${created.id}/${file.id}`, { status: 404 });
    await request(`/originals/${created.id}/${file.id}`, {
      cookie,
      status: 403,
    });
    await request(`/originals/${created.id}/${file.id}`, { status: 401 });
    console.log(
      `PASS: ${fixture.mime} scanned upload, separate private preview and unpaid-original denial.`,
    );
  }
  if (!restartMode && !process.env.RAILWAY_SMOKE_VIDEO_FILE)
    console.log(
      "NOT RUN: MP4 preview. Set RAILWAY_SMOKE_VIDEO_FILE to a small synthetic MP4 fixture.",
    );

  if (restartMode) {
    const input = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      await input.question(
        "WAITING FOR BACKEND RESTART: private PNG draft and sessions are saved. Restart the Railway API, wait for readiness, then send Enter to verify persistence.\n",
        { signal: AbortSignal.timeout(600_000) },
      );
    } finally {
      input.close();
      process.stdin.pause();
    }
    const ready = await json("/ready");
    assert.equal(ready.data.ok, true);
    assert.equal(
      (await json("/session", { cookie })).data.user?.address,
      account.address,
      "Wallet session must survive ordinary restart",
    );
    assert.equal(
      (await json("/session", { cookie: nimCookie })).data.user?.address,
      publicKey.toAddress().toUserFriendlyAddress(),
    );
    const restored = (await json(`/handoffs/${created.id}`, { cookie })).data
      .handoff;
    for (const expected of retained) {
      const actual = restored.files.find(
        (item: { id: string }) => item.id === expected.id,
      );
      assert.ok(actual, "Uploaded file record must survive restart");
      assert.equal(
        actual.sha256,
        expected.sha256,
        "Original hash must be unchanged after restart",
      );
      assert.equal(actual.previewSha256, expected.previewSha256);
      const response = await request(`/previews/${created.id}/${expected.id}`, {
        cookie,
        status: 200,
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        expected.previewSha256,
        "Preview bytes must survive restart unchanged",
      );
      await request(`/originals/${created.id}/${expected.id}`, {
        cookie,
        status: 403,
      });
    }
    console.log(
      "PASS: actual backend restart retained NIM/EVM sessions, private draft, original hashes and exact preview bytes; unpaid originals remain blocked.",
    );
  }

  const eicar = Buffer.from(
    "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
  );
  const rejected = await request(`/handoffs/${created.id}/files`, {
    cookie,
    method: "POST",
    body: fileBody(zipFixture(eicar), "eicar-test.zip", "application/zip"),
  });
  assert.ok(
    [201, 400, 409].includes(rejected.status),
    "EICAR upload must be quarantined or rejected",
  );
  if (rejected.status === 201) {
    const infected = (await rejected.json()).handoff.files.find(
      (item: { name: string }) => item.name === "eicar-test.zip",
    );
    assert.equal(infected.scan, "quarantined");
    assert.equal(infected.approved, false);
    await request(`/handoffs/${created.id}/approve-previews`, {
      cookie,
      method: "POST",
      body: { fileIds: [...uploadedIds, infected.id] },
      status: 409,
    });
  }
  await request(`/handoffs/${created.id}/checkout`, {
    cookie,
    method: "POST",
    status: 403,
  });
  await request(`/handoffs/${created.id}`, {
    cookie,
    method: "DELETE",
    status: 200,
  });
  drafts.length = 0;
  await request(`/handoffs/${created.id}`, { cookie, status: 404 });
  assert.deepEqual((await json("/handoffs", { cookie })).data.handoffs, []);
  for (const session of cookies) {
    await request("/logout", { cookie: session, method: "POST", status: 200 });
    assert.equal((await json("/session", { cookie: session })).data.user, null);
  }
  complete = true;
  console.log(
    "PASS: HTTPS preview readiness, NIM/EVM signatures, secure sessions, clean upload, private watermarked preview, EICAR rejection, unpaid-original denial, draft cleanup and logout. Nothing published; no payments sent.",
  );
} finally {
  const cleanupErrors: string[] = [];
  for (const draft of drafts) {
    try {
      await request(`/handoffs/${draft.id}`, {
        cookie: draft.cookie,
        method: "DELETE",
        status: 200,
      });
    } catch {
      cleanupErrors.push(draft.id);
    }
  }
  if (!complete)
    for (const cookie of cookies)
      await request("/logout", { cookie, method: "POST" }).catch(() => {});
  if (cleanupErrors.length)
    throw new Error(
      `Manual deletion required for disposable drafts: ${cleanupErrors.join(", ")}`,
    );
}
