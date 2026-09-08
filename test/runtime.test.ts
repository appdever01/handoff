import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeConfiguration } from "../src/runtime.ts";
import { readinessCheck } from "../src/readiness.ts";
import { buildApp } from "../src/app.ts";

const production = {
  NODE_ENV: "production",
  HANDOFF_RELEASE_STAGE: "preview",
  APP_ORIGIN: "https://handoff.example",
  DATA_DIR: "/data",
  PREVIEW_WORKER_URL: "http://preview-worker:4004",
  PREVIEW_WORKER_SECRET_FILE: "/run/secrets/worker",
  CLAMAV_HOST: "scanner",
  HANDOFF_LOCK_MANAGED: "1",
};

test("public preview startup requires HTTPS, private dependencies and exclusive locking", () => {
  const config = runtimeConfiguration(production);
  assert.equal(config.production, true);
  assert.equal(config.stage, "preview");
  assert.equal(config.sandbox, false);
  for (const change of [
    { HANDOFF_RELEASE_STAGE: "mainnet" },
    { APP_ORIGIN: "http://handoff.example" },
    { APP_ORIGIN: "https://user:password@handoff.example" },
    { APP_ORIGIN: "https://handoff.example/path" },
    { DATA_DIR: "./data" },
    { DATA_DIR: "/" },
    { PREVIEW_WORKER_URL: "" },
    { PREVIEW_WORKER_SECRET_FILE: "" },
    { CLAMAV_HOST: "" },
    { HANDOFF_LOCK_MANAGED: "0" },
    { PORT: "0" },
    { HANDOFF_SANDBOX: "1" },
    { TESTNET_PAYMENTS: "1" },
    { MAINNET_PAYMENTS: "1" },
  ])
    assert.throws(() => runtimeConfiguration({ ...production, ...change }));
});

const cloudinaryProduction = {
  ...production,
  PREVIEW_PROVIDER: "cloudinary",
  PREVIEW_WORKER_URL: undefined,
  PREVIEW_WORKER_SECRET_FILE: undefined,
  CLOUDINARY_CLOUD_NAME: "handoff-test",
  CLOUDINARY_API_KEY: "123456789012345",
  CLOUDINARY_API_SECRET: "a".repeat(32),
};

test("Cloudinary production uses credentials and scanner without requiring Docker access", () => {
  const config = runtimeConfiguration(cloudinaryProduction);
  assert.equal(config.previewProvider, "cloudinary");
  assert.equal(config.directory, "/data");
  assert.equal(config.production, true);
  assert.equal(config.stage, "preview");
  assert.equal(
    JSON.stringify(config).includes(cloudinaryProduction.CLOUDINARY_API_SECRET),
    false,
  );
  for (const key of [
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
    "CLAMAV_HOST",
    "HANDOFF_LOCK_MANAGED",
  ])
    assert.throws(() =>
      runtimeConfiguration({ ...cloudinaryProduction, [key]: "" }),
    );
  for (const change of [
    { APP_ORIGIN: "http://handoff.example" },
    { DATA_DIR: "./data" },
    { TESTNET_PAYMENTS: "1" },
    { MAINNET_PAYMENTS: "1" },
    { HANDOFF_SANDBOX: "1" },
  ])
    assert.throws(() =>
      runtimeConfiguration({ ...cloudinaryProduction, ...change }),
    );
});

test("preview selection rejects unknown providers and mixed provider configuration", () => {
  for (const provider of ["", "local", "Cloudinary", "unknown"])
    assert.throws(() =>
      runtimeConfiguration({ ...production, PREVIEW_PROVIDER: provider }),
    );
  for (const key of [
    "PREVIEW_WORKER_URL",
    "PREVIEW_WORKER_SECRET",
    "PREVIEW_WORKER_SECRET_FILE",
    "HANDOFF_MEDIA_IMAGE",
  ])
    assert.throws(() =>
      runtimeConfiguration({ ...cloudinaryProduction, [key]: "configured" }),
    );
  for (const key of [
    "CLOUDINARY_URL",
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
  ])
    assert.throws(() =>
      runtimeConfiguration({ ...production, [key]: "configured" }),
    );
  assert.throws(() =>
    runtimeConfiguration({
      ...cloudinaryProduction,
      CLOUDINARY_URL: "cloudinary://123456:aaaaaaaaaaaaaaaa@handoff-test",
    }),
  );
});

test("Cloudinary URL credentials are accepted only as the sole credential source", () => {
  const config = runtimeConfiguration({
    ...cloudinaryProduction,
    CLOUDINARY_CLOUD_NAME: undefined,
    CLOUDINARY_API_KEY: undefined,
    CLOUDINARY_API_SECRET: undefined,
    CLOUDINARY_URL:
      "cloudinary://123456789:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@handoff-test",
  });
  assert.equal(config.previewProvider, "cloudinary");
  assert.throws(() =>
    runtimeConfiguration({
      ...cloudinaryProduction,
      CLOUDINARY_API_KEY: "invalid",
    }),
  );
  assert.throws(() =>
    runtimeConfiguration({
      ...cloudinaryProduction,
      CLOUDINARY_API_SECRET: "short",
    }),
  );
});

test("default preview configuration preserves local and remote Docker operation", () => {
  assert.equal(runtimeConfiguration({}).previewProvider, "docker");
  assert.equal(
    runtimeConfiguration({ HANDOFF_SANDBOX: "1" }).previewProvider,
    "docker",
  );
  assert.equal(runtimeConfiguration(production).previewProvider, "docker");
  assert.equal(
    runtimeConfiguration({ ...production, PREVIEW_PROVIDER: "docker" })
      .previewProvider,
    "docker",
  );
});

test("acceptance startup explicitly requires valid test-network configuration", () => {
  const acceptance = {
    ...production,
    HANDOFF_RELEASE_STAGE: "acceptance",
    TESTNET_PAYMENTS: "1",
    NIMIQ_TESTNET_RPC: "https://rpc.example",
  };
  assert.equal(runtimeConfiguration(acceptance).stage, "acceptance");
  for (const change of [
    { TESTNET_PAYMENTS: "0" },
    { NIMIQ_TESTNET_RPC: "" },
    { NIMIQ_TESTNET_RPC: "http://rpc.example" },
    { POLYGON_AMOY_RPC: "https://polygon.example" },
    { TEST_USDT_ADDRESS: "0x1234" },
  ])
    assert.throws(() => runtimeConfiguration({ ...acceptance, ...change }));
  assert.throws(() =>
    runtimeConfiguration({ HANDOFF_SANDBOX: "1", LISTEN_HOST: "0.0.0.0" }),
  );
  assert.equal(
    runtimeConfiguration({ HANDOFF_SANDBOX: "1" }).host,
    "127.0.0.1",
  );
});

test("readiness checks writable storage and caches concurrent dependency probes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "handoff-readiness-"));
  try {
    let probes = 0;
    const check = readinessCheck({
      directory,
      scanner: async () => {
        probes++;
        return true;
      },
      preview: async () => true,
    });
    const values = await Promise.all([check(), check(), check()]);
    assert.deepEqual(values[0], {
      storage: true,
      scanner: true,
      preview: true,
    });
    assert.equal(probes, 1);
    assert.deepEqual(await readdir(directory), []);
    const missing = readinessCheck({
      directory: join(directory, "absent"),
      scanner: async () => false,
      preview: async () => {
        throw Error("failed");
      },
    });
    assert.deepEqual(await missing(), {
      storage: false,
      scanner: false,
      preview: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("liveness stays distinct from failed dependency readiness and health polling is not rate limited", async () => {
  const directory = await mkdtemp(join(tmpdir(), "handoff-health-"));
  let scanner = false;
  const app = await buildApp({
    directory,
    production: true,
    readiness: async () => ({ scanner, preview: true, storage: true }),
  });
  try {
    assert.equal((await app.inject("/api/health")).statusCode, 200);
    const failed = await app.inject("/api/ready");
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().checks.scanner, false);
    scanner = true;
    for (let i = 0; i < 125; i++)
      assert.equal((await app.inject("/api/ready")).statusCode, 200);
    assert.equal(
      (await app.inject("/api/health")).json().checkoutEnabled,
      false,
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("readiness returns failed checks for stalled or synchronously failed dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "handoff-readiness-timeout-"));
  try {
    const check = readinessCheck({
      directory,
      timeoutMs: 20,
      scanner: () => new Promise<boolean>(() => {}),
      preview: () => {
        throw new Error("unavailable");
      },
    });
    const result = await check();
    assert.deepEqual(result, { storage: true, scanner: false, preview: false });
    assert.throws(() =>
      readinessCheck({
        directory,
        timeoutMs: 0,
        scanner: async () => true,
        preview: async () => true,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
