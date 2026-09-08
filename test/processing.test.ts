import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { buildProcessingService } from "../src/processing-service.ts";
import {
  createRemotePreview,
  checkPreviewWorker,
  workerSecretFromEnvironment,
  workerUrl,
  validatePreviewResponse,
  previewInputLimit,
  previewResponseLimit,
} from "../src/processing-client.ts";
import {
  isolatedPreview,
  mediaImage,
  scannerConfiguration,
  scannerStatus,
  scanDaemon,
} from "../src/processing.ts";

const secret = "a".repeat(64);
const headers = {
  authorization: `Bearer ${secret}`,
  "content-type": "application/octet-stream",
};
const result = {
  preview: Buffer.from("watermarked preview"),
  mime: "image/png",
  previewMime: "image/jpeg",
};

test("worker requires constant secret authentication before health checks or file processing", async () => {
  let calls = 0;
  const app = await buildProcessingService({
    secret,
    ready: async () => {
      calls++;
      return true;
    },
    preview: async () => {
      calls++;
      return result;
    },
  });
  try {
    for (const authorization of [
      undefined,
      "Bearer wrong",
      `Basic ${secret}`,
      `Bearer ${"z".repeat(10000)}`,
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/preview",
        headers: {
          ...(authorization ? { authorization } : {}),
          "content-type": "application/octet-stream",
        },
        payload: Buffer.from("private"),
      });
      assert.equal(response.statusCode, 401);
    }
    assert.equal((await app.inject("/ready")).statusCode, 401);
    assert.equal(calls, 0);
    assert.equal(
      (await app.inject({ url: "/ready", headers })).statusCode,
      200,
    );
    assert.equal(calls, 1);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/run",
          headers,
          payload: Buffer.from("command"),
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});

test("worker accepts only bounded file bytes and returns bounded preview metadata", async () => {
  const app = await buildProcessingService({
    secret,
    preview: async (bytes) => {
      assert.deepEqual(bytes, Buffer.from("private"));
      return result;
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/preview",
      headers,
      payload: Buffer.from("private"),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(validatePreviewResponse(response.json()), result);
    for (const payload of [
      Buffer.alloc(0),
      Buffer.alloc(previewInputLimit + 1),
    ]) {
      const rejected = await app.inject({
        method: "POST",
        url: "/preview",
        headers,
        payload,
      });
      assert.ok([400, 413].includes(rejected.statusCode));
    }
    const arbitrary = await app.inject({
      method: "POST",
      url: "/preview",
      headers: { authorization: headers.authorization },
      payload: { path: "/private/original", command: "cat" },
    });
    assert.equal(arbitrary.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("worker limits processing to two jobs and retains slots until timed-out jobs actually stop", async () => {
  let started = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalCount = 0;
  const app = await buildProcessingService({
    secret,
    timeoutMs: 25,
    preview: async (_bytes, { signal }) => {
      started++;
      signal.addEventListener("abort", () => signalCount++);
      await pending;
      return result;
    },
  });
  try {
    const request = () =>
      app.inject({
        method: "POST",
        url: "/preview",
        headers,
        payload: Buffer.from("private"),
      });
    const first = request();
    const second = request();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await request()).statusCode, 429);
    assert.equal((await first).statusCode, 504);
    assert.equal((await second).statusCode, 504);
    assert.equal(signalCount, 2);
    assert.equal((await request()).statusCode, 429);
    assert.equal(started, 2);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await request()).statusCode, 200);
  } finally {
    release();
    await app.close();
  }
});

test("worker readiness fails closed and parser errors do not reveal host details", async () => {
  const app = await buildProcessingService({
    secret,
    ready: async () => false,
    preview: async () => {
      throw new Error("sensitive /host/path");
    },
  });
  try {
    assert.equal(
      (await app.inject({ url: "/health", headers })).statusCode,
      503,
    );
    const response = await app.inject({
      method: "POST",
      url: "/preview",
      headers,
      payload: Buffer.from("private"),
    });
    assert.equal(response.statusCode, 422);
    assert.ok(!response.body.includes("/host/path"));
  } finally {
    await app.close();
  }
});

test("remote preview client sends fixed authenticated operation and validates returned bytes", async () => {
  const app = await buildProcessingService({
    secret,
    ready: async () => true,
    preview: async () => result,
  });
  const transport: typeof fetch = async (url, init) => {
    assert.ok(
      ["http://worker:4004/preview", "http://worker:4004/ready"].includes(
        String(url),
      ),
    );
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const response = await app.inject({
      method: init?.method === "POST" ? "POST" : "GET",
      url: new URL(String(url)).pathname,
      headers: init?.headers as Record<string, string>,
      ...(init?.body ? { payload: Buffer.from(init.body as Uint8Array) } : {}),
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: response.headers as Record<string, string>,
    });
  };
  try {
    const config = { url: "http://worker:4004", secret };
    assert.deepEqual(
      await createRemotePreview(config, transport)(Buffer.from("private")),
      result,
    );
    assert.equal(await checkPreviewWorker(config, transport), true);
    assert.equal(
      await checkPreviewWorker(
        { ...config, secret: "b".repeat(64) },
        transport,
      ),
      false,
    );
  } finally {
    await app.close();
  }
});

test("remote client rejects oversized, invalid and unauthenticated responses without leaking worker errors", async () => {
  const config = { url: "http://worker:4004", secret };
  for (const response of [
    new Response("sensitive worker path", { status: 500 }),
    new Response("not json", { headers: { "content-type": "text/plain" } }),
    new Response("x", {
      headers: {
        "content-type": "application/json",
        "content-length": String(previewResponseLimit + 1),
      },
    }),
    new Response(
      JSON.stringify({
        preview: "!!!",
        mime: "image/png",
        previewMime: "image/jpeg",
      }),
      { headers: { "content-type": "application/json" } },
    ),
    new Response(
      JSON.stringify({
        preview: "YQ==",
        mime: "image/png",
        previewMime: "text/html",
      }),
      { headers: { "content-type": "application/json" } },
    ),
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(previewResponseLimit + 1));
          controller.close();
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  ]) {
    await assert.rejects(
      createRemotePreview(config, async () => response)(Buffer.from("private")),
      (error: Error) => !error.message.includes("sensitive worker path"),
    );
  }
});

test("worker configuration refuses short secrets, credentials, command arguments and invalid scanner targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "handoff-secret-"));
  try {
    const path = join(directory, "secret");
    await writeFile(path, secret + "\n", { mode: 0o600 });
    assert.equal(
      await workerSecretFromEnvironment({ PREVIEW_WORKER_SECRET_FILE: path }),
      secret,
    );
    await assert.rejects(
      workerSecretFromEnvironment({ PREVIEW_WORKER_SECRET: "short" }),
    );
    await assert.rejects(
      workerSecretFromEnvironment({
        PREVIEW_WORKER_SECRET: secret,
        PREVIEW_WORKER_SECRET_FILE: path,
      }),
    );
    for (const url of [
      "file:///tmp",
      "http://name:password@worker",
      "http://worker/command",
      "http://worker?command=x",
    ])
      assert.throws(() => workerUrl(url));
    for (const env of [
      { HANDOFF_MEDIA_IMAGE: "--privileged" },
      { HANDOFF_MEDIA_IMAGE: "image --network=host" },
    ])
      assert.throws(() => mediaImage(env));
    assert.deepEqual(
      scannerConfiguration({ CLAMAV_HOST: "scanner", CLAMAV_PORT: "3310" }),
      { host: "scanner", port: 3310 },
    );
    assert.throws(() => scannerConfiguration({ CLAMAV_PORT: "0" }));
    assert.throws(() =>
      scannerConfiguration({ CLAMAV_HOST: "http://scanner" }),
    );
    await assert.rejects(isolatedPreview(Buffer.alloc(0)));
    await assert.rejects(
      isolatedPreview(Buffer.from("private"), { signal: AbortSignal.abort() }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private scanner endpoint requires fresh definitions and clean INSTREAM results", async () => {
  let version = `ClamAV 1.4/100/${new Date(Date.now() - 1000).toUTCString()}\0`;
  let clean = true;
  let received = Buffer.alloc(0);
  const server = createServer((socket) => {
    let input = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      input = Buffer.concat([input, chunk]);
      if (input.subarray(0, 9).toString() === "zVERSION\0") {
        socket.end(version);
        return;
      }
      if (input.subarray(0, 10).toString() !== "zINSTREAM\0") return;
      let cursor = 10;
      const chunks: Buffer[] = [];
      while (cursor + 4 <= input.length) {
        const size = input.readUInt32BE(cursor);
        cursor += 4;
        if (!size) {
          received = Buffer.concat(chunks);
          socket.end(
            clean ? "stream: OK\0" : "stream: Eicar-Test-Signature FOUND\0",
          );
          return;
        }
        if (cursor + size > input.length) return;
        chunks.push(input.subarray(cursor, cursor + size));
        cursor += size;
      }
    });
  });
  const directory = await mkdtemp(join(tmpdir(), "handoff-scanner-"));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const configuration = { host: "127.0.0.1", port: address.port };
    const path = join(directory, "original");
    const bytes = Buffer.from("private file bytes");
    await writeFile(path, bytes);
    assert.equal(await scannerStatus(configuration), true);
    assert.equal(await scanDaemon(path, configuration), true);
    assert.deepEqual(received, bytes);
    clean = false;
    assert.equal(await scanDaemon(path, configuration), false);
    version = `ClamAV 1.4/100/${new Date(Date.now() - 8 * 86400_000).toUTCString()}\0`;
    assert.equal(await scannerStatus(configuration), false);
    assert.equal(await scanDaemon(path, configuration), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("scanner version checks stop at their deadline even while bytes keep arriving", async () => {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    const timer = setInterval(() => socket.write("x"), 50);
    socket.on("close", () => {
      clearInterval(timer);
      sockets.delete(socket);
    });
    socket.on("error", () => {});
  });
  let fallback: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await Promise.race([
      scannerStatus({ host: "127.0.0.1", port: address.port }),
      new Promise<string>((resolve) => {
        fallback = setTimeout(() => resolve("unbounded"), 4500);
      }),
    ]);
    assert.equal(result, false);
  } finally {
    clearTimeout(fallback);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
