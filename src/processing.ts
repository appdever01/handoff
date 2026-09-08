import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { isIP } from "node:net";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";

export function scannerConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const host = env.CLAMAV_HOST ?? "127.0.0.1";
  const port = Number(env.CLAMAV_PORT ?? 3310);
  if (
    (!isIP(host) &&
      !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("Invalid private ClamAV host or port");
  return { host, port };
}

export async function scannerStatus(
  configuration = scannerConfiguration(),
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect(configuration);
    let response = "";
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(value);
    };
    const deadline = setTimeout(() => finish(false), 3000);
    socket.setTimeout(3000, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("end", () => finish(false));
    socket.on("connect", () => socket.write("zVERSION\0"));
    socket.on("data", (data) => {
      response += data.toString();
      if (response.length > 4096) return finish(false);
      if (response.includes("\0")) {
        const stamp = Date.parse(
          response.replace(/\0/g, "").trim().split("/")[2] ?? "",
        );
        finish(
          Number.isFinite(stamp) &&
            Date.now() - stamp >= 0 &&
            Date.now() - stamp <= 7 * 86400_000,
        );
      }
    });
  });
}

export async function scanDaemon(
  path: string,
  configuration = scannerConfiguration(),
): Promise<boolean> {
  if (!(await scannerStatus(configuration))) return false;
  const bytes = await readFile(path);
  if (!bytes.length || bytes.length > 15 * 1024 * 1024) return false;
  return new Promise((resolve) => {
    const socket = connect(configuration);
    let response = "";
    let settled = false;
    const finish = (clean: boolean) => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        socket.destroy();
        resolve(clean);
      }
    };
    const deadline = setTimeout(() => finish(false), 30_000);
    socket.setTimeout(30_000, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("data", (data) => {
      response += data.toString();
      if (response.length > 4096) finish(false);
      if (response.includes("\0"))
        finish(response.trim().replace(/\0/g, "") === "stream: OK");
    });
    socket.on("end", () => finish(false));
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        const chunk = bytes.subarray(offset, offset + 65536);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}
export function mediaImage(env: NodeJS.ProcessEnv = process.env) {
  const image = env.HANDOFF_MEDIA_IMAGE ?? "handoff-media:local";
  if (image.length > 255 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(image))
    throw new Error("Invalid isolated media image");
  return image;
}

let isolatedProcessingHealthy = true;

export async function previewWorkerStatus(): Promise<boolean> {
  if (!isolatedProcessingHealthy) return false;
  try {
    const { stdout } = await promisify(execFile)(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", mediaImage()],
      { timeout: 5000, maxBuffer: 4096 },
    );
    return /^sha256:[a-f0-9]{64}$/.test(stdout.trim());
  } catch {
    return false;
  }
}

export function isolatedPreview(
  bytes: Buffer,
  options: { signal?: AbortSignal } = {},
): Promise<{ preview: Buffer; mime: string; previewMime: string }> {
  if (!isolatedProcessingHealthy)
    return Promise.reject(
      new Error("Preview cleanup requires operator attention"),
    );
  if (!bytes.length || bytes.length > 15 * 1024 * 1024)
    return Promise.reject(new Error("Preview input exceeds size limit"));
  if (options.signal?.aborted)
    return Promise.reject(new Error("Preview processing cancelled"));
  const image = mediaImage();
  return new Promise((resolve, reject) => {
    const name = `handoff-preview-${randomUUID()}`;
    const cleanup = () =>
      promisify(execFile)("docker", ["rm", "-f", name], {
        timeout: 5000,
        maxBuffer: 4096,
      }).catch((error: { stderr?: string }) => {
        if (!/No such container|No such object/.test(error.stderr ?? ""))
          isolatedProcessingHealthy = false;
      });
    const child = spawn(
      "docker",
      [
        "run",
        "--name",
        name,
        "--rm",
        "-i",
        "--network=none",
        "--read-only",
        "--user=1000:1000",
        "--memory=512m",
        "--cpus=1",
        "--pids-limit=64",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        image,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let settled = false;
    const finish = (
      error?: Error,
      result?: { preview: Buffer; mime: string; previewMime: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result!);
    };
    let stopping = false;
    const stop = (message: string) => {
      if (settled || stopping) return;
      stopping = true;
      child.kill("SIGKILL");
      void cleanup().finally(() => finish(new Error(message)));
    };
    const abort = () => stop("Preview processing cancelled");
    const timer = setTimeout(
      () => stop("Preview processing timed out"),
      45_000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 8_000_000) stop("Preview output exceeds size limit");
    });
    child.stderr.resume();
    child.on("error", () =>
      finish(new Error("Isolated preview could not start")),
    );
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      if (settled || stopping) return;
      if (code !== 0) return finish(new Error("Isolated preview failed"));
      try {
        const result = JSON.parse(output);
        if (
          typeof result.preview !== "string" ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(result.preview) ||
          result.preview.length % 4 !== 0
        )
          throw new Error("Invalid preview response");
        const preview = Buffer.from(result.preview, "base64");
        if (
          !preview.length ||
          preview.length > 5_000_000 ||
          ![
            "image/jpeg",
            "image/png",
            "image/webp",
            "application/pdf",
            "video/mp4",
          ].includes(result.mime) ||
          !["image/jpeg", "image/gif"].includes(result.previewMime)
        )
          throw new Error("Invalid preview response");
        finish(undefined, {
          preview,
          mime: result.mime,
          previewMime: result.previewMime,
        });
      } catch {
        finish(new Error("Invalid preview response"));
      }
    });
    child.stdin.end(bytes);
  });
}
