import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildApp } from "./app.ts";
import { polygonTestnet, nimiqTestnet } from "./chains.ts";
import {
  scanDaemon,
  scannerStatus,
  previewWorkerStatus,
} from "./processing.ts";
import {
  previewFromEnvironment,
  workerConfigurationFromEnvironment,
  checkPreviewWorker,
  createRemotePreview,
} from "./processing-client.ts";
import {
  cloudinaryConfiguration,
  createCloudinaryPreview,
  cloudinaryStatus,
} from "./cloudinary.ts";
import { runtimeConfiguration } from "./runtime.ts";
import { readinessCheck } from "./readiness.ts";
import type { PaymentAdapter } from "./payments.ts";

const config = runtimeConfiguration(process.env);
const { sandbox, directory } = config;
const cloudinary =
  config.previewProvider === "cloudinary"
    ? cloudinaryConfiguration({ ...process.env, DATA_DIR: directory })
    : undefined;
const worker =
  config.previewProvider === "docker" && process.env.PREVIEW_WORKER_URL
    ? await workerConfigurationFromEnvironment(process.env)
    : undefined;
const preview = cloudinary
  ? createCloudinaryPreview(cloudinary)
  : worker
    ? createRemotePreview(worker)
    : await previewFromEnvironment(process.env);
const adapters: Partial<Record<"NIM" | "USDT", PaymentAdapter>> = {};
if (process.env.TESTNET_PAYMENTS === "1" && !sandbox) {
  if (process.env.NIMIQ_TESTNET_RPC)
    adapters.NIM = nimiqTestnet(process.env.NIMIQ_TESTNET_RPC);
  if (process.env.POLYGON_AMOY_RPC && process.env.TEST_USDT_ADDRESS)
    adapters.USDT = polygonTestnet(
      process.env.POLYGON_AMOY_RPC,
      process.env.TEST_USDT_ADDRESS,
    );
}
await mkdir(directory, { recursive: true, mode: 0o700 });
const lock = join(directory, ".server-lock");
if (config.production) await rm(lock, { force: true });
await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  app = await buildApp({
    directory,
    origin: config.origin,
    production: config.production,
    logger: true,
    sandbox,
    payments: adapters,
    scan: scanDaemon,
    preview,
    readiness: readinessCheck({
      directory,
      scanner: () => scannerStatus(),
      preview: () =>
        cloudinary
          ? cloudinaryStatus(cloudinary)
          : worker
            ? checkPreviewWorker(worker)
            : previewWorkerStatus(),
    }),
  });
  await app.listen({
    host: config.host,
    port: config.port,
  });
} catch (error) {
  if (app) await app.close();
  await rm(lock, { force: true });
  throw error;
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app!.close();
  await rm(lock, { force: true });
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void stop();
  });
