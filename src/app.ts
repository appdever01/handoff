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
  type Health,
} from "../packages/contracts/index.ts";
import { openStore } from "./store.ts";
import { hash, proofSchema, verifyProof } from "./auth.ts";
import { sandboxAdapter, sandboxRoutes } from "./sandbox.ts";
import { retain } from "./retention.ts";
import { payments, type PaymentAdapter } from "./payments.ts";
import { pairing } from "./pairing.ts";
import { CloudinaryPreviewError } from "./cloudinary.ts";
import {
  createPreview,
  scanFile,
  sourceType,
  sourcePlaceholder,
} from "./media.ts";

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
    sandbox?: boolean;
    origin?: string;
    scan?: typeof scanFile;
    preview?: typeof createPreview;
    logger?: boolean;
    production?: boolean;
    readiness?: () => Promise<Record<string, boolean>>;
    payments?: Partial<Record<"NIM" | "USDT", PaymentAdapter>>;
  } = {},
) {
  const directory = resolve(options.directory ?? ".data");
  const origin = options.origin ?? "http://localhost:5173";
  if (
    options.sandbox &&
    (process.env.NODE_ENV === "production" ||
      !["localhost", "127.0.0.1"].includes(new URL(origin).hostname) ||
      !directory.endsWith(".sandbox-data"))
  )
    throw new Error(
      "Sandbox requires a loopback origin and a separate .sandbox-data directory",
    );
  const mode = options.sandbox ? "sandbox" : "wallet";
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const modePath = join(directory, "mode");
  try {
    await writeFile(modePath, mode, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if ((await readFile(modePath, "utf8")) !== mode)
    throw new Error(
      "Sandbox and wallet data directories cannot be interchanged",
    );
  const secure = new URL(origin).protocol === "https:";
  const store = openStore(directory);
  const app = Fastify({
    logger: options.logger
      ? {
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            "res.headers['set-cookie']",
          ],
        }
      : false,
    disableRequestLogging: options.production ?? false,
    trustProxy: options.production
      ? (_address: string, hop: number) => hop === 0
      : false,
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
    if (error instanceof CloudinaryPreviewError)
      req.log.warn({ preview: error.diagnostic }, "Preview processing failed");
    else if (status >= 500) req.log.error(error);
    return reply.code(status).send({
      error:
        status >= 500 && !(error instanceof CloudinaryPreviewError)
          ? "Something went wrong. Please try again."
          : (error as Error).message,
    });
  });
  function session(req: FastifyRequest): Session {
    const user = store.session(hash(req.cookies.handoff_session ?? ""));
    if (!user) throw new HttpError(401, "Connect your wallet to continue");
    return user;
  }
  app.addHook("preHandler", async (req) => {
    const user = store.session(hash(req.cookies.handoff_session ?? ""));
    if (!user?.scope) return;
    const path = req.url.split("?")[0];
    const common =
      path === "/api/health" ||
      path === "/api/ready" ||
      path === "/api/session" ||
      path === "/api/logout" ||
      path.startsWith("/api/devices") ||
      /^\/api\/support(\/|$)/.test(path);
    const download =
      req.method === "GET" &&
      /^\/api\/(purchases|originals|receipts|public|previews)(\/|$)/.test(path);
    const upload =
      (/^\/api\/handoffs(\/|$)/.test(path) &&
        !/(checkout|bind-client)$/.test(path)) ||
      (req.method === "GET" &&
        (/^\/api\/(previews|receipts|public)(\/|$)/.test(path) ||
          path === "/api/access-requests"));
    if (!common && !(user.scope === "download" ? download : upload))
      throw new HttpError(
        403,
        "This paired session does not allow this action",
      );
  });
  pairing(app, store, origin, session);
  function owned(req: FastifyRequest, draftOnly = false) {
    const user = session(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const handoff = store.get(id);
    if (
      !handoff ||
      handoff.creator !== user.address ||
      handoff.currency !== user.currency
    )
      throw new HttpError(404, "Handoff not found");
    if (
      store.db
        .prepare("SELECT handoff FROM deletions WHERE handoff=?")
        .get(handoff.id)
    )
      throw new HttpError(410, "This delivery has passed its retention period");
    if (draftOnly && handoff.status !== "draft")
      throw new HttpError(409, "Published deliveries cannot be changed");
    return handoff;
  }
  function deadline(value: string) {
    const delta = Date.parse(value) - Date.now();
    if (delta <= 0 || delta > 30 * 86400_000)
      throw new HttpError(400, "Choose a deadline within the next 30 days");
  }
  const paymentCapabilities: Health["payments"] = {
    NIM: {
      enabled: !options.sandbox && Boolean(options.payments?.NIM),
      reason: options.sandbox
        ? "NIM payments are unavailable in the local sandbox"
        : options.payments?.NIM
          ? null
          : "Nimiq testnet checkout needs a configured history RPC",
    },
    USDT: {
      enabled: Boolean(options.sandbox || options.payments?.USDT),
      reason:
        options.sandbox || options.payments?.USDT
          ? null
          : "USDT test checkout needs a Polygon Amoy RPC and a six-decimal test token",
    },
  };
  function currentStatus(handoff: Handoff): Handoff {
    return {
      ...handoff,
      status: store.db
        .prepare("SELECT handoff FROM entitlements WHERE handoff=?")
        .get(handoff.id)
        ? "paid"
        : store.db
              .prepare("SELECT handoff FROM intents WHERE handoff=?")
              .get(handoff.id)
          ? "payment-pending"
          : handoff.status,
    };
  }
  app.get(
    "/api/health",
    { config: { rateLimit: false } },
    async (): Promise<Health> => ({
      ok: true,
      checkoutEnabled: Object.values(paymentCapabilities).some(
        (p) => p.enabled,
      ),
      sandbox: Boolean(options.sandbox),
      mode: options.sandbox ? "sandbox" : "wallet",
      currencies: currencySchema.options.filter(
        (currency) => paymentCapabilities[currency].enabled,
      ),
      payments: paymentCapabilities,
    }),
  );
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
    handoffs: store.list(session(req).address).map(currentStatus),
  }));
  app.get("/api/access-requests", async (req) => {
    const user = session(req);
    return {
      requests: store
        .list(user.address)
        .filter(
          (h) =>
            h.currency === user.currency &&
            h.status === "awaiting-client" &&
            !h.clientWallet &&
            Date.parse(h.deadline) > Date.now(),
        )
        .flatMap((h) =>
          store.db
            .prepare(
              "SELECT wallet FROM requests WHERE handoff=? ORDER BY rowid",
            )
            .all(h.id)
            .map((row) => ({
              handoffId: h.id,
              title: h.title,
              wallet: row.wallet,
            })),
        ),
    };
  });
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
      throw new HttpError(409, "You can keep up to 50 handoffs per wallet");
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
  app.get("/api/handoffs/:id", async (req) => ({
    handoff: currentStatus(owned(req)),
  }));
  app.delete("/api/handoffs/:id", async (req) => {
    const handoff = owned(req, true);
    if (uploads > 0)
      throw new HttpError(
        409,
        "Wait for file processing to finish before deleting a draft",
      );
    store.db.prepare("DELETE FROM handoffs WHERE id=?").run(handoff.id);
    store.db.prepare("DELETE FROM requests WHERE handoff=?").run(handoff.id);
    await Promise.all(
      handoff.files.flatMap((file) => [
        rm(join(directory, "originals", file.id), { force: true }),
        rm(join(directory, "previews", `${file.id}.jpg`), { force: true }),
      ]),
    );
    return { ok: true };
  });
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
    const totals = store.db
      .prepare(
        "SELECT coalesce(sum(json_extract(f.value, '$.bytes')),0) n FROM handoffs h, json_each(h.data, '$.files') f WHERE h.id NOT IN (SELECT handoff FROM deletions)",
      )
      .get() as { n: number };
    const accountBytes = store
      .list(handoff.creator)
      .filter(
        (h) =>
          !store.db
            .prepare("SELECT handoff FROM deletions WHERE handoff=?")
            .get(h.id),
      )
      .reduce((sum, h) => sum + h.files.reduce((n, f) => n + f.bytes, 0), 0);
    if (
      totals.n + (uploads + 1) * 15 * 1024 * 1024 > 5 * 1024 ** 3 ||
      accountBytes + (uploads + 1) * 15 * 1024 * 1024 > 500 * 1024 ** 2
    )
      throw new HttpError(413, "Storage quota reached");
    uploads++;
    const id = randomUUID();
    const originalPath = join(directory, "originals", id);
    const previewPath = join(directory, "previews", `${id}.jpg`);
    try {
      const part = await req.file();
      if (!part) throw new HttpError(400, "Choose a file to upload");
      const bytes = await part.toBuffer();
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
      const sourceMime = sourceType(bytes);
      let result: Awaited<ReturnType<typeof createPreview>>;
      try {
        result =
          !clean || sourceMime
            ? {
                mime: sourceMime ?? "application/octet-stream",
                preview: await sourcePlaceholder(),
                previewMime: "image/jpeg",
              }
            : await (options.preview ?? createPreview)(bytes);
      } catch (error) {
        if (error instanceof CloudinaryPreviewError) throw error;
        throw new HttpError(
          400,
          "Use a supported image, PDF, MP4, PSD, Blender or ZIP file",
        );
      }
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
        previewMime: result.previewMime,
        scan: clean ? "clean" : "quarantined",
        approved: false,
        suppliedPreviewRequired: Boolean(sourceMime),
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
  app.post("/api/handoffs/:id/files/:fileId/preview", async (req) => {
    const h = owned(req, true);
    const { fileId } = z
      .object({ fileId: z.string().uuid() })
      .parse(req.params);
    if (!h.files.some((f) => f.id === fileId))
      throw new HttpError(404, "File not found");
    if (uploads >= 2) throw new HttpError(429, "Processing is busy");
    uploads++;
    const temporary = join(directory, `preview-upload-${randomUUID()}`);
    try {
      const part = await req.file();
      if (!part) throw new HttpError(400, "Choose an image or PDF preview");
      const bytes = await part.toBuffer();
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      if (!(await (options.scan ?? scanFile)(temporary)))
        throw new HttpError(409, "Preview did not pass malware screening");
      const result = await (options.preview ?? createPreview)(bytes);
      if (
        !result.mime.startsWith("image/") &&
        result.mime !== "application/pdf"
      )
        throw new HttpError(400, "Use an image or PDF preview");
      const current = owned(req, true);
      const file = current.files.find((f) => f.id === fileId);
      if (!file) throw new HttpError(404, "File not found");
      await writeFile(
        join(directory, "previews", `${fileId}.jpg`),
        result.preview,
        { mode: 0o600 },
      );
      const latest = owned(req, true);
      const target = latest.files.find((f) => f.id === fileId);
      if (!target) throw new HttpError(409, "File changed during processing");
      target.previewSha256 = hash(result.preview);
      target.previewMime = result.previewMime;
      target.suppliedPreviewRequired = false;
      target.approved = false;
      store.save(latest);
      return { handoff: latest };
    } finally {
      uploads--;
      await rm(temporary, { force: true });
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
      const originalPath = join(directory, "originals", fileId);
      const clean = await (options.scan ?? scanFile)(originalPath);
      let result: Awaited<ReturnType<typeof createPreview>> | undefined;
      let sourceMime: string | undefined;
      if (clean) {
        const bytes = await readFile(originalPath);
        const current = owned(req, true).files.find(
          (file) => file.id === fileId,
        );
        if (!current || hash(bytes) !== current.sha256)
          throw new HttpError(409, "Original file changed during processing");
        sourceMime = sourceType(bytes);
        if (!sourceMime)
          result = await (options.preview ?? createPreview)(bytes);
      }
      if (result) {
        await writeFile(
          join(directory, "previews", `${fileId}.jpg`),
          result.preview,
          { mode: 0o600 },
        );
      }
      const handoff = owned(req, true);
      const file = handoff.files.find((file) => file.id === fileId);
      if (!file) throw new HttpError(404, "File not found");
      if (result) {
        file.previewSha256 = hash(result.preview);
        file.previewMime = result.previewMime;
        file.mime = result.mime;
      } else if (sourceMime) file.mime = sourceMime;
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
    if (
      handoff.files.some(
        (file) => file.scan !== "clean" || file.suppliedPreviewRequired,
      )
    )
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
    if (uploads > 0)
      throw new HttpError(
        409,
        "Wait for file processing to finish before publishing",
      );
    if (
      !handoff.files.length ||
      handoff.files.some(
        (file) =>
          !file.approved ||
          file.scan !== "clean" ||
          file.suppliedPreviewRequired,
      )
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
  function purchasedAccess(req: FastifyRequest, id: string) {
    const user = store.session(hash(req.cookies.handoff_session ?? ""));
    return Boolean(
      user &&
      store.db
        .prepare(
          "SELECT handoff FROM entitlements WHERE handoff=? AND wallet=? AND json_extract(data, '$.expiresAt')>? AND json_extract(data, '$.currency')=?",
        )
        .get(id, user.address, Date.now(), user.currency),
    );
  }
  app.get("/api/public/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const handoff = store.get(id);
    if (
      !handoff ||
      handoff.status === "draft" ||
      (Date.parse(handoff.deadline) <= Date.now() && !purchasedAccess(req, id))
    )
      throw new HttpError(404, "This handoff is unavailable or expired");
    const {
      clientLabel: _label,
      clientWallet: _wallet,
      ...publicData
    } = currentStatus(handoff);
    const user = store.session(hash(req.cookies.handoff_session ?? ""));
    const isApprovedClient = Boolean(
      user &&
      user.currency === handoff.currency &&
      user.address === handoff.clientWallet,
    );
    const isCreator = Boolean(
      user &&
      user.currency === handoff.currency &&
      user.address === handoff.creator,
    );
    return {
      handoff: {
        ...publicData,
        access: {
          isCreator,
          isApprovedClient,
          requested: Boolean(
            user &&
            user.currency === handoff.currency &&
            store.db
              .prepare(
                "SELECT wallet FROM requests WHERE handoff=? AND wallet=?",
              )
              .get(id, user.address),
          ),
          canCheckout:
            isApprovedClient &&
            !user?.scope &&
            paymentCapabilities[handoff.currency].enabled &&
            ["ready", "payment-pending"].includes(publicData.status) &&
            Date.parse(handoff.deadline) > Date.now(),
        },
        checkoutEnabled: Boolean(paymentCapabilities[handoff.currency].enabled),
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
        (Date.parse(handoff.deadline) <= Date.now() &&
          !purchasedAccess(req, id)))
    )
      throw new HttpError(404, "Preview not found");
    return reply
      .type(file.previewMime ?? "image/jpeg")
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
    if (
      count.n >= 20 &&
      !store.db
        .prepare("SELECT wallet FROM requests WHERE handoff=? AND wallet=?")
        .get(id, user.address)
    )
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
  const paymentService = payments(
    app,
    store,
    directory,
    session,
    options.sandbox ? { USDT: sandboxAdapter(store) } : options.payments,
  );
  if (options.sandbox) sandboxRoutes(app, store, origin);
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS deletions (handoff TEXT PRIMARY KEY, at INTEGER NOT NULL)",
  );
  let maintenance: Promise<void> | undefined;
  let maintenanceHealthy = true;
  const sweep = () => {
    if (!maintenance && uploads === 0)
      maintenance = retain(store, directory)
        .then(() => {
          maintenanceHealthy = true;
        })
        .catch((error) => {
          maintenanceHealthy = false;
          app.log.error(error);
        })
        .finally(() => {
          maintenance = undefined;
        });
  };
  const retentionTimer = setInterval(sweep, 3600_000);
  retentionTimer.unref();
  app.addHook("onReady", async () => {
    sweep();
    await maintenance;
  });
  app.get(
    "/api/ready",
    { config: { rateLimit: false } },
    async (_req, reply) => {
      let dependencies: Record<string, boolean> = {};
      try {
        dependencies = options.readiness ? await options.readiness() : {};
        store.db.prepare("SELECT 1").get();
      } catch {
        dependencies.storage = false;
      }
      const checks = {
        storage: true,
        retention: maintenanceHealthy,
        payments: paymentService.healthy(),
        ...dependencies,
      };
      const ok = Object.values(checks).every(Boolean);
      return reply.code(ok ? 200 : 503).send({ ok, checks });
    },
  );
  app.addHook("onClose", async () => {
    clearInterval(retentionTimer);
    await maintenance;
  });
  return app;
}
