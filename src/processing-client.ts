import { readFile, stat } from "node:fs/promises";
import { isolatedPreview } from "./processing.ts";

export type PreviewResult = {
  preview: Buffer;
  mime: string;
  previewMime: string;
};
export const previewInputLimit = 15 * 1024 * 1024;
export const previewOutputLimit = 5_000_000;
export const previewResponseLimit = 7_000_000;
export type PreviewWorkerConfiguration = { url: string; secret: string };

export function validateWorkerSecret(secret: string) {
  if (!/^[\x21-\x7e]{32,256}$/.test(secret))
    throw new Error(
      "Preview worker secret must contain 32 to 256 printable non-space characters",
    );
  return secret;
}

export async function workerSecretFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.PREVIEW_WORKER_SECRET && env.PREVIEW_WORKER_SECRET_FILE)
    throw new Error("Configure only one preview worker secret source");
  if (env.PREVIEW_WORKER_SECRET_FILE) {
    const file = await stat(env.PREVIEW_WORKER_SECRET_FILE);
    if (!file.isFile() || file.size > 512)
      throw new Error("Invalid preview worker secret file");
    return validateWorkerSecret(
      (await readFile(env.PREVIEW_WORKER_SECRET_FILE, "utf8")).trim(),
    );
  }
  return validateWorkerSecret(env.PREVIEW_WORKER_SECRET ?? "");
}

export function workerUrl(value: string) {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Preview worker URL must be an HTTP origin without credentials or a path",
    );
  return url.origin;
}

export async function workerConfigurationFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PreviewWorkerConfiguration> {
  return {
    url: workerUrl(env.PREVIEW_WORKER_URL ?? ""),
    secret: await workerSecretFromEnvironment(env),
  };
}

export function validatePreviewResponse(value: unknown): PreviewResult {
  if (!value || typeof value !== "object")
    throw new Error("Invalid preview worker response");
  const data = value as Record<string, unknown>;
  if (
    typeof data.preview !== "string" ||
    data.preview.length > previewResponseLimit ||
    data.preview.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data.preview) ||
    ![
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
      "video/mp4",
    ].includes(String(data.mime)) ||
    !["image/jpeg", "image/gif"].includes(String(data.previewMime))
  )
    throw new Error("Invalid preview worker response");
  const preview = Buffer.from(data.preview, "base64");
  if (
    !preview.length ||
    preview.length > previewOutputLimit ||
    preview.toString("base64") !== data.preview
  )
    throw new Error("Invalid preview worker response");
  return {
    preview,
    mime: String(data.mime),
    previewMime: String(data.previewMime),
  };
}

async function boundedResponse(response: Response, limit: number) {
  const length = response.headers.get("content-length");
  if (
    (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("Preview worker response exceeds size limit");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > limit)
        throw new Error("Preview worker response exceeds size limit");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createRemotePreview(
  configuration: PreviewWorkerConfiguration,
  transport: typeof fetch = fetch,
) {
  const url = workerUrl(configuration.url);
  const secret = validateWorkerSecret(configuration.secret);
  return async (bytes: Buffer): Promise<PreviewResult> => {
    if (!bytes.length || bytes.length > previewInputLimit)
      throw new Error("Preview input exceeds size limit");
    const response = await transport(`${url}/preview`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(bytes),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 429
          ? "Preview processing is busy"
          : "Preview worker is unavailable",
      );
    }
    if (!response.headers.get("content-type")?.startsWith("application/json")) {
      await response.body?.cancel();
      throw new Error("Invalid preview worker response");
    }
    return validatePreviewResponse(
      JSON.parse(await boundedResponse(response, previewResponseLimit)),
    );
  };
}

export async function checkPreviewWorker(
  configuration: PreviewWorkerConfiguration,
  transport: typeof fetch = fetch,
) {
  const url = workerUrl(configuration.url);
  const secret = validateWorkerSecret(configuration.secret);
  try {
    const response = await transport(`${url}/ready`, {
      headers: { Authorization: `Bearer ${secret}` },
      redirect: "error",
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    return JSON.parse(await boundedResponse(response, 1024)).ok === true;
  } catch {
    return false;
  }
}

export async function previewFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!env.PREVIEW_WORKER_URL) {
    if (env.PREVIEW_WORKER_SECRET || env.PREVIEW_WORKER_SECRET_FILE)
      throw new Error("Preview worker URL is required with a remote secret");
    return isolatedPreview;
  }
  return createRemotePreview(await workerConfigurationFromEnvironment(env));
}
