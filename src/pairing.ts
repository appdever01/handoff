import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { hash } from "./auth.ts";
import type { Store } from "./store.ts";
import type { Session } from "../packages/contracts/index.ts";

export function pairing(
  app: FastifyInstance,
  store: Store,
  origin: string,
  session: (req: FastifyRequest) => Session,
) {
  store.db
    .exec(`CREATE TABLE IF NOT EXISTS pairings (id TEXT PRIMARY KEY, secret TEXT NOT NULL, phrase TEXT NOT NULL, role TEXT NOT NULL, expires INTEGER NOT NULL, account TEXT, redeemed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, account TEXT NOT NULL, session TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created INTEGER NOT NULL);`);
  const idOf = (req: FastifyRequest) =>
    z.object({ id: z.string().uuid() }).parse(req.params).id;
  app.post(
    "/api/pairings",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { role } = z
        .object({ role: z.enum(["upload", "download"]) })
        .parse(req.body);
      const id = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      const phrase = randomBytes(6).toString("hex").match(/.{4}/g)!.join("-");
      const expires = Date.now() + 300_000;
      store.db.prepare("DELETE FROM pairings WHERE expires<=?").run(Date.now());
      store.db
        .prepare(
          "INSERT INTO pairings(id,secret,phrase,role,expires) VALUES(?,?,?,?,?)",
        )
        .run(id, hash(secret), phrase, role, expires);
      reply.setCookie("handoff_pairing", secret, {
        httpOnly: true,
        secure: origin.startsWith("https:"),
        sameSite: "strict",
        path: "/api/pairings",
        maxAge: 300,
      });
      return { id, phrase, role, origin, expires, url: `${origin}/pair/${id}` };
    },
  );
  app.get("/api/pairings/:id", async (req) => {
    session(req);
    const row = store.db
      .prepare(
        "SELECT id,phrase,role,expires FROM pairings WHERE id=? AND expires>? AND redeemed=0",
      )
      .get(idOf(req), Date.now());
    if (!row) return { pairing: null };
    return { pairing: { ...row, origin } };
  });
  app.post("/api/pairings/:id/approve", async (req) => {
    const user = session(req);
    if (user.scope)
      throw Object.assign(new Error("Approve from your wallet session"), {
        statusCode: 403,
      });
    const { phrase } = z.object({ phrase: z.string().max(20) }).parse(req.body);
    const result = store.db
      .prepare(
        "UPDATE pairings SET account=? WHERE id=? AND phrase=? AND expires>? AND account IS NULL AND redeemed=0",
      )
      .run(JSON.stringify(user), idOf(req), phrase, Date.now());
    if (!result.changes)
      throw Object.assign(new Error("Pairing expired or already approved"), {
        statusCode: 409,
      });
    return { ok: true };
  });
  app.post("/api/pairings/:id/redeem", async (req, reply) => {
    const row = store.db
      .prepare(
        "UPDATE pairings SET redeemed=1 WHERE id=? AND secret=? AND expires>? AND account IS NOT NULL AND redeemed=0 RETURNING account,role",
      )
      .get(idOf(req), hash(req.cookies.handoff_pairing ?? ""), Date.now()) as
      { account: string; role: "upload" | "download" } | undefined;
    if (!row)
      return reply
        .code(409)
        .send({ error: "Waiting for approval, or pairing expired" });
    const user: Session = { ...JSON.parse(row.account), scope: row.role };
    const token = randomBytes(32).toString("base64url");
    store.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(hash(token), JSON.stringify(user), Date.now() + 3600_000);
    store.db
      .prepare("INSERT INTO devices VALUES(?,?,?,?,?)")
      .run(randomUUID(), user.address, hash(token), row.role, Date.now());
    reply.clearCookie("handoff_pairing", { path: "/api/pairings" });
    setSessionCookie(reply, token, origin, 3600);
    return { user };
  });
  app.get("/api/devices", async (req) => {
    const user = session(req);
    return {
      devices: store.db
        .prepare(
          "SELECT d.id,d.role,d.created,s.expires FROM devices d JOIN sessions s ON s.hash=d.session WHERE d.account=? AND s.expires>?",
        )
        .all(user.address, Date.now()),
    };
  });
  app.delete("/api/devices/:id", async (req) => {
    const user = session(req);
    store.db
      .prepare(
        "DELETE FROM sessions WHERE hash IN (SELECT session FROM devices WHERE id=? AND account=?)",
      )
      .run(idOf(req), user.address);
    store.db
      .prepare("DELETE FROM devices WHERE id=? AND account=?")
      .run(idOf(req), user.address);
    return { ok: true };
  });
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  origin: string,
  seconds: number,
) {
  reply.setCookie("handoff_session", token, {
    httpOnly: true,
    secure: origin.startsWith("https:"),
    sameSite: "strict",
    path: "/",
    maxAge: seconds,
  });
}
