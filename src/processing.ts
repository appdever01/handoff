import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";

export async function scanDaemon(path: string): Promise<boolean> {
  const current = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: 3310 });
    let response = "";
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
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
  if (!current) return false;
  const bytes = await readFile(path);
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: 3310 });
    let response = "";
    let settled = false;
    const finish = (clean: boolean) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(clean);
      }
    };
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
export function isolatedPreview(
  bytes: Buffer,
): Promise<{ preview: Buffer; mime: string; previewMime: string }> {
  return new Promise((resolve, reject) => {
    const name = `handoff-preview-${randomUUID()}`;
    const cleanup = () => {
      const cleaner = spawn("docker", ["rm", "-f", name], { stdio: "ignore" });
      cleaner.on("error", () => {});
    };
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
        "--memory=512m",
        "--cpus=1",
        "--pids-limit=64",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "handoff-media:local",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let error = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error("Preview processing timed out"));
    }, 45_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 8_000_000) {
        child.kill("SIGKILL");
        cleanup();
      }
    });
    child.stderr.on("data", (chunk) => {
      if (error.length < 4096) error += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(new Error("Isolated preview failed: " + error));
      try {
        const result = JSON.parse(output);
        resolve({
          preview: Buffer.from(result.preview, "base64"),
          mime: result.mime,
          previewMime: result.previewMime ?? "image/jpeg",
        });
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.end(bytes);
  });
}
