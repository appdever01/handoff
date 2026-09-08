import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../src/app.ts";
import { openStore } from "../src/store.ts";
import { hash } from "../src/auth.ts";

test("pairing requires phone approval and browser secret; scoped sessions revoke and cannot replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "handoff-pair-"));
  const origin = "http://localhost:5173";
  const app = await buildApp({ directory, origin });
  const store = openStore(directory);
  store.db
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(
      hash("phone-token"),
      JSON.stringify({ address: "wallet", currency: "NIM" }),
      Date.now() + 60000,
    );
  const phone = "handoff_session=phone-token";
  try {
    const started = await app.inject({
      method: "POST",
      url: "/api/pairings",
      headers: { origin },
      payload: { role: "download" },
    });
    const pair = started.json();
    const cookie = String(started.headers["set-cookie"]).split(";")[0];
    assert.equal(pair.secret, undefined);
    assert.ok(!pair.url.includes("token"));
    const redeem = (c = cookie) =>
      app.inject({
        method: "POST",
        url: `/api/pairings/${pair.id}/redeem`,
        headers: { origin, cookie: c },
      });
    assert.equal((await redeem()).statusCode, 409);
    assert.equal(
      (await app.inject({ url: `/api/pairings/${pair.id}` })).statusCode,
      401,
    );
    const approve = (phrase: string) =>
      app.inject({
        method: "POST",
        url: `/api/pairings/${pair.id}/approve`,
        headers: { origin, cookie: phone },
        payload: { phrase },
      });
    assert.equal((await approve("wrong")).statusCode, 409);
    assert.equal((await approve(pair.phrase)).statusCode, 200);
    assert.equal((await redeem("handoff_pairing=stolen-id")).statusCode, 409);
    const response = await redeem();
    assert.equal(response.statusCode, 200);
    const device = (response.headers["set-cookie"] as string[])
      .find((v) => v.startsWith("handoff_session="))!
      .split(";")[0];
    assert.equal((await redeem()).statusCode, 409);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/handoffs",
          headers: { origin, cookie: device },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: "/api/purchases", headers: { cookie: device } }))
        .statusCode,
      200,
    );
    const devices = (
      await app.inject({ url: "/api/devices", headers: { cookie: phone } })
    ).json().devices;
    await app.inject({
      method: "DELETE",
      url: `/api/devices/${devices[0].id}`,
      headers: { origin, cookie: phone },
    });
    assert.equal(
      (await app.inject({ url: "/api/purchases", headers: { cookie: device } }))
        .statusCode,
      401,
    );
    store.db.prepare("UPDATE pairings SET redeemed=0,expires=0").run();
    assert.equal((await redeem()).statusCode, 409);
  } finally {
    await app.close();
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sandbox data cannot be reopened as wallet-authorized storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "handoff-mode-"));
  const sandboxDirectory = join(directory, ".sandbox-data");
  try {
    const app = await buildApp({ directory: sandboxDirectory, sandbox: true });
    await app.close();
    await assert.rejects(
      buildApp({ directory: sandboxDirectory }),
      /cannot be interchanged/,
    );
    await assert.rejects(
      buildApp({ directory: join(directory, "wallet"), sandbox: true }),
      /Sandbox requires/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
