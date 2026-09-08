import { isAbsolute, resolve } from "node:path";
import { cloudinaryConfiguration } from "./cloudinary.ts";

export function runtimeConfiguration(env: NodeJS.ProcessEnv) {
  const production = env.NODE_ENV === "production";
  const sandbox = env.HANDOFF_SANDBOX === "1";
  const stage = env.HANDOFF_RELEASE_STAGE ?? "development";
  const previewProvider = env.PREVIEW_PROVIDER ?? "docker";
  if (previewProvider !== "docker" && previewProvider !== "cloudinary")
    throw new Error("PREVIEW_PROVIDER must be docker or cloudinary");
  const workerSettings = [
    "PREVIEW_WORKER_URL",
    "PREVIEW_WORKER_SECRET",
    "PREVIEW_WORKER_SECRET_FILE",
    "HANDOFF_MEDIA_IMAGE",
  ];
  const cloudinarySettings = [
    "CLOUDINARY_URL",
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
  ];
  if (previewProvider === "cloudinary") {
    if (workerSettings.some((key) => Boolean(env[key])))
      throw new Error("Cloudinary previews cannot use Docker worker settings");
    cloudinaryConfiguration(env);
  } else if (cloudinarySettings.some((key) => Boolean(env[key]))) {
    throw new Error(
      "Cloudinary credentials require PREVIEW_PROVIDER=cloudinary",
    );
  }
  if (env.MAINNET_PAYMENTS && env.MAINNET_PAYMENTS !== "0")
    throw new Error(
      "Mainnet payments remain disabled until release acceptance passes",
    );
  if (production && !["preview", "acceptance"].includes(stage))
    throw new Error(
      "Production requires an explicit preview or acceptance release stage",
    );
  if (!production && stage !== "development")
    throw new Error("Release stages require NODE_ENV=production");
  if (production && sandbox)
    throw new Error("Sandbox identities and payments cannot run in production");
  const address = new URL(env.APP_ORIGIN ?? "http://localhost:5173");
  if (
    !["http:", "https:"].includes(address.protocol) ||
    address.username ||
    address.password ||
    address.search ||
    address.hash ||
    address.pathname !== "/"
  )
    throw new Error("APP_ORIGIN must contain only an HTTP(S) origin");
  if (production && (!env.APP_ORIGIN || address.protocol !== "https:"))
    throw new Error("Production requires an explicit HTTPS APP_ORIGIN");
  if (
    production &&
    (!env.DATA_DIR ||
      !isAbsolute(env.DATA_DIR) ||
      resolve(env.DATA_DIR) === "/")
  )
    throw new Error("Production requires an absolute private DATA_DIR");
  if (production && !env.CLAMAV_HOST)
    throw new Error("Production requires a private scanner host");
  if (
    production &&
    previewProvider === "docker" &&
    (!env.PREVIEW_WORKER_URL || !env.PREVIEW_WORKER_SECRET_FILE)
  )
    throw new Error(
      "Docker production previews require a private worker and secret file",
    );
  if (production && env.HANDOFF_LOCK_MANAGED !== "1")
    throw new Error(
      "Production must start through the exclusive runtime-lock entrypoint",
    );
  if (stage === "preview" && env.TESTNET_PAYMENTS === "1")
    throw new Error("Preview deployments must keep checkout disabled");
  if (stage === "acceptance" && env.TESTNET_PAYMENTS !== "1")
    throw new Error(
      "Acceptance deployments require explicit testnet configuration",
    );
  if (env.TESTNET_PAYMENTS === "1" && !sandbox) {
    if (Boolean(env.POLYGON_AMOY_RPC) !== Boolean(env.TEST_USDT_ADDRESS))
      throw new Error(
        "Polygon test checkout needs both its RPC and test token",
      );
    if (!env.NIMIQ_TESTNET_RPC && !env.POLYGON_AMOY_RPC)
      throw new Error(
        "Test checkout needs at least one configured test network",
      );
    if (production)
      for (const endpoint of [
        env.NIMIQ_TESTNET_RPC,
        env.POLYGON_AMOY_RPC,
      ].filter(Boolean)) {
        if (new URL(endpoint!).protocol !== "https:")
          throw new Error("Production test RPC endpoints must use HTTPS");
      }
  }
  const port = Number(env.PORT ?? 4003);
  if (!Number.isInteger(port) || port < (production ? 1 : 0) || port > 65535)
    throw new Error("PORT must be a valid port number");
  const host = env.LISTEN_HOST ?? "127.0.0.1";
  if (sandbox && host !== "127.0.0.1")
    throw new Error("Sandbox must bind to loopback");
  return {
    production,
    sandbox,
    stage,
    previewProvider,
    origin: address.origin,
    directory: resolve(sandbox ? ".sandbox-data" : (env.DATA_DIR ?? ".data")),
    host,
    port,
  };
}
