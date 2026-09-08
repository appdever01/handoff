import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  rename,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import type { PreviewResult } from "./processing-client.ts";

export type CloudinaryConfiguration = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  cleanupDirectory: string;
};
type Resource = "image" | "video";
type PreviewStage =
  | "input"
  | "journal"
  | "upload"
  | "transform"
  | "url"
  | "download"
  | "validate"
  | "cleanup";
type PreviewCode =
  | "unsupported_input"
  | "input_limit"
  | "busy"
  | "http_failure"
  | "response_limit"
  | "api_response"
  | "upload_response"
  | "source_limit"
  | "page_count"
  | "incomplete"
  | "url_missing"
  | "url_mismatch"
  | "url_unsigned"
  | "url_transform"
  | "output_type"
  | "output_limit"
  | "processing_failed"
  | "cleanup_failed";
export class CloudinaryPreviewError extends Error {
  readonly statusCode: number;
  readonly diagnostic: {
    stage: PreviewStage;
    code: PreviewCode;
    httpStatus?: number;
  };
  constructor(stage: PreviewStage, code: PreviewCode, httpStatus?: number) {
    const invalid =
      [
        "unsupported_input",
        "input_limit",
        "source_limit",
        "page_count",
      ].includes(code) ||
      (stage === "upload" && [400, 413, 415, 422].includes(httpStatus ?? 0));
    super(
      invalid
        ? "Use a valid supported image, PDF or MP4 within the upload limits."
        : "Preview processing is temporarily unavailable. Please try again shortly.",
    );
    this.name = "CloudinaryPreviewError";
    this.statusCode = invalid ? 400 : 503;
    this.diagnostic = {
      stage,
      code,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    };
  }
}
class CloudinaryValidationError extends Error {
  constructor(readonly code: PreviewCode) {
    super("Cloudinary response validation failed");
  }
}
type Ticket = {
  publicId: string;
  resource: Resource;
  createdAt: number;
  confirmed: boolean;
};
const active = new Set<string>();
const inputLimit = 15 * 1024 * 1024;
const outputLimit = 5_000_000;
const idPattern = /^handoff-preview\/[a-f0-9-]{36}$/;
const pingCache = new WeakMap<
  CloudinaryConfiguration,
  {
    transport: typeof fetch;
    credentials: string;
    healthy: boolean;
    expires: number;
    pending?: Promise<boolean>;
  }
>();
class CloudinaryHttpError extends Error {
  constructor(readonly status: number) {
    super("Cloudinary request failed");
  }
}

export function cloudinaryConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): CloudinaryConfiguration {
  let cloudName = env.CLOUDINARY_CLOUD_NAME ?? "";
  let apiKey = env.CLOUDINARY_API_KEY ?? "";
  let apiSecret = env.CLOUDINARY_API_SECRET ?? "";
  if (env.CLOUDINARY_URL) {
    if (cloudName || apiKey || apiSecret)
      throw new Error("Configure one Cloudinary credential source");
    let url: URL;
    try {
      url = new URL(env.CLOUDINARY_URL);
    } catch {
      throw new Error("Invalid Cloudinary credentials");
    }
    if (
      url.protocol !== "cloudinary:" ||
      url.port ||
      url.search ||
      url.hash ||
      (url.pathname && url.pathname !== "/")
    )
      throw new Error("Invalid Cloudinary credentials");
    cloudName = url.hostname;
    apiKey = decodeURIComponent(url.username);
    apiSecret = decodeURIComponent(url.password);
  }
  if (
    !/^[a-z0-9][a-z0-9_-]{1,62}$/.test(cloudName) ||
    !/^\d{5,64}$/.test(apiKey) ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(apiSecret)
  )
    throw new Error(
      "Cloudinary cloud name, API key and API secret are required",
    );
  return {
    cloudName,
    apiKey,
    apiSecret,
    cleanupDirectory: join(
      resolve(env.DATA_DIR ?? ".data"),
      ".cloudinary-pending",
    ),
  };
}

function verifiedConfiguration(config: CloudinaryConfiguration) {
  const verified = cloudinaryConfiguration({
    CLOUDINARY_CLOUD_NAME: config.cloudName,
    CLOUDINARY_API_KEY: config.apiKey,
    CLOUDINARY_API_SECRET: config.apiSecret,
  });
  return { ...verified, cleanupDirectory: resolve(config.cleanupDirectory) };
}

async function boundedBytes(response: Response, maximum: number) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new CloudinaryHttpError(response.status);
  }
  const length = response.headers.get("content-length");
  if (
    !response.body ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum))
  ) {
    await response.body?.cancel();
    throw new CloudinaryValidationError("response_limit");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > maximum) throw new CloudinaryValidationError("response_limit");
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function cloudApi(config: CloudinaryConfiguration, transport: typeof fetch) {
  const authorization = `Basic ${Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString("base64")}`;
  return async (
    path: string,
    form?: FormData | URLSearchParams,
    signal = AbortSignal.timeout(7000),
  ): Promise<Record<string, unknown>> => {
    const response = await transport(
      `https://api.cloudinary.com/v1_1/${config.cloudName}/${path}`,
      {
        method: form ? "POST" : "GET",
        headers: { Authorization: authorization },
        body: form,
        redirect: "error",
        signal,
      },
    );
    const bytes = await boundedBytes(response, 256_000);
    if (!response.headers.get("content-type")?.startsWith("application/json"))
      throw new CloudinaryValidationError("api_response");
    const data = JSON.parse(bytes.toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data) || data.error)
      throw new CloudinaryValidationError("api_response");
    return data;
  };
}

function ticketPath(config: CloudinaryConfiguration, ticket: Ticket) {
  return join(
    config.cleanupDirectory,
    `${config.cloudName}-${ticket.publicId.split("/")[1]}.json`,
  );
}

async function destroy(
  config: CloudinaryConfiguration,
  ticket: Ticket,
  transport: typeof fetch,
  signal = AbortSignal.timeout(7000),
) {
  const result = await cloudApi(config, transport)(
    `${ticket.resource}/destroy`,
    new URLSearchParams({
      public_id: ticket.publicId,
      type: "authenticated",
      invalidate: "true",
    }),
    signal,
  );
  if (
    result.result !== "ok" &&
    !(ticket.confirmed && result.result === "not found")
  )
    throw new Error("Cloudinary temporary asset cleanup is not confirmed");
  await rm(ticketPath(config, ticket), { force: true });
}

async function recoverCleanup(
  config: CloudinaryConfiguration,
  transport: typeof fetch,
  signal: AbortSignal,
) {
  let files: string[];
  try {
    files = await readdir(config.cleanupDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const tickets = files.filter(
    (file) => file.startsWith(`${config.cloudName}-`) && file.endsWith(".json"),
  );
  if (tickets.length > 100) return false;
  let healthy = true;
  for (const name of tickets.slice(0, 5)) {
    const path = join(config.cleanupDirectory, name);
    if (active.has(path)) continue;
    let ticket: Ticket;
    try {
      ticket = JSON.parse(await readFile(path, "utf8"));
      if (
        !idPattern.test(ticket.publicId) ||
        !["image", "video"].includes(ticket.resource) ||
        typeof ticket.confirmed !== "boolean" ||
        !Number.isSafeInteger(ticket.createdAt) ||
        ticketPath(config, ticket) !== path
      )
        throw new Error("Invalid cleanup ticket");
      if (Date.now() - ticket.createdAt < 120_000) {
        healthy = false;
        continue;
      }
      await destroy(config, ticket, transport, signal);
    } catch {
      healthy = false;
    }
  }
  return healthy && tickets.length <= 5;
}

export async function cloudinaryStatus(
  configuration: CloudinaryConfiguration,
  transport: typeof fetch = fetch,
) {
  try {
    const config = verifiedConfiguration(configuration);
    const credentials = JSON.stringify([
      config.cloudName,
      config.apiKey,
      config.apiSecret,
    ]);
    let cached = pingCache.get(configuration);
    if (cached?.transport !== transport || cached.credentials !== credentials) {
      cached = { transport, credentials, healthy: false, expires: 0 };
      pingCache.set(configuration, cached);
    }
    if (cached.expires <= Date.now() && !cached.pending) {
      const entry = cached;
      entry.pending = (async () => {
        try {
          const result = await cloudApi(config, transport)("ping");
          entry.healthy = result.status === "ok";
        } catch {
          entry.healthy = false;
        }
        entry.expires = Date.now() + (entry.healthy ? 300_000 : 30_000);
        return entry.healthy;
      })();
    }
    if (cached.pending) {
      await cached.pending;
      cached.pending = undefined;
    }
    if (!cached.healthy) return false;
    const signal = AbortSignal.timeout(7000);
    return await recoverCleanup(config, transport, signal);
  } catch {
    return false;
  }
}

function detect(bytes: Buffer) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { mime: "image/png", format: "png", resource: "image" as const };
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
    return { mime: "image/jpeg", format: "jpg", resource: "image" as const };
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return { mime: "image/webp", format: "webp", resource: "image" as const };
  if (bytes.subarray(0, 5).toString() === "%PDF-")
    return {
      mime: "application/pdf",
      format: "pdf",
      resource: "image" as const,
    };
  if (bytes.subarray(4, 8).toString() === "ftyp")
    return { mime: "video/mp4", format: "mp4", resource: "video" as const };
  throw new CloudinaryPreviewError("input", "unsupported_input");
}

function watermark() {
  return ["north", "center", "south"]
    .map(
      (gravity) =>
        `l_text:Arial_28_bold:HANDOFF%20PREVIEW,co_white,b_rgb:333333,o_70/c_limit,w_0.8,fl_relative/fl_layer_apply,g_${gravity}`,
    )
    .join("/");
}

function previewTransformation(format: string, page: number) {
  if (format === "mp4")
    return `so_0,du_12,fps_4,c_limit,h_480,w_640/${watermark()}/f_gif`;
  const size =
    format === "pdf"
      ? `pg_${page},c_limit,h_900,w_700`
      : "c_limit,h_1400,w_1400";
  return `${size}/${watermark()}/f_jpg,q_78`;
}

function derivativeUrl(
  config: CloudinaryConfiguration,
  value: unknown,
  ticket: Ticket,
  version: number,
  transformation: string,
  extension: string,
) {
  if (typeof value !== "string")
    throw new CloudinaryValidationError("url_missing");
  const url = new URL(value);
  const prefix = `/${config.cloudName}/${ticket.resource}/authenticated/`;
  const tail = `/v${version}/${ticket.publicId}.${extension}`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "res.cloudinary.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(prefix) ||
    !url.pathname.endsWith(tail)
  )
    throw new CloudinaryValidationError("url_mismatch");
  const middle = url.pathname.slice(prefix.length, -tail.length);
  if (!/^s--[A-Za-z0-9_-]{8,32}--\//.test(middle))
    throw new CloudinaryValidationError("url_unsigned");
  const actualTransformation = middle.replace(
    /^s--[A-Za-z0-9_-]{8,32}--\//,
    "",
  );
  const canonical = (value: string) =>
    decodeURIComponent(value)
      .split("/")
      .map((component) => component.split(",").sort().join(","))
      .join("/");
  if (canonical(actualTransformation) !== canonical(transformation))
    throw new CloudinaryValidationError("url_transform");
  return url.href;
}

export function createCloudinaryPreview(
  configuration: CloudinaryConfiguration,
  transport: typeof fetch = fetch,
) {
  const config = verifiedConfiguration(configuration);
  const api = cloudApi(config, transport);
  let running = 0;
  return async (bytes: Buffer): Promise<PreviewResult> => {
    if (!bytes.length || bytes.length > inputLimit)
      throw new CloudinaryPreviewError("input", "input_limit");
    const source = detect(bytes);
    if (running >= 2) throw new CloudinaryPreviewError("input", "busy");
    running++;
    const ticket: Ticket = {
      publicId: `handoff-preview/${randomUUID()}`,
      resource: source.resource,
      createdAt: Date.now(),
      confirmed: false,
    };
    const path = ticketPath(config, ticket);
    active.add(path);
    let created = false;
    let stage: PreviewStage = "journal";
    try {
      await mkdir(config.cleanupDirectory, { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify(ticket), {
        flag: "wx",
        mode: 0o600,
      });
      created = true;
      const signal = AbortSignal.timeout(50_000);
      const upload = new FormData();
      upload.set(
        "file",
        new Blob([new Uint8Array(bytes)], { type: source.mime }),
        `preview.${source.format}`,
      );
      for (const [key, value] of Object.entries({
        public_id: ticket.publicId,
        type: "authenticated",
        overwrite: "false",
        backup: "false",
        allowed_formats: source.format,
        async: "false",
        use_filename: "false",
        unique_filename: "false",
        tags: "handoff-temporary-preview",
      }))
        upload.set(key, value);
      stage = "upload";
      let uploaded: Record<string, unknown>;
      try {
        uploaded = await api(`${source.resource}/upload`, upload, signal);
      } catch (error) {
        if (
          error instanceof CloudinaryHttpError &&
          [400, 413, 415, 422].includes(error.status)
        ) {
          ticket.confirmed = true;
          const updated = `${path}.next`;
          await writeFile(updated, JSON.stringify(ticket), {
            flag: "wx",
            mode: 0o600,
          });
          await rename(updated, path);
        }
        throw error;
      }
      ticket.confirmed = true;
      const updated = `${path}.next`;
      await writeFile(updated, JSON.stringify(ticket), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(updated, path);
      if (
        uploaded.public_id !== ticket.publicId ||
        uploaded.type !== "authenticated" ||
        uploaded.resource_type !== source.resource ||
        uploaded.format !== source.format ||
        !Number.isSafeInteger(uploaded.version)
      )
        throw new CloudinaryValidationError("upload_response");
      const width = Number(uploaded.width),
        height = Number(uploaded.height);
      if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 1 ||
        height < 1 ||
        width * height > 24_000_000
      )
        throw new CloudinaryValidationError("source_limit");
      if (
        !["pdf", "mp4"].includes(source.format) &&
        uploaded.pages !== undefined &&
        uploaded.pages !== 1
      )
        throw new CloudinaryValidationError("unsupported_input");
      const pages =
        source.format === "pdf" ? Math.min(3, Number(uploaded.pages)) : 1;
      if (!Number.isSafeInteger(pages) || pages < 1)
        throw new CloudinaryValidationError("page_count");
      const transformations = Array.from({ length: pages }, (_, index) =>
        previewTransformation(source.format, index + 1),
      );
      stage = "transform";
      const explicit = await api(
        `${source.resource}/explicit`,
        new URLSearchParams({
          public_id: ticket.publicId,
          type: "authenticated",
          eager: transformations
            .map(
              (value) => `${value}/${source.format === "mp4" ? "gif" : "jpg"}`,
            )
            .join("|"),
          eager_async: "false",
          async: "false",
        }),
        signal,
      );
      if (!Array.isArray(explicit.eager) || explicit.eager.length !== pages)
        throw new CloudinaryValidationError("incomplete");
      const previews: Buffer[] = [];
      const extension = source.format === "mp4" ? "gif" : "jpg";
      for (let index = 0; index < pages; index++) {
        const item = explicit.eager[index] as Record<string, unknown>;
        stage = "url";
        const url = derivativeUrl(
          config,
          item.secure_url,
          ticket,
          Number(uploaded.version),
          transformations[index],
          extension,
        );
        stage = "download";
        const response = await transport(url, { redirect: "error", signal });
        if (
          !response.headers
            .get("content-type")
            ?.startsWith(extension === "gif" ? "image/gif" : "image/jpeg")
        ) {
          await response.body?.cancel();
          throw new CloudinaryValidationError("output_type");
        }
        const data = await boundedBytes(response, outputLimit);
        stage = "validate";
        const metadata = await sharp(data, {
          animated: extension === "gif",
          limitInputPixels: 16_000_000,
          failOn: "warning",
        }).metadata();
        const maxWidth =
          source.format === "mp4" ? 640 : source.format === "pdf" ? 700 : 1400;
        const maxHeight =
          source.format === "mp4" ? 480 : source.format === "pdf" ? 900 : 1400;
        if (
          metadata.format !== (extension === "gif" ? "gif" : "jpeg") ||
          !metadata.width ||
          !metadata.height ||
          metadata.width > maxWidth ||
          (metadata.pageHeight ?? metadata.height) > maxHeight ||
          (metadata.pages ?? 1) > (extension === "gif" ? 48 : 1) ||
          (metadata.delay?.reduce((total, delay) => total + delay, 0) ?? 0) >
            12_000
        )
          throw new CloudinaryValidationError("output_limit");
        previews.push(data);
      }
      let preview = previews[0];
      if (source.format === "pdf") {
        const padded = await Promise.all(
          previews.map((page) =>
            sharp(page, { limitInputPixels: 700 * 900 })
              .resize(700, 900, { fit: "contain", background: "white" })
              .toBuffer(),
          ),
        );
        preview = await sharp({
          create: {
            width: 700 * pages,
            height: 900,
            channels: 3,
            background: "white",
          },
        })
          .composite(
            padded.map((input, index) => ({
              input,
              left: 700 * index,
              top: 0,
            })),
          )
          .jpeg({ quality: 78 })
          .toBuffer();
      }
      if (preview.length > outputLimit)
        throw new CloudinaryValidationError("output_limit");
      return {
        preview,
        mime: source.mime,
        previewMime: extension === "gif" ? "image/gif" : "image/jpeg",
      };
    } catch (error) {
      if (error instanceof CloudinaryPreviewError) throw error;
      throw new CloudinaryPreviewError(
        stage,
        error instanceof CloudinaryHttpError
          ? "http_failure"
          : error instanceof CloudinaryValidationError
            ? error.code
            : "processing_failed",
        error instanceof CloudinaryHttpError ? error.status : undefined,
      );
    } finally {
      try {
        if (created) await destroy(config, ticket, transport);
      } catch (error) {
        throw new CloudinaryPreviewError(
          "cleanup",
          "cleanup_failed",
          error instanceof CloudinaryHttpError ? error.status : undefined,
        );
      } finally {
        active.delete(path);
        running--;
      }
    }
  };
}
