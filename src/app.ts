import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z, ZodError } from "zod";
import {
  currencySchema,
  draftSchema,
  type Handoff,
  type PublicHandoff,
  type Session,
} from "../packages/contracts/index.ts";
import { openStore } from "./store.ts";
import { hash, proofSchema, verifyProof } from "./auth.ts";
import { createPreview, scanFile } from "./media.ts";

class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export async function buildApp(
  options: {
    directory?: string;
    origin?: string;
    scan?: typeof scanFile;
    logger?: boolean;
  } = {},
) {
  const directory = resolve(options.directory ?? ".data");
  const origin = options.origin ?? "http://localhost:5173";
  const secure = new URL(origin).protocol === "https:";
  const store = openStore(directory);
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 16_384,
    requestTimeout: 60_000,
  });
  let uploads = 0;
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  });
  app.addHook("onClose", async () => store.db.close());
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== origin
    )
      throw new HttpError(403, "Request origin is not allowed");
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send({ error: error.issues[0]?.message ?? "Invalid request" });
    const status =
      error instanceof HttpError
        ? error.statusCode
        : ((error as { statusCode?: number }).statusCode ?? 500);
    if (status >= 500) req.log.error(error);
    return reply.code(status).send({
      error:
        status >= 500
          ? "Something went wrong. Please try again."
          : (error as Error).message,
    });
  });
  function session(req: FastifyRequest): Session {
    const user = store.session(hash(req.cookies.handoff_session ?? ""));
    if (!user) throw new HttpError(401, "Connect your wallet to continue");
    return user;
  }
  function owned(req: FastifyRequest, draftOnly = false) {
    const user = session(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const handoff = store.get(id);
    if (!handoff || handoff.creator !== user.address)
      throw new HttpError(404, "Handoff not found");
    if (draftOnly && handoff.status !== "draft")
      throw new HttpError(409, "Published deliveries cannot be changed");
    return handoff;
  }
  function deadline(value: string) {
    const delta = Date.parse(value) - Date.now();
    if (delta <= 0 || delta > 30 * 86400_000)
      throw new HttpError(400, "Choose a deadline within the next 30 days");
  }
  app.get("/api/health", async () => ({ ok: true, checkoutEnabled: false }));
  app.get("/api/session", async (req) => ({
    user: store.session(hash(req.cookies.handoff_session ?? "")) ?? null,
  }));
  app.post(
    "/api/auth/challenge",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const { currency } = z
        .object({ currency: currencySchema })
        .parse(req.body);
      const id = randomUUID();
      const expires = Date.now() + 5 * 60_000;
      const message = `Handoff wallet sign-in\nOrigin: ${origin}\nCurrency: ${currency}\nNonce: ${id}\nExpires: ${new Date(expires).toISOString()}\nThis proves wallet ownership. It does not authorize a payment.`;
      store.db
        .prepare("DELETE FROM challenges WHERE expires<=?")
        .run(Date.now());
      store.db.prepare("DELETE FROM sessions WHERE expires<=?").run(Date.now());
      store.db
        .prepare("INSERT INTO challenges VALUES (?,?,?,?)")
        .run(id, message, currency, expires);
      return { id, message };
    },
  );
  app.post(
    "/api/auth/verify",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const proof = proofSchema.parse(req.body);
      const row = store.db
        .prepare("DELETE FROM challenges WHERE id=? RETURNING *")
        .get(proof.challengeId) as
        { message: string; currency: string; expires: number } | undefined;
      if (!row || row.expires <= Date.now() || row.currency !== proof.currency)
        throw new HttpError(401, "Sign-in request expired. Try again.");
      let user: Session;
      try {
        user = await verifyProof(row.message, proof);
      } catch {
        throw new HttpError(401, "Wallet signature could not be verified");
      }
      const token = randomBytes(32).toString("base64url");
      store.db
        .prepare("INSERT INTO sessions VALUES (?,?,?)")
        .run(hash(token), JSON.stringify(user), Date.now() + 86400_000);
      reply.setCookie("handoff_session", token, {
        httpOnly: true,
        secure,
        sameSite: "strict",
        path: "/",
        maxAge: 86400,
      });
      return { user };
    },
  );
  app.post("/api/logout", async (req, reply) => {
    store.db
      .prepare("DELETE FROM sessions WHERE hash=?")
      .run(hash(req.cookies.handoff_session ?? ""));
    reply.clearCookie("handoff_session", {
      path: "/",
      httpOnly: true,
      secure,
      sameSite: "strict",
    });
    return { ok: true };
  });
  app.get("/api/handoffs", async (req) => ({
    handoffs: store.list(session(req).address),
  }));
  app.post("/api/handoffs", async (req, reply) => {
    const user = session(req);
    const data = draftSchema.parse(req.body);
    deadline(data.deadline);
    if (data.currency !== user.currency)
      throw new HttpError(
        400,
        "Connect a wallet for the selected currency first",
      );
    if (store.list(user.address).length >= 50)
      throw new HttpError(
        409,
        "This pilot allows up to 50 handoffs per wallet",
      );
    const handoff: Handoff = {
      ...data,
      id: randomUUID(),
      creator: user.address,
      clientWallet: null,
      status: "draft",
      createdAt: new Date().toISOString(),
      publishedAt: null,
      manifestHash: null,
      files: [],
    };
    store.save(handoff);
    return reply.code(201).send({ handoff });
  });
  app.get("/api/handoffs/:id", async (req) => ({ handoff: owned(req) }));
  app.put("/api/handoffs/:id", async (req) => {
    const handoff = owned(req, true);
    const data = draftSchema.parse(req.body);
    deadline(data.deadline);
    if (data.currency !== handoff.currency)
      throw new HttpError(
        400,
        "Create a new draft to change the payout currency",
      );
    const next = { ...handoff, ...data };
    store.save(next);
    return { handoff: next };
  });
  app.post("/api/handoffs/:id/files", async (req, reply) => {
    const handoff = owned(req, true);
    if (handoff.files.length >= 10)
      throw new HttpError(409, "A handoff can contain up to 10 files");
    if (uploads >= 2)
      throw new HttpError(429, "Uploads are busy. Try again shortly.");
    uploads++;
    const id = randomUUID();
    const originalPath = join(directory, "originals", id);
    const previewPath = join(directory, "previews", `${id}.jpg`);
    try {
      const part = await req.file();
      if (!part) throw new HttpError(400, "Choose an image to upload");
      const bytes = await part.toBuffer();
      let result: Awaited<ReturnType<typeof createPreview>>;
      try {
        result = await createPreview(bytes);
      } catch {
        throw new HttpError(
          400,
          "Use a valid still JPEG, PNG or WebP image, up to 24 megapixels",
        );
      }
      await mkdir(join(directory, "originals"), {
        recursive: true,
        mode: 0o700,
      });
      await mkdir(join(directory, "previews"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(originalPath, bytes, { mode: 0o600, flag: "wx" });
      const clean = await (options.scan ?? scanFile)(originalPath);
      await writeFile(previewPath, result.preview, { mode: 0o600, flag: "wx" });
      const current = owned(req, true);
      if (current.files.length >= 10)
        throw new HttpError(409, "A handoff can contain up to 10 files");
      const name =
        part.filename.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 180) ||
        "image";
      current.files.push({
        id,
        name,
        bytes: bytes.length,
        mime: result.mime,
        sha256: hash(bytes),
        previewSha256: hash(result.preview),
        scan: clean ? "clean" : "quarantined",
        approved: false,
      });
      store.save(current);
      return reply.code(201).send({ handoff: current });
    } catch (error) {
      await Promise.allSettled([
        rm(originalPath, { force: true }),
        rm(previewPath, { force: true }),
      ]);
      throw error;
    } finally {
      uploads--;
    }
  });
  app.delete("/api/handoffs/:id/files/:fileId", async (req) => {
    const handoff = owned(req, true);
    const { fileId } = z
      .object({ fileId: z.string().uuid() })
      .parse(req.params);
    if (!handoff.files.some((file) => file.id === fileId))
      throw new HttpError(404, "File not found");
    handoff.files = handoff.files.filter((file) => file.id !== fileId);
    store.save(handoff);
    await Promise.all([
      rm(join(directory, "originals", fileId), { force: true }),
      rm(join(directory, "previews", `${fileId}.jpg`), { force: true }),
    ]);
    return { handoff };
  });
  app.post("/api/handoffs/:id/files/:fileId/rescan", async (req) => {
    owned(req, true);
    const { fileId } = z
      .object({ fileId: z.string().uuid() })
      .parse(req.params);
    if (uploads >= 2)
      throw new HttpError(429, "File processing is busy. Try again shortly.");
    if (!owned(req, true).files.some((file) => file.id === fileId))
      throw new HttpError(404, "File not found");
    uploads++;
    try {
      const clean = await (options.scan ?? scanFile)(
        join(directory, "originals", fileId),
      );
      const handoff = owned(req, true);
      const file = handoff.files.find((file) => file.id === fileId);
      if (!file) throw new HttpError(404, "File not found");
      file.scan = clean ? "clean" : "quarantined";
      file.approved = false;
      store.save(handoff);
      return { handoff };
    } finally {
      uploads--;
    }
  });
  app.post("/api/handoffs/:id/approve-previews", async (req) => {
    const handoff = owned(req, true);
    const { fileIds } = z
      .object({ fileIds: z.array(z.string().uuid()).min(1).max(10) })
      .parse(req.body);
    if (
      fileIds.length !== handoff.files.length ||
      handoff.files.some((file) => !fileIds.includes(file.id))
    )
      throw new HttpError(409, "Review every current preview before approving");
    if (handoff.files.some((file) => file.scan !== "clean"))
      throw new HttpError(
        409,
        "Every file needs a clean malware scan before approval",
      );
    handoff.files.forEach((file) => {
      file.approved = true;
    });
    store.save(handoff);
    return { handoff };
  });
  app.post("/api/handoffs/:id/publish", async (req) => {
    const handoff = owned(req, true);
    deadline(handoff.deadline);
    if (
      !handoff.files.length ||
      handoff.files.some((file) => !file.approved || file.scan !== "clean")
    )
      throw new HttpError(
        409,
        "Upload files, pass malware screening, and approve every preview before publishing",
      );
    handoff.manifestHash = hash(
      JSON.stringify({
        title: handoff.title,
        description: handoff.description,
        currency: handoff.currency,
        amount: handoff.amount,
        creator: handoff.creator,
        terms: handoff.terms,
        deadline: handoff.deadline,
        files: handoff.files,
      }),
    );
    handoff.status = "awaiting-client";
    handoff.publishedAt = new Date().toISOString();
    store.save(handoff);
    return { handoff };
  });
  app.get("/api/public/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const handoff = store.get(id);
    if (
      !handoff ||
      handoff.status === "draft" ||
      Date.parse(handoff.deadline) <= Date.now()
    )
      throw new HttpError(404, "This handoff is unavailable or expired");
    const {
      clientLabel: _label,
      clientWallet: _wallet,
      ...publicData
    } = handoff;
    return {
      handoff: {
        ...publicData,
        checkoutEnabled: false,
        downloadDays: 30,
      } satisfies PublicHandoff,
    };
  });
  app.get("/api/previews/:id/:fileId", async (req, reply) => {
    const { id, fileId } = z
      .object({ id: z.string().uuid(), fileId: z.string().uuid() })
      .parse(req.params);
    const handoff = store.get(id);
    const file = handoff?.files.find((item) => item.id === fileId);
    if (!handoff || !file) throw new HttpError(404, "Preview not found");
    const owner =
      store.session(hash(req.cookies.handoff_session ?? ""))?.address ===
      handoff.creator;
    if (
      !owner &&
      (handoff.status === "draft" ||
        file.scan !== "clean" ||
        Date.parse(handoff.deadline) <= Date.now())
    )
      throw new HttpError(404, "Preview not found");
    return reply
      .type("image/jpeg")
      .send(await readFile(join(directory, "previews", `${fileId}.jpg`)));
  });
  app.post("/api/public/:id/request-access", async (req) => {
    const user = session(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const handoff = store.get(id);
    if (
      !handoff ||
      handoff.status === "draft" ||
      Date.parse(handoff.deadline) <= Date.now()
    )
      throw new HttpError(404, "Handoff not found");
    if (user.currency !== handoff.currency || user.address === handoff.creator)
      throw new HttpError(400, "Use a client wallet for this invoice currency");
    if (handoff.clientWallet && handoff.clientWallet !== user.address)
      throw new HttpError(
        409,
        "This handoff is already assigned to another client",
      );
    const count = store.db
      .prepare("SELECT count(*) AS n FROM requests WHERE handoff=?")
      .get(id) as { n: number };
    if (count.n >= 20)
      throw new HttpError(
        429,
        "Access requests are full. Contact the creator.",
      );
    store.db
      .prepare("INSERT OR IGNORE INTO requests VALUES (?,?)")
      .run(id, user.address);
    return { ok: true };
  });
  app.get("/api/handoffs/:id/requests", async (req) => {
    const handoff = owned(req);
    return {
      wallets: store.db
        .prepare("SELECT wallet FROM requests WHERE handoff=?")
        .all(handoff.id)
        .map((row) => row.wallet),
    };
  });
  app.post("/api/handoffs/:id/bind-client", async (req) => {
    const handoff = owned(req);
    const { wallet } = z
      .object({ wallet: z.string().max(100) })
      .parse(req.body);
    if (handoff.status !== "awaiting-client" || handoff.clientWallet)
      throw new HttpError(
        409,
        "Client binding is already frozen or this handoff is not published",
      );
    if (
      !store.db
        .prepare("SELECT wallet FROM requests WHERE handoff=? AND wallet=?")
        .get(handoff.id, wallet)
    )
      throw new HttpError(
        400,
        "The client must request access with their wallet first",
      );
    handoff.clientWallet = wallet;
    handoff.status = "ready";
    store.save(handoff);
    return { handoff };
  });
  app.post("/api/handoffs/:id/checkout", async () => {
    throw new HttpError(
      503,
      "Payments are not enabled in this development build",
    );
  });
  app.get("/api/originals/:id/:fileId", async (req) => {
    session(req);
    throw new HttpError(
      403,
      "A verified, finalized payment entitlement is required",
    );
  });
  return app;
}
