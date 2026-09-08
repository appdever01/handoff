import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { buildApp } from "./app.ts";
import { polygonTestnet, nimiqTestnet } from "./chains.ts";
import { isolatedPreview, scanDaemon } from "./processing.ts";
import type { PaymentAdapter } from "./payments.ts";

if (process.env.NODE_ENV === "production")
  throw new Error(
    "Production startup is disabled until real-device and chain release gates pass.",
  );
const sandbox = process.env.HANDOFF_SANDBOX === "1";
if (
  sandbox &&
  process.env.LISTEN_HOST &&
  process.env.LISTEN_HOST !== "127.0.0.1"
)
  throw new Error("Sandbox must bind to loopback");
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
const directory = resolve(
  sandbox ? ".sandbox-data" : (process.env.DATA_DIR ?? ".data"),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const lock = join(directory, ".server-lock");
await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  app = await buildApp({
    directory,
    origin: process.env.APP_ORIGIN,
    logger: true,
    sandbox,
    payments: adapters,
    scan: scanDaemon,
    preview: isolatedPreview,
  });
  await app.listen({
    host: process.env.LISTEN_HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 4003),
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
