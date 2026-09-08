import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.ts";
import { openStore } from "../src/store.ts";
import { hash } from "../src/auth.ts";
import {
  CloudinaryPreviewError,
  cloudinaryConfiguration,
  createCloudinaryPreview,
  cloudinaryStatus,
} from "../src/cloudinary.ts";

async function fixture(
  options: {
    format?: string;
    pages?: number;
    invalidUrl?: string;
    uploadError?: boolean;
    uploadStatus?: number;
    cleanupResult?: string;
    sourceWidth?: number;
    oversized?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "handoff-cloudinary-"));
  const config = cloudinaryConfiguration({
    CLOUDINARY_CLOUD_NAME: "test-cloud",
    CLOUDINARY_API_KEY: "123456789",
    CLOUDINARY_API_SECRET: "test-secret-value-not-real",
    DATA_DIR: directory,
  });
  const image = await sharp({
    create: { width: 320, height: 200, channels: 3, background: "#568" },
  })
    .png()
    .toBuffer();
  const jpeg = await sharp(image).jpeg().toBuffer();
  const gif = await sharp(image).gif({ delay: 250 }).toBuffer();
  const format = options.format ?? "png";
  const resource = format === "mp4" ? "video" : "image";
  let id = "";
  let version = 123;
  let cleanupResult = options.cleanupResult ?? "ok";
  const calls: { url: string; init?: RequestInit }[] = [];
  const transforms: string[] = [];
  let source: Buffer | undefined;
  const response = (data: unknown) =>
    new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
    });
  const transport: typeof fetch = async (target, init) => {
    const url = String(target);
    calls.push({ url, init });
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    if (url.startsWith("https://api.cloudinary.com/")) {
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        `Basic ${Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString("base64")}`,
      );
      if (url.endsWith("/ping")) return response({ status: "ok" });
      if (url.endsWith("/upload")) {
        assert.ok(init?.body instanceof FormData);
        const form = init.body;
        id = String(form.get("public_id"));
        assert.match(id, /^handoff-preview\/[a-f0-9-]{36}$/);
        assert.equal(form.get("type"), "authenticated");
        assert.equal(form.get("backup"), "false");
        assert.equal(form.get("overwrite"), "false");
        assert.equal(form.get("allowed_formats"), format);
        assert.equal(form.get("upload_preset"), null);
        source = Buffer.from(await (form.get("file") as Blob).arrayBuffer());
        if (options.uploadError)
          throw new Error("request with secret should not be exposed");
        if (options.uploadStatus)
          return new Response("Invalid media", {
            status: options.uploadStatus,
          });
        return response({
          public_id: id,
          version,
          type: "authenticated",
          resource_type: resource,
          format,
          width: options.sourceWidth ?? 320,
          height: 200,
          pages: options.pages ?? 1,
        });
      }
      assert.ok(init?.body instanceof URLSearchParams);
      const form = init.body;
      assert.equal(form.get("public_id"), id);
      assert.equal(form.get("type"), "authenticated");
      if (url.endsWith("/explicit")) {
        assert.equal(form.get("eager_async"), "false");
        transforms.push(
          ...String(form.get("eager"))
            .split("|")
            .map((value) => {
              const extension = format === "mp4" ? "gif" : "jpg";
              assert.ok(value.endsWith(`/${extension}`));
              return value.slice(0, -(extension.length + 1));
            }),
        );
        return response({
          eager: transforms.map((transformation) => ({
            transformation,
            secure_url:
              options.invalidUrl ??
              `https://res.cloudinary.com/${config.cloudName}/${resource}/authenticated/s--abcdefgh--/${transformation}/v${version}/${id}.${format === "mp4" ? "gif" : "jpg"}`,
          })),
        });
      }
      assert.ok(url.endsWith("/destroy"));
      assert.equal(form.get("invalidate"), "true");
      return response({ result: cleanupResult });
    }
    assert.ok(url.startsWith("https://res.cloudinary.com/"));
    assert.equal(init?.headers, undefined);
    return new Response(new Uint8Array(format === "mp4" ? gif : jpeg), {
      headers: {
        "content-type": format === "mp4" ? "image/gif" : "image/jpeg",
        ...(options.oversized ? { "content-length": "5000001" } : {}),
      },
    });
  };
  return {
    config,
    image,
    calls,
    transforms,
    transport,
    source: () => source,
    cleanup: (value: string) => {
      cleanupResult = value;
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("Cloudinary authenticates backend access, protects temporary assets and never returns a delivery URL", async () => {
  const f = await fixture();
  try {
    const preview = await createCloudinaryPreview(
      f.config,
      f.transport,
    )(f.image);
    assert.deepEqual(f.source(), f.image);
    assert.equal(preview.mime, "image/png");
    assert.equal(preview.previewMime, "image/jpeg");
    assert.notDeepEqual(preview.preview, f.image);
    assert.deepEqual(Object.keys(preview).sort(), [
      "mime",
      "preview",
      "previewMime",
    ]);
    assert.equal((f.transforms[0].match(/HANDOFF%20PREVIEW/g) ?? []).length, 3);
    assert.match(f.transforms[0], /c_limit,h_1400,w_1400/);
    assert.equal(
      f.calls.filter((call) => call.url.endsWith("/destroy")).length,
      1,
    );
    assert.deepEqual(await readdir(f.config.cleanupDirectory), []);
  } finally {
    await f.close();
  }
});

test("JPEG and WebP originals receive the same authenticated watermarked image pipeline", async () => {
  for (const format of ["jpg", "webp"]) {
    const f = await fixture({ format });
    try {
      const input = await sharp(f.image)
        .toFormat(format === "jpg" ? "jpeg" : "webp")
        .toBuffer();
      const output = await createCloudinaryPreview(
        f.config,
        f.transport,
      )(input);
      assert.equal(output.mime, format === "jpg" ? "image/jpeg" : "image/webp");
      assert.equal(output.previewMime, "image/jpeg");
      assert.deepEqual(f.source(), input);
      assert.deepEqual(await readdir(f.config.cleanupDirectory), []);
    } finally {
      await f.close();
    }
  }
});

test("readiness deduplicates and caches authentication while checking pending cleanup each time", async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ["Date"] });
  try {
    assert.deepEqual(
      await Promise.all(
        Array.from({ length: 4 }, () =>
          cloudinaryStatus(f.config, f.transport),
        ),
      ),
      [true, true, true, true],
    );
    const pingCount = () =>
      f.calls.filter((call) => call.url.endsWith("/ping")).length;
    assert.equal(pingCount(), 1);
    t.mock.timers.tick(299_999);
    assert.equal(await cloudinaryStatus(f.config, f.transport), true);
    assert.equal(pingCount(), 1);
    t.mock.timers.tick(1);
    assert.equal(await cloudinaryStatus(f.config, f.transport), true);
    assert.equal(pingCount(), 2);
    f.cleanup("failed");
    await assert.rejects(
      createCloudinaryPreview(f.config, f.transport)(f.image),
    );
    assert.equal(await cloudinaryStatus(f.config, f.transport), false);
    assert.equal(pingCount(), 2);
    let failures = 0;
    const failed: typeof fetch = async () => {
      failures++;
      return new Response("denied", { status: 401 });
    };
    assert.equal(await cloudinaryStatus(f.config, failed), false);
    t.mock.timers.tick(29_999);
    assert.equal(await cloudinaryStatus(f.config, failed), false);
    assert.equal(failures, 1);
    t.mock.timers.tick(1);
    assert.equal(await cloudinaryStatus(f.config, failed), false);
    assert.equal(failures, 2);
  } finally {
    await f.close();
  }
});

test("PDF preview generates at most three watermarked pages and builds a bounded contact sheet", async () => {
  const f = await fixture({ format: "pdf", pages: 8 });
  try {
    const output = await createCloudinaryPreview(
      f.config,
      f.transport,
    )(Buffer.from("%PDF-1.4 fixture"));
    assert.equal(output.mime, "application/pdf");
    assert.equal(f.transforms.length, 3);
    f.transforms.forEach((transform, index) => {
      assert.ok(transform.startsWith(`pg_${index + 1},`));
      assert.equal((transform.match(/HANDOFF%20PREVIEW/g) ?? []).length, 3);
    });
    const metadata = await sharp(output.preview).metadata();
    assert.equal(metadata.width, 2100);
    assert.equal(metadata.height, 900);
    assert.equal(metadata.format, "jpeg");
  } finally {
    await f.close();
  }
});

test("video preview is a capped silent animated-image format with repeated baked watermark", async () => {
  const f = await fixture({ format: "mp4" });
  try {
    const output = await createCloudinaryPreview(
      f.config,
      f.transport,
    )(Buffer.from([0, 0, 0, 20, ...Buffer.from("ftypisom")]));
    assert.equal(output.mime, "video/mp4");
    assert.equal(output.previewMime, "image/gif");
    assert.match(f.transforms[0], /^so_0,du_12,fps_4,c_limit,h_480,w_640\//);
    assert.ok(f.transforms[0].endsWith("/f_gif"));
    assert.equal((f.transforms[0].match(/HANDOFF%20PREVIEW/g) ?? []).length, 3);
  } finally {
    await f.close();
  }
});

test("unexpected derivative URLs and oversized outputs are rejected and still cleaned up", async () => {
  for (const options of [
    { invalidUrl: "https://evil.example/original.jpg" },
    {
      invalidUrl:
        "https://res.cloudinary.com/test-cloud/image/upload/original.jpg",
    },
    { oversized: true },
    { sourceWidth: 1_000_000 },
  ]) {
    const f = await fixture(options);
    try {
      await assert.rejects(
        createCloudinaryPreview(f.config, f.transport)(f.image),
        (error: unknown) => error instanceof CloudinaryPreviewError,
      );
      assert.equal(
        f.calls.filter((call) => call.url.endsWith("/destroy")).length,
        1,
      );
      assert.deepEqual(await readdir(f.config.cleanupDirectory), []);
    } finally {
      await f.close();
    }
  }
});

test("failed deletion remains durable and is recovered by authenticated readiness checks", async () => {
  const f = await fixture({ cleanupResult: "failed" });
  try {
    await assert.rejects(
      createCloudinaryPreview(f.config, f.transport)(f.image),
      (error: unknown) =>
        error instanceof CloudinaryPreviewError &&
        error.diagnostic.stage === "cleanup",
    );
    const files = await readdir(f.config.cleanupDirectory);
    assert.equal(files.length, 1);
    const path = join(f.config.cleanupDirectory, files[0]);
    const ticket = JSON.parse(await readFile(path, "utf8"));
    assert.equal(ticket.confirmed, true);
    assert.equal(await cloudinaryStatus(f.config, f.transport), false);
    await writeFile(
      path,
      JSON.stringify({ ...ticket, createdAt: Date.now() - 130_000 }),
    );
    f.cleanup("ok");
    assert.equal(await cloudinaryStatus(f.config, f.transport), true);
    assert.deepEqual(await readdir(f.config.cleanupDirectory), []);
  } finally {
    await f.close();
  }
});

test("uncertain uploads retain cleanup intent when Cloudinary has not yet reported the asset", async () => {
  const f = await fixture({ uploadError: true, cleanupResult: "not found" });
  try {
    await assert.rejects(
      createCloudinaryPreview(f.config, f.transport)(f.image),
      (error: unknown) =>
        error instanceof CloudinaryPreviewError &&
        error.diagnostic.stage === "cleanup",
    );
    const files = await readdir(f.config.cleanupDirectory);
    assert.equal(files.length, 1);
    const ticket = JSON.parse(
      await readFile(join(f.config.cleanupDirectory, files[0]), "utf8"),
    );
    assert.equal(ticket.confirmed, false);
    assert.equal(await cloudinaryStatus(f.config, f.transport), false);
  } finally {
    await f.close();
  }
});

test("definitively rejected uploads do not leave permanent cleanup uncertainty", async () => {
  const f = await fixture({ uploadStatus: 400, cleanupResult: "not found" });
  try {
    await assert.rejects(
      createCloudinaryPreview(f.config, f.transport)(f.image),
      (error: unknown) => error instanceof CloudinaryPreviewError,
    );
    assert.deepEqual(await readdir(f.config.cleanupDirectory), []);
    assert.equal(await cloudinaryStatus(f.config, f.transport), true);
  } finally {
    await f.close();
  }
});

test("Cloudinary configuration and input limits reject unsafe requests before upload", async () => {
  const f = await fixture();
  try {
    assert.throws(() =>
      cloudinaryConfiguration({
        CLOUDINARY_CLOUD_NAME: "../../evil",
        CLOUDINARY_API_KEY: "123456",
        CLOUDINARY_API_SECRET: "valid-but-not-real-secret",
      }),
    );
    assert.throws(() =>
      cloudinaryConfiguration({
        CLOUDINARY_URL: "cloudinary://123456:secret@example?api=evil",
      }),
    );
    const preview = createCloudinaryPreview(f.config, f.transport);
    for (const input of [
      Buffer.alloc(0),
      Buffer.alloc(15 * 1024 * 1024 + 1),
      Buffer.from("<script>bad</script>"),
    ])
      await assert.rejects(preview(input));
    assert.equal(f.calls.length, 0);
    assert.equal(
      await cloudinaryStatus(
        f.config,
        async () => new Response("invalid", { status: 401 }),
      ),
      false,
    );
  } finally {
    await f.close();
  }
});

test("Cloudinary diagnostics expose only fixed failure metadata", async () => {
  const f = await fixture({
    invalidUrl: "https://credentials.invalid/secret-original",
  });
  try {
    await assert.rejects(
      createCloudinaryPreview(f.config, f.transport)(f.image),
      (error: unknown) => {
        assert.ok(error instanceof CloudinaryPreviewError);
        assert.equal(error.statusCode, 503);
        assert.deepEqual(error.diagnostic, {
          stage: "url",
          code: "url_mismatch",
        });
        assert.doesNotMatch(
          JSON.stringify(error),
          /credentials|secret-original|test-secret|https:/,
        );
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  } finally {
    await f.close();
  }
  for (const status of [400, 429, 500]) {
    const f = await fixture({ uploadStatus: status });
    try {
      await assert.rejects(
        createCloudinaryPreview(f.config, f.transport)(f.image),
        (error: unknown) => {
          assert.ok(error instanceof CloudinaryPreviewError);
          assert.equal(error.statusCode, status === 400 ? 400 : 503);
          assert.deepEqual(error.diagnostic, {
            stage: "upload",
            code: "http_failure",
            httpStatus: status,
          });
          return true;
        },
      );
    } finally {
      await f.close();
    }
  }
});

test("all three API preview paths return temporary provider failures without altering saved file state", async () => {
  const f = await fixture();
  let failure: CloudinaryPreviewError | undefined;
  const app = await buildApp({
    directory: f.config.cleanupDirectory,
    scan: async () => true,
    preview: async () => {
      if (failure) throw failure;
      return {
        preview: await sharp(f.image).jpeg().toBuffer(),
        mime: "image/png",
        previewMime: "image/jpeg",
      };
    },
  });
  await app.ready();
  const store = openStore(f.config.cleanupDirectory);
  const id = randomUUID();
  store.db
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(
      hash("fixture"),
      JSON.stringify({ address: "creator", currency: "USDT" }),
      Date.now() + 60_000,
    );
  store.save({
    id,
    creator: "creator",
    clientWallet: null,
    title: "Fixture",
    description: "Fixture",
    clientLabel: "Fixture",
    amount: "10",
    currency: "USDT",
    terms: "Fixture",
    status: "draft",
    publishedAt: null,
    manifestHash: null,
    deadline: new Date(Date.now() + 86400_000).toISOString(),
    createdAt: new Date().toISOString(),
    files: [],
  });
  const upload = (path: string) =>
    app.inject({
      method: "POST",
      url: `/api/handoffs/${id}${path}`,
      headers: {
        origin: "http://localhost:5173",
        cookie: "handoff_session=fixture",
        "content-type": "multipart/form-data; boundary=fixture",
      },
      payload: Buffer.concat([
        Buffer.from(
          '--fixture\r\nContent-Disposition: form-data; name="file"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\n',
        ),
        f.image,
        Buffer.from("\r\n--fixture--\r\n"),
      ]),
    });
  try {
    const initial = await upload("/files");
    assert.equal(initial.statusCode, 201, initial.body);
    const saved = initial.json().handoff.files[0];
    failure = new CloudinaryPreviewError("transform", "http_failure", 503);
    const results = [
      await upload("/files"),
      await upload(`/files/${saved.id}/preview`),
      await app.inject({
        method: "POST",
        url: `/api/handoffs/${id}/files/${saved.id}/rescan`,
        headers: {
          origin: "http://localhost:5173",
          cookie: "handoff_session=fixture",
        },
      }),
    ];
    for (const result of results) {
      assert.equal(result.statusCode, 503, result.body);
      assert.deepEqual(result.json(), {
        error:
          "Preview processing is temporarily unavailable. Please try again shortly.",
      });
    }
    const current = await app.inject({
      url: `/api/handoffs/${id}`,
      headers: { cookie: "handoff_session=fixture" },
    });
    assert.deepEqual(current.json().handoff.files, [saved]);
    failure = new CloudinaryPreviewError("input", "unsupported_input");
    assert.equal((await upload("/files")).statusCode, 400);
  } finally {
    store.db.close();
    await app.close();
    await f.close();
  }
});
