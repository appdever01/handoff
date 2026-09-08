import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { PrivateKey, PublicKey, Signature } from "@nimiq/core";
import { privateKeyToAccount } from "viem/accounts";
import sharp from "sharp";
import { buildApp } from "../src/app.ts";
import { scanDaemon, isolatedPreview } from "../src/processing.ts";
const { preview } =
  await import("../../frontend/node_modules/vite/dist/node/index.js");
const directory = await mkdtemp(join(tmpdir(), "handoff-http-"));
const appOrigin = "http://localhost:5173";
const app = await buildApp({
  directory,
  origin: appOrigin,
  scan: scanDaemon,
  preview: isolatedPreview,
});
let site: Awaited<ReturnType<typeof preview>> | undefined;
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const backend = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  site = await preview({
    configFile: false,
    root: resolve("../frontend"),
    preview: { host: "127.0.0.1", port: 0, proxy: { "/api": backend } },
  });
  const origin = `http://127.0.0.1:${(site.httpServer.address() as AddressInfo).port}`;
  for (const path of [
    "/",
    "/pair",
    "/purchases",
    "/drafts",
    "/requests",
    "/support",
    "/wallet",
    "/h/00000000-0000-4000-8000-000000000000",
  ]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await response.text(), /assets\/index/);
  }
  const health = await fetch(origin + "/api/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).checkoutEnabled, false);
  assert.equal(
    (
      await fetch(
        origin +
          "/api/originals/00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000001",
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(origin + "/api/handoffs", {
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
    const response = await fetch(origin + "/api" + path, {
      method,
      headers: {
        Origin: appOrigin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return { response, data };
  }
  const account = privateKeyToAccount(
    ("0x" + "04".repeat(32)) as `0x${string}`,
  );
  const challenge = (
    await request("/auth/challenge", "", "POST", { currency: "USDT" })
  ).data;
  const signed = await request("/auth/verify", "", "POST", {
    challengeId: challenge.id,
    currency: "USDT",
    signature: await account.signMessage({ message: challenge.message }),
  });
  const cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
  assert.match(signed.response.headers.get("set-cookie")!, /HttpOnly/);
  assert.equal(
    (await request("/session", cookie)).data.user.address,
    account.address,
  );
  assert.deepEqual((await request("/handoffs", cookie)).data.handoffs, []);

  const nimChallenge = (
    await request("/auth/challenge", "", "POST", { currency: "NIM" })
  ).data;
  const privateKey = new PrivateKey(Buffer.alloc(32, 5));
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
  const nimCookie = nimSigned.response.headers.get("set-cookie")!.split(";")[0];
  assert.equal(
    nimSigned.data.user.address,
    publicKey.toAddress().toUserFriendlyAddress(),
  );

  const draft = {
    title: "HTTP delivery",
    description: "Verified through the frontend API proxy",
    clientLabel: "Private HTTP client",
    amount: "1.25",
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
  const upload = await fetch(origin + `/api/handoffs/${id}/files`, {
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
  assert.equal(shared.clientLabel, undefined);
  assert.equal(shared.clientWallet, undefined);
  const previewFile = await fetch(origin + `/api/previews/${id}/${file.id}`);
  assert.equal(previewFile.status, 200);
  assert.notDeepEqual(Buffer.from(await previewFile.arrayBuffer()), original);
  await request(`/originals/${id}/${file.id}`, cookie, "GET", undefined, 403);
  await request(
    `/public/${id}/request-access`,
    nimCookie,
    "POST",
    undefined,
    400,
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
  await request(`/handoffs/${disposable.id}`, cookie, "DELETE");
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
    "PASS: SPA routes and API proxy; real NIM/EVM signatures; draft create/edit/delete; scanned upload and watermarked sharing; support privacy; unpaid original denial; logout and origin enforcement.",
  );
} finally {
  if (site)
    await new Promise<void>((resolve, reject) =>
      site!.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
