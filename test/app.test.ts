import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { privateKeyToAccount } from "viem/accounts";
import { PrivateKey, PublicKey, Signature } from "@nimiq/core";
import { buildApp } from "../src/app.ts";
import { verifyProof } from "../src/auth.ts";
import { openStore } from "../src/store.ts";

const origin = "http://localhost:5173";
const account = privateKeyToAccount(("0x" + "01".repeat(32)) as `0x${string}`);
const other = privateKeyToAccount(("0x" + "02".repeat(32)) as `0x${string}`);
let directory: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
const input = {
  title: "Identity delivery",
  description: "Final identity",
  clientLabel: "Private client label",
  amount: "250.01",
  currency: "USDT",
  deadline: new Date(Date.now() + 7 * 86400_000).toISOString(),
  terms: "Agreed commercial license.",
};
async function signIn(who = account) {
  const challenge = (
    await app.inject({
      method: "POST",
      url: "/api/auth/challenge",
      headers: { origin },
      payload: { currency: "USDT" },
    })
  ).json();
  const signature = await who.signMessage({ message: challenge.message });
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/verify",
    headers: { origin },
    payload: { currency: "USDT", challengeId: challenge.id, signature },
  });
  assert.equal(response.statusCode, 200, response.body);
  return {
    cookie: String(response.headers["set-cookie"]).split(";")[0],
    challenge,
    signature,
    response,
  };
}
async function create() {
  const response = await app.inject({
    method: "POST",
    url: "/api/handoffs",
    headers: { origin, cookie },
    payload: input,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().handoff;
}
async function upload(id: string, bytes?: Buffer) {
  const image =
    bytes ??
    (await sharp({
      create: { width: 200, height: 150, channels: 3, background: "#c3cf9e" },
    })
      .png()
      .toBuffer());
  const boundary = "handoff-test-boundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../../logo.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return {
    response: await app.inject({
      method: "POST",
      url: `/api/handoffs/${id}/files`,
      headers: {
        origin,
        cookie,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    }),
    image,
  };
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "handoff-test-"));
  app = await buildApp({ directory, origin, scan: async () => true });
  cookie = (await signIn()).cookie;
});
after(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

test("health is reachable and live checkout is disabled", async () => {
  const response = await app.inject("/api/health");
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().checkoutEnabled, false);
});
test("wallet challenge proves ownership, is single use, and sets an HttpOnly cookie", async () => {
  const result = await signIn();
  assert.match(String(result.response.headers["set-cookie"]), /HttpOnly/);
  assert.match(
    String(result.response.headers["set-cookie"]),
    /SameSite=Strict/i,
  );
  assert.equal(result.response.json().user.address, account.address);
  const replay = await app.inject({
    method: "POST",
    url: "/api/auth/verify",
    headers: { origin },
    payload: {
      currency: "USDT",
      challengeId: result.challenge.id,
      signature: result.signature,
    },
  });
  assert.equal(replay.statusCode, 401);
});
test("NIM verifies a prefixed signature and rejects a changed challenge", async () => {
  const privateKey = new PrivateKey(Buffer.alloc(32, 3));
  const publicKey = PublicKey.derive(privateKey);
  const message = "Handoff wallet sign-in\nNonce: abc123";
  const digest = createHash("sha256")
    .update(
      "\x16Nimiq Signed Message:\n" + Buffer.byteLength(message) + message,
    )
    .digest();
  const proof = {
    currency: "NIM" as const,
    challengeId: "irrelevant",
    publicKey: publicKey.toHex(),
    signature: Signature.create(privateKey, publicKey, digest).toHex(),
  };
  assert.equal(
    (await verifyProof(message, proof)).address,
    publicKey.toAddress().toUserFriendlyAddress(),
  );
  await assert.rejects(verifyProof(message + "changed", proof));
});
test("unauthenticated and cross-origin requests cannot create handoffs", async () => {
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/handoffs",
        headers: { origin },
        payload: input,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/handoffs",
        headers: { origin: "https://evil.example", cookie },
        payload: input,
      })
    ).statusCode,
    403,
  );
  assert.equal((await app.inject("/api/handoffs")).statusCode, 401);
});
test("the payout currency must match the proven wallet and amounts/deadlines are bounded", async () => {
  for (const patch of [
    { currency: "NIM" },
    { amount: "0" },
    { amount: "1e8" },
    { amount: "3.1234567" },
    { deadline: "2020-01-01T00:00:00.000Z" },
    { deadline: new Date(Date.now() + 31 * 86400_000).toISOString() },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/handoffs",
      headers: { origin, cookie },
      payload: { ...input, ...patch },
    });
    assert.equal(response.statusCode, 400, response.body);
  }
});
test("another wallet cannot read or modify a private draft", async () => {
  const draft = await create();
  const stranger = await signIn(other);
  assert.equal(
    (
      await app.inject({
        url: `/api/handoffs/${draft.id}`,
        headers: { cookie: stranger.cookie },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `/api/handoffs/${draft.id}`,
        headers: { cookie: stranger.cookie, origin },
        payload: input,
      })
    ).statusCode,
    404,
  );
  assert.equal((await app.inject(`/api/public/${draft.id}`)).statusCode, 404);
});
test("invalid or disguised files cannot be uploaded", async () => {
  const draft = await create();
  const { response } = await upload(
    draft.id,
    Buffer.from("<script>alert(1)</script>"),
  );
  assert.equal(response.statusCode, 400);
});
test("real private image upload creates a separate watermarked JPEG and protects both endpoints", async () => {
  const draft = await create();
  const { response, image } = await upload(draft.id);
  assert.equal(response.statusCode, 201, response.body);
  const file = response.json().handoff.files[0];
  assert.equal(file.name.includes("/"), false);
  assert.equal(file.sha256, createHash("sha256").update(image).digest("hex"));
  assert.equal(
    (await app.inject(`/api/previews/${draft.id}/${file.id}`)).statusCode,
    404,
  );
  const preview = await app.inject({
    url: `/api/previews/${draft.id}/${file.id}`,
    headers: { cookie },
  });
  assert.equal(preview.statusCode, 200);
  assert.match(String(preview.headers["content-type"]), /image\/jpeg/);
  assert.notDeepEqual(preview.rawPayload, image);
  const plain = await sharp(image).jpeg({ quality: 75 }).toBuffer();
  assert.notDeepEqual(preview.rawPayload, plain);
  assert.deepEqual(
    await readFile(join(directory, "originals", file.id)),
    image,
  );
  assert.equal(
    (await app.inject(`/api/originals/${draft.id}/${file.id}`)).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/originals/${draft.id}/${file.id}`,
        headers: { cookie },
      })
    ).statusCode,
    403,
  );
});
test("publication needs explicit preview approval, freezes edits and excludes private client data", async () => {
  const draft = await create();
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/handoffs/${draft.id}/publish`,
        headers: { origin, cookie },
      })
    ).statusCode,
    409,
  );
  const { response } = await upload(draft.id);
  const fileId = response.json().handoff.files[0].id;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/handoffs/${draft.id}/publish`,
        headers: { origin, cookie },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/handoffs/${draft.id}/approve-previews`,
        headers: { origin, cookie },
        payload: { fileIds: [fileId] },
      })
    ).statusCode,
    200,
  );
  const published = await app.inject({
    method: "POST",
    url: `/api/handoffs/${draft.id}/publish`,
    headers: { origin, cookie },
  });
  assert.equal(published.statusCode, 200);
  assert.match(published.json().handoff.manifestHash, /^[a-f0-9]{64}$/);
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `/api/handoffs/${draft.id}`,
        headers: { origin, cookie },
        payload: { ...input, amount: "1" },
      })
    ).statusCode,
    409,
  );
  assert.equal((await upload(draft.id)).response.statusCode, 409);
  const publicView = (await app.inject(`/api/public/${draft.id}`)).json()
    .handoff;
  assert.equal(publicView.clientLabel, undefined);
  assert.equal(publicView.clientWallet, undefined);
  assert.equal(publicView.checkoutEnabled, false);
  assert.equal(
    (await app.inject(`/api/previews/${draft.id}/${fileId}`)).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/handoffs/${draft.id}/checkout`,
        headers: { origin, cookie },
        payload: { paid: true, hash: "fake" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/originals/${draft.id}/${fileId}`,
        headers: { cookie },
      })
    ).statusCode,
    403,
  );
  const stranger = await signIn(other);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/public/${draft.id}/request-access`,
        headers: { origin, cookie: stranger.cookie },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/handoffs/${draft.id}/bind-client`,
        headers: { origin, cookie },
        payload: { wallet: other.address },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/handoffs/${draft.id}/bind-client`,
        headers: { origin, cookie },
        payload: { wallet: account.address },
      })
    ).statusCode,
    409,
  );
});
test("concurrent uploads retain both files and draft removal revokes preview access", async () => {
  const draft = await create();
  const responses = await Promise.all([upload(draft.id), upload(draft.id)]);
  for (const result of responses)
    assert.equal(result.response.statusCode, 201, result.response.body);
  const handoff = (
    await app.inject({ url: `/api/handoffs/${draft.id}`, headers: { cookie } })
  ).json().handoff;
  assert.equal(handoff.files.length, 2);
  const fileId = handoff.files[0].id;
  const deleted = await app.inject({
    method: "DELETE",
    url: `/api/handoffs/${draft.id}/files/${fileId}`,
    headers: { origin, cookie },
  });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().handoff.files.length, 1);
  assert.equal(
    (
      await app.inject({
        url: `/api/previews/${draft.id}/${fileId}`,
        headers: { cookie },
      })
    ).statusCode,
    404,
  );
  await assert.rejects(readFile(join(directory, "originals", fileId)));
});
test("upload size limits reject oversized bodies before processing", async () => {
  const draft = await create();
  assert.equal(
    (await upload(draft.id, Buffer.alloc(15 * 1024 * 1024 + 1))).response
      .statusCode,
    413,
  );
});
test("scanner failure quarantines files and prevents approval or publication", async () => {
  const isolatedDirectory = await mkdtemp(
    join(tmpdir(), "handoff-quarantine-"),
  );
  let scanClean = false;
  const isolated = await buildApp({
    directory: isolatedDirectory,
    origin,
    scan: async () => scanClean,
  });
  try {
    const challenge = (
      await isolated.inject({
        method: "POST",
        url: "/api/auth/challenge",
        headers: { origin },
        payload: { currency: "USDT" },
      })
    ).json();
    const signed = await isolated.inject({
      method: "POST",
      url: "/api/auth/verify",
      headers: { origin },
      payload: {
        currency: "USDT",
        challengeId: challenge.id,
        signature: await account.signMessage({ message: challenge.message }),
      },
    });
    const isolatedCookie = String(signed.headers["set-cookie"]).split(";")[0];
    const draft = (
      await isolated.inject({
        method: "POST",
        url: "/api/handoffs",
        headers: { origin, cookie: isolatedCookie },
        payload: input,
      })
    ).json().handoff;
    const image = await sharp({
      create: { width: 40, height: 40, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const payload = Buffer.concat([
      Buffer.from(
        '--boundary\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n',
      ),
      image,
      Buffer.from("\r\n--boundary--\r\n"),
    ]);
    const uploaded = await isolated.inject({
      method: "POST",
      url: `/api/handoffs/${draft.id}/files`,
      headers: {
        origin,
        cookie: isolatedCookie,
        "content-type": "multipart/form-data; boundary=boundary",
      },
      payload,
    });
    const file = uploaded.json().handoff.files[0];
    assert.equal(file.scan, "quarantined");
    assert.equal(
      (
        await isolated.inject({
          method: "POST",
          url: `/api/handoffs/${draft.id}/approve-previews`,
          headers: { origin, cookie: isolatedCookie },
          payload: { fileIds: [file.id] },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await isolated.inject({
          method: "POST",
          url: `/api/handoffs/${draft.id}/publish`,
          headers: { origin, cookie: isolatedCookie },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await isolated.inject(`/api/previews/${draft.id}/${file.id}`))
        .statusCode,
      404,
    );
    scanClean = true;
    const rescanned = await isolated.inject({
      method: "POST",
      url: `/api/handoffs/${draft.id}/files/${file.id}/rescan`,
      headers: { origin, cookie: isolatedCookie },
    });
    assert.equal(rescanned.statusCode, 200);
    assert.equal(rescanned.json().handoff.files[0].scan, "clean");
    assert.equal(rescanned.json().handoff.files[0].approved, false);
  } finally {
    await isolated.close();
    await rm(isolatedDirectory, { recursive: true, force: true });
  }
});
test("expired sign-in challenge is rejected", async () => {
  const challenge = (
    await app.inject({
      method: "POST",
      url: "/api/auth/challenge",
      headers: { origin },
      payload: { currency: "USDT" },
    })
  ).json();
  const store = openStore(directory);
  store.db
    .prepare("UPDATE challenges SET expires=0 WHERE id=?")
    .run(challenge.id);
  store.db.close();
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        headers: { origin },
        payload: {
          currency: "USDT",
          challengeId: challenge.id,
          signature: await account.signMessage({ message: challenge.message }),
        },
      })
    ).statusCode,
    401,
  );
});
test("restart preserves drafts and sessions; logout revokes the session", async () => {
  const draft = await create();
  const auth = await signIn();
  await app.close();
  app = await buildApp({ directory, origin, scan: async () => true });
  assert.equal(
    (
      await app.inject({
        url: `/api/handoffs/${draft.id}`,
        headers: { cookie: auth.cookie },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/logout",
        headers: { origin, cookie: auth.cookie },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/handoffs",
        headers: { cookie: auth.cookie },
      })
    ).statusCode,
    401,
  );
});

test("editable originals cannot publish until a scanned supplied preview is approved", async () => {
  cookie = (await signIn()).cookie;
  const draft = await create();
  const uploaded = await upload(
    draft.id,
    Buffer.from("BLENDER-v300editable-source"),
  );
  assert.equal(uploaded.response.statusCode, 201, uploaded.response.body);
  const file = uploaded.response.json().handoff.files[0];
  assert.equal(file.suppliedPreviewRequired, true);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/handoffs/${draft.id}/approve-previews`,
        headers: { origin, cookie },
        payload: { fileIds: [file.id] },
      })
    ).statusCode,
    409,
  );
  const png = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  const payload = Buffer.concat([
    Buffer.from(
      '--preview\r\nContent-Disposition: form-data; name="file"; filename="preview.png"\r\nContent-Type: image/png\r\n\r\n',
    ),
    png,
    Buffer.from("\r\n--preview--\r\n"),
  ]);
  const supplied = await app.inject({
    method: "POST",
    url: `/api/handoffs/${draft.id}/files/${file.id}/preview`,
    headers: {
      origin,
      cookie,
      "content-type": "multipart/form-data; boundary=preview",
    },
    payload,
  });
  assert.equal(supplied.statusCode, 200, supplied.body);
  assert.equal(supplied.json().handoff.files[0].suppliedPreviewRequired, false);
  assert.equal(supplied.json().handoff.files[0].approved, false);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/handoffs/${draft.id}/approve-previews`,
        headers: { origin, cookie },
        payload: { fileIds: [file.id] },
      })
    ).statusCode,
    200,
  );
});
