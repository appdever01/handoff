import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.ts";
import { openStore } from "../src/store.ts";
import { hash } from "../src/auth.ts";

const reserve = 256 * 1024 ** 2;
const allocation = 15 * 1024 ** 2 + 5_000_000;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "handoff-upload-space-"));
  let available = reserve + 3 * allocation;
  let failed = false;
  let scans = 0;
  let previews = 0;
  let previewWait = Promise.resolve();
  const app = await buildApp({
    directory,
    scan: async () => {
      scans++;
      return true;
    },
    preview: async () => {
      previews++;
      await previewWait;
      return {
        preview: Buffer.from("generated-preview"),
        mime: "image/png",
        previewMime: "image/jpeg",
      };
    },
  });
  await app.ready();
  const space = await fs.statfs(directory);
  t.mock.method(fs, "statfs", async () => {
    if (failed) throw new Error("unavailable");
    return { ...space, bsize: 1, bavail: available };
  });
  const store = openStore(directory);
  store.db
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(
      hash("fixture"),
      JSON.stringify({ address: "creator", currency: "USDT" }),
      Date.now() + 60_000,
    );
  const id = randomUUID();
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
    deadline: new Date(Date.now() + 86400_000).toISOString(),
    createdAt: new Date().toISOString(),
    publishedAt: null,
    manifestHash: null,
    files: [],
  });
  const headers = {
    origin: "http://localhost:5173",
    cookie: "handoff_session=fixture",
  };
  const upload = (path = "/files") =>
    app.inject({
      method: "POST",
      url: `/api/handoffs/${id}${path}`,
      headers: {
        ...headers,
        "content-type": "multipart/form-data; boundary=fixture",
      },
      payload: Buffer.from(
        '--fixture\r\nContent-Disposition: form-data; name="file"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\nfixture\r\n--fixture--\r\n',
      ),
    });
  return {
    app,
    id,
    upload,
    rescan: (file: string) =>
      app.inject({
        method: "POST",
        url: `/api/handoffs/${id}/files/${file}/rescan`,
        headers,
      }),
    space: (value: number) => {
      available = value;
    },
    fail: () => {
      failed = true;
    },
    counts: () => ({ scans, previews }),
    pause: (promise: Promise<void>) => {
      previewWait = promise;
    },
    close: async () => {
      store.db.close();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("disk reserve rejects original and supplied uploads and rescans before processing", async (t) => {
  const f = await fixture(t);
  try {
    const initial = await f.upload();
    assert.equal(initial.statusCode, 201);
    const file = initial.json().handoff.files[0];
    f.space(reserve + allocation - 1);
    for (const response of [
      await f.upload(),
      await f.upload(`/files/${file.id}/preview`),
      await f.rescan(file.id),
    ]) {
      assert.equal(response.statusCode, 413, response.body);
      assert.match(response.json().error, /Storage is nearly full/);
    }
    assert.deepEqual(f.counts(), { scans: 1, previews: 1 });
    f.space(reserve + allocation);
    assert.equal((await f.upload()).statusCode, 201);
    f.fail();
    assert.equal((await f.upload()).statusCode, 503);
    assert.deepEqual(f.counts(), { scans: 2, previews: 2 });
  } finally {
    await f.close();
  }
});

test("inflight uploads reserve space for both originals and previews and release reservations", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.pause(waiting);
  f.space(reserve + allocation);
  const first = f.upload();
  first.then(() => {});
  try {
    for (let index = 0; f.counts().previews === 0 && index < 100; index++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(f.counts(), { scans: 1, previews: 1 });
    const second = await f.upload();
    assert.equal(second.statusCode, 413, second.body);
    assert.deepEqual(f.counts(), { scans: 1, previews: 1 });
    release();
    assert.equal((await first).statusCode, 201);
    assert.equal((await f.upload()).statusCode, 201);
  } finally {
    release();
    await first;
    await f.close();
  }
});
