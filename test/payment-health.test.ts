import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../src/store.ts";
import {
  payments,
  type PaymentAdapter,
  type ChainEvidence,
} from "../src/payments.ts";

async function fixture(adapter?: PaymentAdapter) {
  const directory = await mkdtemp(join(tmpdir(), "handoff-payment-health-"));
  const store = openStore(directory);
  const app = Fastify();
  const service = payments(
    app,
    store,
    directory,
    () => ({ address: "client", currency: "NIM" }),
    adapter ? { NIM: adapter } : {},
  );
  const handoff = randomUUID();
  const intent = {
    id: randomUUID(),
    handoff,
    currency: "NIM",
    payer: "client",
    network: "test",
    token: "native",
    reference: "reference",
  };
  store.db
    .prepare("INSERT INTO intents VALUES(?,?,?,?,?,?)")
    .run(
      intent.id,
      handoff,
      intent.payer,
      intent.network,
      intent.reference,
      JSON.stringify(intent),
    );
  return {
    service,
    store,
    handoff,
    close: async () => {
      await app.close();
      store.db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("payment health remains failed until an in-flight retry completes successfully", async () => {
  let fail = true;
  let release: (value: ChainEvidence[]) => void = () => {};
  const pending = new Promise<ChainEvidence[]>((resolve) => {
    release = resolve;
  });
  const adapter: PaymentAdapter = {
    network: "test",
    token: "native",
    prepare: async () => ({ startBlock: 1, reference: "reference" }),
    find: async () => {
      if (fail) throw new Error("RPC unavailable");
      return pending;
    },
  };
  const f = await fixture(adapter);
  try {
    assert.equal(f.service.healthy(), false);
    await f.service.reconcile();
    assert.equal(f.service.healthy(), false);
    fail = false;
    const retry = f.service.reconcile();
    assert.equal(f.service.healthy(), false);
    release([]);
    await retry;
    assert.equal(f.service.healthy(), true);
  } finally {
    release([]);
    await f.close();
  }
});

test("pending intents without matching adapters fail readiness until retired", async () => {
  for (const adapter of [
    undefined,
    {
      network: "wrong-network",
      token: "native",
      prepare: async () => ({ startBlock: 1, reference: "reference" }),
      find: async () => [],
    },
  ]) {
    const f = await fixture(adapter);
    try {
      await f.service.reconcile();
      assert.equal(f.service.healthy(), false);
      f.store.db
        .prepare("INSERT INTO deletions VALUES(?,?)")
        .run(f.handoff, Date.now());
      await f.service.reconcile();
      assert.equal(f.service.healthy(), true);
    } finally {
      await f.close();
    }
  }
});
