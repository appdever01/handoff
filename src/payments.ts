import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "./store.ts";
import { hash } from "./auth.ts";
import type {
  Session,
  PaymentIntent,
  Receipt,
  SupportTicket,
} from "../packages/contracts/index.ts";

export type ChainEvidence = {
  transaction: string;
  blockHash: string;
  block: number;
  timestamp: number;
  payer: string;
  recipient: string;
  units: string;
  network: string;
  token: string;
  reference: string;
  finalized: boolean;
  success: boolean;
};
export type PaymentAdapter = {
  network: string;
  token: string;
  prepare(payer: string): Promise<{ startBlock: number; reference: string }>;
  find(intent: PaymentIntent): Promise<ChainEvidence[]>;
};
function fail(code: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode: code });
}
export const units = (amount: string, decimals: number) => {
  const [whole, fraction = ""] = amount.split(".");
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"))
  ).toString();
};

export function payments(
  app: FastifyInstance,
  store: Store,
  directory: string,
  session: (req: FastifyRequest) => Session,
  adapters: Partial<Record<"NIM" | "USDT", PaymentAdapter>> = {},
) {
  store.db
    .exec(`CREATE TABLE IF NOT EXISTS deletions (handoff TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, handoff TEXT NOT NULL UNIQUE, payer TEXT NOT NULL, network TEXT NOT NULL, reference TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(network,payer,reference));
    CREATE TABLE IF NOT EXISTS entitlements (handoff TEXT PRIMARY KEY, wallet TEXT NOT NULL, transaction_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS access_events (id TEXT PRIMARY KEY, handoff TEXT NOT NULL, wallet TEXT NOT NULL, file TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS support (id TEXT PRIMARY KEY, handoff TEXT NOT NULL, wallet TEXT NOT NULL, data TEXT NOT NULL);`);
  const getIntent = (id: string): PaymentIntent | undefined => {
    const row = store.db
      .prepare("SELECT data FROM intents WHERE handoff=?")
      .get(id) as { data: string } | undefined;
    return row && JSON.parse(row.data);
  };
  const getReceipt = (id: string): Receipt | undefined => {
    const row = store.db
      .prepare("SELECT data FROM entitlements WHERE handoff=?")
      .get(id) as { data: string } | undefined;
    return row && JSON.parse(row.data);
  };
  const idOf = (req: FastifyRequest) =>
    z.object({ id: z.string().uuid() }).parse(req.params).id;
  let reconciling = false;
  let completedAt = 0;
  let cycleFailed = false;
  async function reconcile() {
    if (reconciling) return;
    reconciling = true;
    let failed = false;
    try {
      const rows = store.db
        .prepare(
          "SELECT i.data FROM intents i LEFT JOIN entitlements e ON e.handoff=i.handoff LEFT JOIN deletions d ON d.handoff=i.handoff WHERE e.handoff IS NULL AND d.handoff IS NULL",
        )
        .all() as { data: string }[];
      for (const row of rows) {
        const intent: PaymentIntent = JSON.parse(row.data);
        const adapter = adapters[intent.currency];
        if (
          !adapter ||
          intent.network !== adapter.network ||
          intent.token !== adapter.token
        ) {
          failed = true;
          cycleFailed = true;
          continue;
        }
        try {
          const evidence = await adapter.find(intent);
          const eligible = evidence.filter(
            (e) =>
              e.success &&
              e.finalized &&
              e.network === intent.network &&
              e.token === intent.token &&
              e.payer === intent.payer &&
              e.recipient === intent.recipient &&
              e.units === intent.units &&
              e.reference === intent.reference &&
              e.block >= intent.startBlock &&
              e.timestamp >= intent.createdAt - 60_000 &&
              e.timestamp <= intent.expiresAt,
          );
          if (eligible.length !== 1) continue;
          const e = eligible[0];
          const handoff = store.get(intent.handoff);
          if (
            store.db
              .prepare("SELECT handoff FROM deletions WHERE handoff=?")
              .get(intent.handoff)
          )
            continue;
          if (
            !handoff ||
            handoff.manifestHash !== intent.manifestHash ||
            handoff.clientWallet !== intent.payer ||
            handoff.files.some((f) => f.scan !== "clean")
          )
            continue;
          let intact = true;
          for (const file of handoff.files) {
            const bytes = await readFile(join(directory, "originals", file.id));
            if (hash(bytes) !== file.sha256) {
              intact = false;
              break;
            }
          }
          if (
            store.db
              .prepare("SELECT handoff FROM deletions WHERE handoff=?")
              .get(intent.handoff)
          )
            continue;
          if (!intact)
            throw new Error(
              "Original integrity check failed before entitlement",
            );
          const receipt: Receipt = {
            handoff: intent.handoff,
            intent: intent.id,
            title: handoff.title,
            manifestHash: intent.manifestHash,
            payer: intent.payer,
            recipient: intent.recipient,
            currency: intent.currency,
            units: intent.units,
            network: intent.network,
            token: intent.token,
            transaction: e.transaction,
            blockHash: e.blockHash,
            block: e.block,
            paidAt: e.timestamp,
            verifiedAt: Date.now(),
            expiresAt: Date.now() + 30 * 86400_000,
          };
          store.db
            .prepare("INSERT OR IGNORE INTO entitlements VALUES(?,?,?,?)")
            .run(
              intent.handoff,
              intent.payer,
              `${intent.network}:${e.transaction}`,
              JSON.stringify(receipt),
            );
        } catch (error) {
          failed = true;
          cycleFailed = true;
          app.log.error(
            { err: error, intent: intent.id },
            "Payment reconciliation failed",
          );
        }
      }
    } catch (error) {
      failed = true;
      cycleFailed = true;
      app.log.error({ err: error }, "Payment reconciliation cycle failed");
    } finally {
      cycleFailed = failed;
      completedAt = Date.now();
      reconciling = false;
    }
  }
  app.post("/api/handoffs/:id/checkout", async (req) => {
    const user = session(req);
    if (user.scope) fail(403, "Checkout requires the wallet session");
    const handoff = store.get(idOf(req));
    if (
      !handoff ||
      handoff.clientWallet !== user.address ||
      handoff.currency !== user.currency
    )
      fail(403, "The approved client wallet is required");
    const adapter = adapters[handoff.currency];
    if (!adapter) fail(503, "Test-network checkout is not configured");
    const existing = getIntent(handoff.id);
    if (existing) {
      if (existing.expiresAt <= Date.now() && !getReceipt(handoff.id))
        fail(
          409,
          "The payment deadline passed. Check payment status or contact the creator; do not send another payment.",
        );
      return { intent: existing, receipt: getReceipt(handoff.id) ?? null };
    }
    if (
      handoff.status !== "ready" ||
      !handoff.manifestHash ||
      Date.parse(handoff.deadline) <= Date.now()
    )
      fail(409, "This delivery cannot accept payment");
    const prepared = await adapter.prepare(user.address);
    const intent: PaymentIntent = {
      id: randomUUID(),
      handoff: handoff.id,
      currency: handoff.currency,
      manifestHash: handoff.manifestHash!,
      payer: user.address,
      recipient: handoff.creator,
      units: units(handoff.amount, handoff.currency === "NIM" ? 5 : 6),
      network: adapter.network,
      token: adapter.token,
      startBlock: prepared.startBlock,
      reference: prepared.reference,
      createdAt: Date.now(),
      expiresAt: Date.parse(handoff.deadline),
    };
    try {
      store.db
        .prepare("INSERT INTO intents VALUES(?,?,?,?,?,?)")
        .run(
          intent.id,
          intent.handoff,
          intent.payer,
          intent.network,
          intent.reference,
          JSON.stringify(intent),
        );
    } catch {
      const current = getIntent(handoff.id);
      if (current)
        return { intent: current, receipt: getReceipt(handoff.id) ?? null };
      fail(
        409,
        "Finish the existing payment from this wallet before starting another",
      );
    }
    return { intent, receipt: null };
  });
  app.get("/api/receipts/:id", async (req) => {
    const user = session(req);
    const id = idOf(req);
    const handoff = store.get(id);
    if (
      !handoff ||
      ![handoff.creator, handoff.clientWallet].includes(user.address) ||
      handoff.currency !== user.currency
    )
      fail(404, "Receipt not found");
    return {
      receipt: getReceipt(id) ?? null,
      intent: getIntent(id) ?? null,
      events: store.db
        .prepare(
          "SELECT file,at FROM access_events WHERE handoff=? ORDER BY at DESC LIMIT 100",
        )
        .all(id),
    };
  });
  app.get("/api/purchases", async (req) => {
    const user = session(req);
    const rows = store.db
      .prepare(
        "SELECT data FROM entitlements WHERE wallet=? AND json_extract(data, '$.currency')=? ORDER BY rowid DESC",
      )
      .all(user.address, user.currency) as { data: string }[];
    return {
      purchases: rows.map((r) => {
        const receipt: Receipt = JSON.parse(r.data);
        return { receipt, files: store.get(receipt.handoff)?.files ?? [] };
      }),
    };
  });
  app.get("/api/originals/:id/:fileId", async (req, reply) => {
    const user = session(req);
    const { id, fileId } = z
      .object({ id: z.string().uuid(), fileId: z.string().uuid() })
      .parse(req.params);
    const receipt = getReceipt(id);
    if (
      !receipt ||
      receipt.payer !== user.address ||
      receipt.currency !== user.currency
    )
      fail(403, "A verified, finalized payment entitlement is required");
    if (receipt.expiresAt <= Date.now())
      fail(410, "The download retention period has ended");
    const handoff = store.get(id);
    const file = handoff?.files.find((f) => f.id === fileId);
    if (
      !file ||
      file.scan !== "clean" ||
      handoff?.manifestHash !== receipt.manifestHash
    )
      fail(404, "File unavailable");
    const bytes = await readFile(join(directory, "originals", fileId));
    if (hash(bytes) !== file.sha256)
      fail(503, "File integrity check failed; contact support");
    store.db
      .prepare("INSERT INTO access_events VALUES(?,?,?,?,?)")
      .run(randomUUID(), id, user.address, fileId, Date.now());
    return reply
      .header(
        "Content-Disposition",
        `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, "%27")}`,
      )
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .type("application/octet-stream")
      .send(bytes);
  });
  app.get("/api/support", async (req) => {
    const user = session(req);
    const rows = store.db
      .prepare(
        "SELECT handoff,data FROM support WHERE wallet=? ORDER BY rowid DESC",
      )
      .all(user.address) as { handoff: string; data: string }[];
    return {
      tickets: rows.flatMap((row) => {
        const handoff = store.get(row.handoff);
        return handoff && handoff.currency === user.currency
          ? [
              {
                ...(JSON.parse(row.data) as SupportTicket),
                handoffId: handoff.id,
                title: handoff.title,
              },
            ]
          : [];
      }),
    };
  });
  app.post("/api/support/:id", async (req) => {
    const user = session(req);
    const id = idOf(req);
    const handoff = store.get(id);
    if (
      !handoff ||
      ![handoff.creator, handoff.clientWallet].includes(user.address) ||
      handoff.currency !== user.currency
    )
      fail(404, "Handoff not found");
    const data = z
      .object({
        kind: z.enum(["access", "refund", "other"]),
        message: z.string().trim().min(1).max(2000),
      })
      .parse(req.body);
    const count = store.db
      .prepare("SELECT count(*) n FROM support WHERE handoff=? AND wallet=?")
      .get(id, user.address) as { n: number };
    if (count.n >= 10) fail(429, "Support request limit reached");
    const ticket: SupportTicket = {
      ...data,
      id: randomUUID(),
      createdAt: Date.now(),
      status: "open",
      refundTransaction: null,
    };
    store.db
      .prepare("INSERT INTO support VALUES(?,?,?,?)")
      .run(ticket.id, id, user.address, JSON.stringify(ticket));
    return { ticket };
  });
  app.get("/api/support/:id", async (req) => {
    const user = session(req);
    const id = idOf(req);
    const h = store.get(id);
    if (
      !h ||
      ![h.creator, h.clientWallet].includes(user.address) ||
      h.currency !== user.currency
    )
      fail(404, "Handoff not found");
    return {
      tickets: (
        store.db
          .prepare(
            "SELECT data FROM support WHERE handoff=? AND wallet=? ORDER BY rowid DESC",
          )
          .all(id, user.address) as { data: string }[]
      ).map((r) => JSON.parse(r.data)),
    };
  });
  const timer = setInterval(() => void reconcile(), 15_000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    while (reconciling) await new Promise((resolve) => setTimeout(resolve, 25));
  });
  app.addHook("onReady", async () => {
    void reconcile();
  });
  return {
    reconcile,
    getReceipt,
    healthy: () => !cycleFailed && Date.now() - completedAt < 120_000,
  };
}
