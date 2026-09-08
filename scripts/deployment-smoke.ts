import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrivateKey, PublicKey, Signature } from "@nimiq/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import sharp from "sharp";
if (process.env.HANDOFF_DEPLOYMENT_SMOKE !== "temporary-stack")
  throw new Error(
    "Set HANDOFF_DEPLOYMENT_SMOKE=temporary-stack only for temporary validation",
  );
const target = new URL(process.env.HANDOFF_SMOKE_URL ?? "");
const configured = new URL(process.env.HANDOFF_SMOKE_ORIGIN ?? "");
if (
  target.protocol !== "http:" ||
  !["127.0.0.1", "[::1]"].includes(target.hostname) ||
  !target.port ||
  target.pathname !== "/" ||
  target.username ||
  target.password ||
  target.search ||
  target.hash
)
  throw new Error(
    "An explicit HTTP loopback gateway URL with a port is required",
  );
if (
  configured.protocol !== "https:" ||
  !/\.(test|invalid)$/.test(configured.hostname) ||
  configured.pathname !== "/" ||
  configured.username ||
  configured.password ||
  configured.search ||
  configured.hash
)
  throw new Error(
    "Only the temporary stack's HTTPS .test or .invalid origin is allowed",
  );
const origin = target.origin;
const appOrigin = configured.origin;
const run = randomUUID();
const sessions: string[] = [];
async function localFetch(url: string, options: RequestInit = {}) {
  assert.equal(
    new URL(url).origin,
    origin,
    "Smoke requests must stay on the supplied loopback origin",
  );
  return fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
}
function secureCookie(response: Response) {
  const raw = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("handoff_session="));
  assert.ok(raw, "Wallet sign-in must issue a session cookie");
  assert.ok(/;\s*Secure(?:;|$)/i.test(raw), "Session must be Secure");
  assert.ok(/;\s*HttpOnly(?:;|$)/i.test(raw), "Session must be HttpOnly");
  assert.ok(
    /;\s*SameSite=Strict(?:;|$)/i.test(raw),
    "Session must be SameSite=Strict",
  );
  const cookie = raw.split(";")[0];
  sessions.push(cookie);
  return cookie;
}
function eicarArchive() {
  const bytes = Buffer.from(
    "WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=",
    "base64",
  );
  const name = Buffer.from("eicar.txt");
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + bytes.length, 16);
  return Buffer.concat([local, name, bytes, central, name, end]);
}
try {
  const readyResponse = await localFetch(origin + "/api/ready");
  assert.equal(readyResponse.status, 200);
  const ready = await readyResponse.json();
  assert.equal(ready.ok, true);
  for (const key of ["storage", "scanner", "preview", "retention", "payments"])
    assert.equal(ready.checks[key], true, `Readiness failed: ${key}`);
  assert.equal(
    (await localFetch(origin + "/api/ready", { method: "HEAD" })).status,
    200,
  );
  for (const path of [
    "/",
    "/pair",
    "/purchases",
    "/drafts",
    "/requests",
    "/support",
    "/settings",
    "/h/00000000-0000-4000-8000-000000000000",
  ]) {
    const response = await localFetch(origin + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(response.headers.get("cache-control") ?? "", /no-cache/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const html = await response.text();
    assert.match(html, /assets\/index/);
    if (path === "/") {
      const asset = html.match(/(?:src|href)="(\/assets\/[^" ]+\.js)"/)?.[1];
      assert.ok(asset);
      const script = await localFetch(origin + asset);
      assert.equal(script.status, 200);
      assert.match(script.headers.get("cache-control") ?? "", /immutable/);
    }
  }
  const health = await localFetch(origin + "/api/health");
  assert.equal(health.status, 200);
  const capabilities = await health.json();
  assert.equal(capabilities.checkoutEnabled, false);
  assert.equal(capabilities.sandbox, false);
  assert.equal(capabilities.mode, "wallet");
  assert.equal(capabilities.payments.NIM.enabled, false);
  assert.equal(capabilities.payments.USDT.enabled, false);
  assert.equal(
    (await localFetch(origin + `/assets/missing-${run}.js`)).status,
    404,
  );
  assert.equal(
    (
      await localFetch(
        origin +
          "/api/originals/00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000001",
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await localFetch(origin + "/api/handoffs", {
        method: "POST",
        headers: {
          Origin: "https://evil.invalid",
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  async function request(
    path: string,
    cookie = "",
    method = "GET",
    payload?: unknown,
    status = 200,
  ) {
    const response = await localFetch(origin + "/api" + path, {
      method,
      headers: {
        Origin: appOrigin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const data = await response.json();
    assert.equal(
      response.status,
      status,
      `${method} ${path}: ${JSON.stringify(data)}`,
    );
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    return { response, data };
  }
  await request(`/no-such-route-${run}`, "", "GET", undefined, 404);
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = (
    await request("/auth/challenge", "", "POST", { currency: "USDT" })
  ).data;
  const signed = await request("/auth/verify", "", "POST", {
    challengeId: challenge.id,
    currency: "USDT",
    signature: await account.signMessage({ message: challenge.message }),
  });
  const cookie = secureCookie(signed.response);
  assert.equal(
    (await request("/session", cookie)).data.user.address,
    account.address,
  );
  assert.deepEqual((await request("/handoffs", cookie)).data.handoffs, []);

  const nimChallenge = (
    await request("/auth/challenge", "", "POST", { currency: "NIM" })
  ).data;
  const privateKey = new PrivateKey(randomBytes(32));
  const publicKey = PublicKey.derive(privateKey);
  const digest = createHash("sha256")
    .update(
      "\x16Nimiq Signed Message:\n" +
        Buffer.byteLength(nimChallenge.message) +
        nimChallenge.message,
    )
    .digest();
  const nimSigned = await request("/auth/verify", "", "POST", {
    challengeId: nimChallenge.id,
    currency: "NIM",
    publicKey: publicKey.toHex(),
    signature: Signature.create(privateKey, publicKey, digest).toHex(),
  });
  const nimCookie = secureCookie(nimSigned.response);
  assert.equal(
    nimSigned.data.user.address,
    publicKey.toAddress().toUserFriendlyAddress(),
  );

  const draft = {
    title: `Container delivery ${run}`,
    description: "Verified through the frontend API proxy",
    clientLabel: "Private HTTP client",
    amount: "1.123456",
    currency: "USDT",
    terms: "Test delivery terms",
    deadline: new Date(Date.now() + 86400_000).toISOString(),
  };
  const created = (await request("/handoffs", cookie, "POST", draft, 201)).data
    .handoff;
  const id = created.id;
  await request(`/handoffs/${id}`, nimCookie, "GET", undefined, 404);
  await request(`/public/${id}`, "", "GET", undefined, 404);
  const updated = (
    await request(`/handoffs/${id}`, cookie, "PUT", {
      ...draft,
      title: "Updated HTTP delivery",
    })
  ).data.handoff;
  assert.equal(updated.title, "Updated HTTP delivery");
  const original = await sharp({
    create: { width: 320, height: 200, channels: 3, background: "#bada55" },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(original)], { type: "image/png" }),
    "delivery.png",
  );
  const upload = await localFetch(origin + `/api/handoffs/${id}/files`, {
    method: "POST",
    headers: { Origin: appOrigin, Cookie: cookie },
    body: form,
  });
  const uploaded = await upload.json();
  assert.equal(upload.status, 201, JSON.stringify(uploaded));
  const file = uploaded.handoff.files[0];
  assert.equal(file.scan, "clean");
  await request(`/handoffs/${id}/approve-previews`, cookie, "POST", {
    fileIds: [file.id],
  });
  await request(`/handoffs/${id}/publish`, cookie, "POST");
  const shared = (await request(`/public/${id}`)).data.handoff;
  assert.equal(shared.title, updated.title);
  assert.equal(shared.amount, draft.amount);
  assert.equal(shared.checkoutEnabled, false);
  assert.equal(shared.clientLabel, undefined);
  assert.equal(shared.clientWallet, undefined);
  const previewFile = await localFetch(
    origin + `/api/previews/${id}/${file.id}`,
  );
  assert.equal(previewFile.status, 200);
  assert.match(previewFile.headers.get("cache-control") ?? "", /no-store/);
  const previewBytes = Buffer.from(await previewFile.arrayBuffer());
  assert.notDeepEqual(previewBytes, original);
  assert.equal(
    createHash("sha256").update(previewBytes).digest("hex"),
    file.previewSha256,
  );
  assert.equal((await sharp(previewBytes).metadata()).format, "jpeg");
  await request(`/originals/${id}/${file.id}`, "", "GET", undefined, 401);
  await request(`/handoffs/${id}`, cookie, "DELETE", undefined, 409);
  await request(`/originals/${id}/${file.id}`, cookie, "GET", undefined, 403);
  await request(
    `/public/${id}/request-access`,
    nimCookie,
    "POST",
    undefined,
    400,
  );
  const clientAccount = privateKeyToAccount(generatePrivateKey());
  const clientChallenge = (
    await request("/auth/challenge", "", "POST", { currency: "USDT" })
  ).data;
  const clientSigned = await request("/auth/verify", "", "POST", {
    challengeId: clientChallenge.id,
    currency: "USDT",
    signature: await clientAccount.signMessage({
      message: clientChallenge.message,
    }),
  });
  const clientCookie = secureCookie(clientSigned.response);
  await request(`/public/${id}/request-access`, clientCookie, "POST");
  assert.equal(
    (await request(`/public/${id}`, clientCookie)).data.handoff.access
      .requested,
    true,
  );
  assert.ok(
    (await request("/access-requests", cookie)).data.requests.some(
      (entry: { handoffId: string; wallet: string }) =>
        entry.handoffId === id && entry.wallet === clientAccount.address,
    ),
  );
  await request(`/handoffs/${id}/bind-client`, cookie, "POST", {
    wallet: clientAccount.address,
  });
  const assigned = (await request(`/public/${id}`, clientCookie)).data.handoff;
  assert.equal(assigned.access.isApprovedClient, true);
  assert.equal(assigned.access.canCheckout, false);
  assert.equal(assigned.status, "ready");
  await request(
    `/handoffs/${id}/checkout`,
    clientCookie,
    "POST",
    undefined,
    503,
  );
  await request(
    `/originals/${id}/${file.id}`,
    clientCookie,
    "GET",
    undefined,
    403,
  );
  const support = (
    await request(`/support/${id}`, cookie, "POST", {
      kind: "access",
      message: "HTTP support request",
    })
  ).data.ticket;
  assert.equal(
    (await request("/support", cookie)).data.tickets[0].id,
    support.id,
  );
  assert.equal((await request("/support", nimCookie)).data.tickets.length, 0);
  const disposable = (await request("/handoffs", cookie, "POST", draft, 201))
    .data.handoff;
  const blockedForm = new FormData();
  blockedForm.append(
    "file",
    new Blob([new Uint8Array(eicarArchive())], { type: "application/zip" }),
    "eicar-test.zip",
  );
  const blockedResponse = await localFetch(
    origin + `/api/handoffs/${disposable.id}/files`,
    {
      method: "POST",
      headers: { Origin: appOrigin, Cookie: cookie },
      body: blockedForm,
    },
  );
  const blocked = await blockedResponse.json();
  assert.equal(blockedResponse.status, 201, JSON.stringify(blocked));
  assert.equal(
    blocked.handoff.files[0].scan,
    "quarantined",
    "The live scanner must block the harmless standard EICAR test archive",
  );
  await request(
    `/handoffs/${disposable.id}/approve-previews`,
    cookie,
    "POST",
    { fileIds: [blocked.handoff.files[0].id] },
    409,
  );
  await request(
    `/handoffs/${disposable.id}/publish`,
    cookie,
    "POST",
    undefined,
    409,
  );
  await request(`/handoffs/${disposable.id}`, cookie, "DELETE");
  await request(`/handoffs/${disposable.id}`, cookie, "GET", undefined, 404);
  await request(
    `/previews/${disposable.id}/${blocked.handoff.files[0].id}`,
    cookie,
    "GET",
    undefined,
    404,
  );
  assert.deepEqual(
    (await request("/handoffs", cookie)).data.handoffs.map(
      (h: { id: string }) => h.id,
    ),
    [id],
  );
  await request("/logout", cookie, "POST");
  assert.equal((await request("/session", cookie)).data.user, null);
  await request("/handoffs", cookie, "GET", undefined, 401);
  console.log(
    "PASS: production container readiness, SPA/API/cache headers; fresh NIM/EVM signatures and Secure cookies; scanned upload/watermarked sharing; EICAR quarantine; client approval and checkout-off; support privacy; unpaid original denial; draft deletion and logout.",
  );
} finally {
  await Promise.allSettled(
    sessions.map((cookie) =>
      localFetch(origin + "/api/logout", {
        method: "POST",
        headers: { Origin: appOrigin, Cookie: cookie },
      }),
    ),
  );
}
