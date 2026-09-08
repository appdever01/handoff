import { isIP } from "node:net";
import { buildProcessingService } from "./processing-service.ts";
import { workerSecretFromEnvironment } from "./processing-client.ts";
import { mediaImage } from "./processing.ts";

const host = process.env.PREVIEW_WORKER_HOST ?? "127.0.0.1";
const port = Number(process.env.PREVIEW_WORKER_PORT ?? 4004);
if (!isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid preview worker listen address");
if (
  process.env.NODE_ENV === "production" &&
  !process.env.PREVIEW_WORKER_SECRET_FILE
)
  throw new Error("Production preview workers require a secret file");
mediaImage();
const app = await buildProcessingService({
  secret: await workerSecretFromEnvironment(),
  logger: true,
});
await app.listen({ host, port });
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (!stopping) {
      stopping = true;
      void app.close();
    }
  });
}
