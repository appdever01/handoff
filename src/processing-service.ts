import Fastify, { type FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { isolatedPreview, previewWorkerStatus } from "./processing.ts";
import {
  previewInputLimit,
  validatePreviewResponse,
  validateWorkerSecret,
  type PreviewResult,
} from "./processing-client.ts";

export async function buildProcessingService(options: {
  secret: string;
  preview?: (
    bytes: Buffer,
    options: { signal: AbortSignal },
  ) => Promise<PreviewResult>;
  ready?: () => Promise<boolean>;
  timeoutMs?: number;
  logger?: boolean;
}) {
  const secret = createHash("sha256")
    .update(validateWorkerSecret(options.secret))
    .digest();
  const timeoutMs = options.timeoutMs ?? 55_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 55_000)
    throw new Error("Invalid preview worker timeout");
  const app = Fastify({
    bodyLimit: previewInputLimit,
    requestTimeout: 60_000,
    connectionTimeout: 65_000,
    logger: options.logger ? { redact: ["req.headers.authorization"] } : false,
  });
  const jobs = new Map<AbortController, Promise<unknown>>();
  const admitted = new Set<FastifyRequest>();
  const running = new Set<FastifyRequest>();
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff");
    const header = req.headers.authorization ?? "";
    const value =
      header.startsWith("Bearer ") && header.length <= 263
        ? header.slice(7)
        : "";
    if (!timingSafeEqual(createHash("sha256").update(value).digest(), secret))
      return reply.code(401).send({ error: "Worker authentication required" });
    if (req.method === "POST" && req.url.split("?")[0] === "/preview") {
      if (admitted.size >= 2)
        return reply.code(429).send({ error: "Preview processing is busy" });
      admitted.add(req);
    }
  });
  app.addHook("onResponse", async (req) => {
    if (!running.has(req)) admitted.delete(req);
  });
  app.addHook("onRequestAbort", async (req) => {
    if (!running.has(req)) admitted.delete(req);
  });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  app.setErrorHandler((error, _req, reply) => {
    const code = (error as { statusCode?: number }).statusCode ?? 500;
    reply.code(code).send({
      error:
        code >= 500
          ? "Preview processing unavailable"
          : code === 413
            ? "Preview input exceeds size limit"
            : "Invalid preview request",
    });
  });
  const ready = async (
    _req: unknown,
    reply: { code: (status: number) => unknown },
  ) => {
    const ok = await (options.ready ?? previewWorkerStatus)().catch(
      () => false,
    );
    if (!ok) reply.code(503);
    return { ok };
  };
  app.get("/health", ready);
  app.get("/ready", ready);
  app.post("/preview", async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length)
      return reply.code(400).send({ error: "A binary file is required" });
    if (jobs.size >= 2)
      return reply.code(429).send({ error: "Preview processing is busy" });
    const controller = new AbortController();
    const operation = Promise.resolve().then(() =>
      (options.preview ?? isolatedPreview)(req.body as Buffer, {
        signal: controller.signal,
      }),
    );
    jobs.set(controller, operation);
    running.add(req);
    void operation
      .finally(() => {
        jobs.delete(controller);
        running.delete(req);
        admitted.delete(req);
      })
      .catch(() => undefined);
    const disconnected = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    reply.raw.on("close", disconnected);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Preview processing timed out"));
          }, timeoutMs);
        }),
      ]);
      const validated = validatePreviewResponse({
        ...result,
        preview: result.preview.toString("base64"),
      });
      return { ...validated, preview: validated.preview.toString("base64") };
    } catch {
      return reply.code(controller.signal.aborted ? 504 : 422).send({
        error: controller.signal.aborted
          ? "Preview processing timed out"
          : "File could not be processed",
      });
    } finally {
      clearTimeout(timer);
      reply.raw.removeListener("close", disconnected);
    }
  });
  app.addHook("onClose", async () => {
    for (const controller of jobs.keys()) controller.abort();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(jobs.values()),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 6000);
      }),
    ]);
    clearTimeout(timer);
  });
  return app;
}
