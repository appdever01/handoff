import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.ts";
import { openStore } from "../src/store.ts";
import { hash } from "../src/auth.ts";
import type { Handoff, Session } from "../packages/contracts/index.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "handoff-workspace-"));
  const app = await buildApp({
    directory,
    payments: {
      USDT: {
        network: "test",
        token: "test-token",
        prepare: async () => ({ startBlock: 1, reference: "1" }),
        find: async () => [],
      },
    },
  });
  await app.ready();
  const store = openStore(directory);
  const users: Record<string, Session> = {
    creator: { address: "creator", currency: "USDT" },
    client: { address: "client", currency: "USDT" },
    stranger: { address: "stranger", currency: "USDT" },
    wrongCurrency: { address: "client", currency: "NIM" },
    desktop: { address: "creator", currency: "USDT", scope: "upload" },
    downloader: { address: "client", currency: "USDT", scope: "download" },
  };
  for (const [token, user] of Object.entries(users))
    store.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(hash(token), JSON.stringify(user), Date.now() + 60000);
  const handoff: Handoff = {
    id: randomUUID(),
    creator: "creator",
    clientWallet: null,
    title: "Real delivery",
    description: "Final files",
    clientLabel: "Private name",
    amount: "10",
    currency: "USDT",
    terms: "License",
    status: "awaiting-client",
    deadline: new Date(Date.now() + 86400_000).toISOString(),
    createdAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
    manifestHash: "frozen",
    files: [],
  };
  store.save(handoff);
  const request = (
    url: string,
    token?: string,
    method: "GET" | "POST" | "DELETE" = "GET",
    payload?: object,
  ) =>
    app.inject({
      url: `/api${url}`,
      method,
      headers: {
        origin: "http://localhost:5173",
        ...(token ? { cookie: `handoff_session=${token}` } : {}),
      },
      ...(payload ? { payload } : {}),
    });
  return {
    store,
    directory,
    handoff,
    request,
    close: async () => {
      await app.close();
      store.db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("capabilities describe configured currencies and paired sessions can inspect them", async () => {
  const f = await fixture();
  try {
    const health = (await f.request("/health", "desktop")).json();
    assert.equal(health.mode, "wallet");
    assert.deepEqual(health.currencies, ["USDT"]);
    assert.equal(health.payments.USDT.enabled, true);
    assert.equal(health.payments.NIM.enabled, false);
    assert.match(health.payments.NIM.reason, /history RPC/);
  } finally {
    await f.close();
  }
});

test("access requests are private and checkout eligibility follows the approved wallet", async () => {
  const f = await fixture();
  try {
    const path = `/public/${f.handoff.id}`;
    const anonymous = (await f.request(path)).json().handoff;
    assert.equal(anonymous.clientWallet, undefined);
    assert.equal(anonymous.clientLabel, undefined);
    assert.equal(anonymous.access.canCheckout, false);
    assert.equal((await f.request("/access-requests")).statusCode, 401);
    assert.equal(
      (await f.request(`${path}/request-access`, "client", "POST")).statusCode,
      200,
    );
    assert.equal(
      (await f.request(path, "client")).json().handoff.access.requested,
      true,
    );
    assert.deepEqual(
      (await f.request("/access-requests", "stranger")).json().requests,
      [],
    );
    assert.deepEqual(
      (await f.request("/access-requests", "desktop")).json().requests,
      [{ handoffId: f.handoff.id, title: f.handoff.title, wallet: "client" }],
    );
    assert.equal(
      (
        await f.request(
          `/handoffs/${f.handoff.id}/bind-client`,
          "desktop",
          "POST",
          { wallet: "client" },
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.request(
          `/handoffs/${f.handoff.id}/bind-client`,
          "creator",
          "POST",
          { wallet: "client" },
        )
      ).statusCode,
      200,
    );
    assert.deepEqual(
      (await f.request("/access-requests", "creator")).json().requests,
      [],
    );
    assert.equal(
      (await f.request(path, "client")).json().handoff.access.canCheckout,
      true,
    );
    for (const user of ["wrongCurrency", "stranger", "creator", "downloader"])
      assert.equal(
        (await f.request(path, user)).json().handoff.access.canCheckout,
        false,
      );
    const checkout = await f.request(
      `/handoffs/${f.handoff.id}/checkout`,
      "client",
      "POST",
    );
    assert.equal(checkout.statusCode, 200);
    async function status(expected: string) {
      assert.equal(
        (await f.request("/handoffs", "creator")).json().handoffs[0].status,
        expected,
      );
      assert.equal(
        (await f.request(`/handoffs/${f.handoff.id}`, "creator")).json().handoff
          .status,
        expected,
      );
      assert.equal(
        (await f.request(path, "client")).json().handoff.status,
        expected,
      );
    }
    await status("payment-pending");
    assert.equal(
      (await f.request(path, "client")).json().handoff.access.canCheckout,
      true,
    );
    f.store.db.prepare("INSERT INTO entitlements VALUES(?,?,?,?)").run(
      f.handoff.id,
      "client",
      "test:verified",
      JSON.stringify({
        currency: "USDT",
        handoff: f.handoff.id,
        expiresAt: Date.now() + 86400_000,
      }),
    );
    await status("paid");
    assert.equal(
      (await f.request(path, "client")).json().handoff.access.canCheckout,
      false,
    );
    assert.equal(
      (await f.request(`/receipts/${f.handoff.id}`, "desktop")).statusCode,
      200,
    );
    assert.equal(
      (await f.request(`/receipts/${f.handoff.id}`, "wrongCurrency"))
        .statusCode,
      404,
    );
    assert.deepEqual(
      (await f.request("/purchases", "wrongCurrency")).json().purchases,
      [],
    );
  } finally {
    await f.close();
  }
});

test("support history is persisted and private to its submitting wallet", async () => {
  const f = await fixture();
  try {
    f.store.save({ ...f.handoff, status: "ready", clientWallet: "client" });
    const created = await f.request(
      `/support/${f.handoff.id}`,
      "downloader",
      "POST",
      { kind: "access", message: "Please help recover my file" },
    );
    assert.equal(created.statusCode, 200);
    const ticket = created.json().ticket;
    assert.deepEqual((await f.request("/support", "client")).json().tickets, [
      { ...ticket, handoffId: f.handoff.id, title: f.handoff.title },
    ]);
    assert.deepEqual(
      (await f.request(`/support/${f.handoff.id}`, "client")).json().tickets,
      [ticket],
    );
    assert.deepEqual(
      (await f.request(`/support/${f.handoff.id}`, "creator")).json().tickets,
      [],
    );
    assert.deepEqual(
      (await f.request("/support", "stranger")).json().tickets,
      [],
    );
    assert.equal((await f.request("/support")).statusCode, 401);
    assert.equal(
      (await f.request(`/support/${f.handoff.id}`, "wrongCurrency")).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test("draft deletion removes private bytes and refuses other owners and published deliveries", async () => {
  const f = await fixture();
  try {
    const fileId = randomUUID();
    await mkdir(join(f.directory, "originals"));
    await mkdir(join(f.directory, "previews"));
    await writeFile(join(f.directory, "originals", fileId), "private");
    await writeFile(join(f.directory, "previews", `${fileId}.jpg`), "preview");
    const draft: Handoff = {
      ...f.handoff,
      id: randomUUID(),
      status: "draft",
      publishedAt: null,
      manifestHash: null,
      files: [
        {
          id: fileId,
          name: "original.png",
          bytes: 7,
          mime: "image/png",
          sha256: hash("private"),
          previewSha256: hash("preview"),
          scan: "clean",
          approved: false,
        },
      ],
    };
    f.store.save(draft);
    assert.equal(
      (await f.request(`/handoffs/${draft.id}`, "stranger", "DELETE"))
        .statusCode,
      404,
    );
    assert.equal(
      (await f.request(`/handoffs/${f.handoff.id}`, "creator", "DELETE"))
        .statusCode,
      409,
    );
    assert.equal(
      (await f.request(`/handoffs/${draft.id}`, "creator", "DELETE"))
        .statusCode,
      200,
    );
    assert.equal(
      (await f.request(`/handoffs/${draft.id}`, "creator")).statusCode,
      404,
    );
    assert.equal(
      (await f.request(`/previews/${draft.id}/${fileId}`, "creator"))
        .statusCode,
      404,
    );
    await assert.rejects(readFile(join(f.directory, "originals", fileId)));
    await assert.rejects(
      readFile(join(f.directory, "previews", `${fileId}.jpg`)),
    );
  } finally {
    await f.close();
  }
});
