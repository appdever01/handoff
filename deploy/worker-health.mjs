import { readFile } from "node:fs/promises";
const secret = (await readFile(process.env.PREVIEW_WORKER_SECRET_FILE, "utf8")).trim();
const response = await fetch(`http://127.0.0.1:${process.env.PREVIEW_WORKER_PORT ?? "4004"}/ready`, {
  headers: { Authorization: `Bearer ${secret}` },
  signal: AbortSignal.timeout(4000),
});
if (!response.ok || !(await response.json()).ok) process.exit(1);
