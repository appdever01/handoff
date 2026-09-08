import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../src/store.ts";
import {
  payments,
  units,
  type ChainEvidence,
  type PaymentAdapter,
} from "../src/payments.ts";
import { hash } from "../src/auth.ts";
import type {
  Handoff,
  PaymentIntent,
  Session,
} from "../packages/contracts/index.ts";
import { retain } from "../src/retention.ts";

const payer = "client";
const recipient = "creator";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "handoff-payments-"));
  const store = openStore(directory);
  const app = Fastify();
  const fileId = randomUUID();
  const bytes = Buffer.from("private purchased content");
  await mkdir(join(directory, "originals"));
  await writeFile(join(directory, "originals", fileId), bytes);
  const handoff: Handoff = {
    id: randomUUID(),
    title: "Delivery",
    description: "",
    clientLabel: "Private",
    terms: "License",
    amount: "10.000001",
    currency: "USDT",
    creator: recipient,
    clientWallet: payer,
    status: "ready",
    deadline: new Date(Date.now() + 86400_000).toISOString(),
    createdAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
    manifestHash: "immutable",
    files: [
      {
        id: fileId,
        name: "original.txt",
        bytes: bytes.length,
        mime: "text/plain",
        sha256: hash(bytes),
        previewSha256: "preview",
        scan: "clean",
        approved: true,
      },
    ],
  };
  store.save(handoff);
  let evidence: ChainEvidence[] = [];
  const adapter: PaymentAdapter = {
    network: "test",
    token: "test-token",
    prepare: async () => ({ startBlock: 100, reference: "7" }),
    find: async () => evidence,
  };
  const service = payments(
    app,
    store,
    directory,
    (req) =>
      ({
        address: String(req.headers.wallet ?? payer),
        currency: "USDT",
      }) as Session,
    { USDT: adapter },
  );
  await app.ready();
  const checkout = () =>
    app.inject({ method: "POST", url: `/api/handoffs/${handoff.id}/checkout` });
  const intent = (await checkout()).json().intent as PaymentIntent;
  const valid: ChainEvidence = {
    transaction: "tx1",
    blockHash: "canonical",
    block: 101,
    timestamp: Date.now(),
    payer,
    recipient,
    units: intent.units,
    reference: intent.reference,
    network: "test",
    token: "test-token",
    success: true,
    finalized: true,
  };
  return {
    directory,
    store,
    app,
    handoff,
    fileId,
    bytes,
    intent,
    valid,
    service,
    checkout,
    evidence: (e: ChainEvidence[]) => {
      evidence = e;
    },
    close: async () => {
      await app.close();
      store.db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("atomic amounts preserve precision", () => {
  assert.equal(units("999999999.999999", 6), "999999999999999");
  assert.equal(units("0.00001", 5), "1");
});
test("checkout is immutable, client-bound and cannot be unlocked by browser success", async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.checkout()).json().intent, f.intent);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/handoffs/${f.handoff.id}/checkout`,
          headers: { wallet: "intruder" },
          payload: { paid: true },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await f.app.inject(`/api/originals/${f.handoff.id}/${f.fileId}`))
        .statusCode,
      403,
    );
    const other = { ...f.handoff, id: randomUUID() };
    f.store.save(other);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/handoffs/${other.id}/checkout`,
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});
test("wrong payer, recipient, amount, chain, token, reference, finality, success and timing never unlock", async () => {
  const f = await fixture();
  try {
    const changes: Partial<ChainEvidence>[] = [
      { payer: "wrong" },
      { recipient: "wrong" },
      { units: "1" },
      { network: "wrong" },
      { token: "wrong" },
      { reference: "8" },
      { finalized: false },
      { success: false },
      { block: 99 },
      { timestamp: f.intent.expiresAt + 1 },
      { timestamp: f.intent.createdAt - 61000 },
    ];
    for (const change of changes) {
      f.evidence([{ ...f.valid, ...change }]);
      await f.service.reconcile();
      assert.equal(
        f.service.getReceipt(f.handoff.id),
        undefined,
        JSON.stringify(change),
      );
    }
    f.evidence([f.valid, { ...f.valid, transaction: "second" }]);
    await f.service.reconcile();
    assert.equal(f.service.getReceipt(f.handoff.id), undefined);
  } finally {
    await f.close();
  }
});
test("recovery without browser hash grants exactly once and permits only bound-wallet intact downloads", async () => {
  const f = await fixture();
  try {
    f.evidence([f.valid]);
    await Promise.all([f.service.reconcile(), f.service.reconcile()]);
    await f.service.reconcile();
    assert.equal(
      (
        f.store.db.prepare("SELECT count(*) n FROM entitlements").get() as {
          n: number;
        }
      ).n,
      1,
    );
    const download = await f.app.inject(
      `/api/originals/${f.handoff.id}/${f.fileId}`,
    );
    assert.equal(download.statusCode, 200);
    assert.deepEqual(download.rawPayload, f.bytes);
    assert.match(
      String(download.headers["content-disposition"]),
      /^attachment/,
    );
    assert.equal(
      (
        await f.app.inject({
          url: `/api/originals/${f.handoff.id}/${f.fileId}`,
          headers: { wallet: recipient },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await f.app.inject("/api/purchases")).json().purchases.length,
      1,
    );
    const second = { ...f.handoff, id: randomUUID() };
    f.store.save(second);
    const secondIntent = {
      ...f.intent,
      id: randomUUID(),
      handoff: second.id,
      reference: "8",
    };
    f.store.db
      .prepare("INSERT INTO intents VALUES(?,?,?,?,?,?)")
      .run(
        secondIntent.id,
        second.id,
        payer,
        secondIntent.network,
        "8",
        JSON.stringify(secondIntent),
      );
    f.evidence([{ ...f.valid, reference: "8" }]);
    await f.service.reconcile();
    assert.equal(f.service.getReceipt(second.id), undefined);

    assert.equal(
      (await f.app.inject(`/api/receipts/${f.handoff.id}`)).json().events
        .length,
      1,
    );
    await writeFile(join(f.directory, "originals", f.fileId), "tampered");
    assert.equal(
      (await f.app.inject(`/api/originals/${f.handoff.id}/${f.fileId}`))
        .statusCode,
      503,
    );
  } finally {
    await f.close();
  }
});
test("restart recovers pending intent and retention deletes expired bytes", async () => {
  const f = await fixture();
  try {
    await f.app.close();
    const restarted = Fastify();
    const service = payments(
      restarted,
      f.store,
      f.directory,
      () => ({ address: payer, currency: "USDT" }),
      {
        USDT: {
          network: "test",
          token: "test-token",
          prepare: async () => {
            throw Error("Must reuse intent");
          },
          find: async () => [f.valid],
        },
      },
    );
    await service.reconcile();
    assert.ok(service.getReceipt(f.handoff.id));
    await retain(f.store, f.directory, Date.now() + 31 * 86400_000);
    assert.equal(
      (
        f.store.db.prepare("SELECT count(*) n FROM deletions").get() as {
          n: number;
        }
      ).n,
      1,
    );
    await assert.rejects(
      import("node:fs/promises").then((fs) =>
        fs.readFile(join(f.directory, "originals", f.fileId)),
      ),
    );
    await restarted.close();
  } finally {
    f.store.db.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
