import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import type { FastifyInstance } from "fastify";
import type { Store } from "./store.ts";
import type { PaymentAdapter, ChainEvidence } from "./payments.ts";
import type { PaymentIntent } from "../packages/contracts/index.ts";
import { hash } from "./auth.ts";
import { setSessionCookie } from "./pairing.ts";
import { z } from "zod";
export const demoAccounts = {
  creator: privateKeyToAccount(("0x" + "31".repeat(32)) as `0x${string}`)
    .address,
  client: privateKeyToAccount(("0x" + "32".repeat(32)) as `0x${string}`)
    .address,
};
export function sandboxAdapter(store: Store): PaymentAdapter {
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS demo_chain (intent TEXT PRIMARY KEY, data TEXT NOT NULL)",
  );
  return {
    network: "local:simulation",
    token: "DEMO-USDT",
    prepare: async () => ({
      startBlock: 1,
      reference: randomBytes(16).toString("hex"),
    }),
    find: async (intent) => {
      const row = store.db
        .prepare("SELECT data FROM demo_chain WHERE intent=?")
        .get(intent.id) as { data: string } | undefined;
      return row ? [JSON.parse(row.data)] : [];
    },
  };
}
export function sandboxRoutes(
  app: FastifyInstance,
  store: Store,
  origin: string,
) {
  app.post("/api/demo/login", async (req, reply) => {
    const { role } = z
      .object({ role: z.enum(["creator", "client"]) })
      .parse(req.body);
    const user = { address: demoAccounts[role], currency: "USDT" };
    const token = randomBytes(32).toString("base64url");
    store.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(hash(token), JSON.stringify(user), Date.now() + 3600_000);
    setSessionCookie(reply, token, origin, 3600);
    return { user };
  });
  app.post("/api/demo/pay/:id", async (req) => {
    const user = store.session(hash(req.cookies.handoff_session ?? ""));
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = store.db
      .prepare("SELECT data FROM intents WHERE id=?")
      .get(id) as { data: string } | undefined;
    const intent: PaymentIntent | undefined = row && JSON.parse(row.data);
    if (
      !intent ||
      intent.network !== "local:simulation" ||
      user?.address !== intent.payer ||
      user.scope
    )
      throw Object.assign(new Error("Demo client session required"), {
        statusCode: 403,
      });
    const evidence: ChainEvidence = {
      transaction: `demo-${id}`,
      blockHash: "demo-block",
      block: 2,
      timestamp: Date.now(),
      payer: intent.payer,
      recipient: intent.recipient,
      units: intent.units,
      network: intent.network,
      token: intent.token,
      reference: intent.reference,
      success: true,
      finalized: true,
    };
    store.db
      .prepare("INSERT OR IGNORE INTO demo_chain VALUES(?,?)")
      .run(id, JSON.stringify(evidence));
    return { simulated: true };
  });
}
