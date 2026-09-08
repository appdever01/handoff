import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const directory = await mkdtemp(join(tmpdir(), "handoff-runtime-"));
const child = spawn(
  process.execPath,
  [
    "--import",
    resolve("node_modules/tsx/dist/loader.mjs"),
    resolve("src/server.ts"),
  ],
  {
    cwd: directory,
    env: {
      ...process.env,
      NODE_ENV: "development",
      HANDOFF_SANDBOX: "1",
      PORT: "0",
      APP_ORIGIN: "http://localhost:5173",
      LISTEN_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
child.stdout.on("data", (chunk) => {
  logs += chunk;
});
child.stderr.on("data", (chunk) => {
  logs += chunk;
});
const exited = new Promise<number | null>((resolve) =>
  child.on("exit", resolve),
);
try {
  let url: string | undefined;
  for (let i = 0; i < 100; i++) {
    url = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(url, logs);
  assert.equal((await (await fetch(url + "/api/health")).json()).sandbox, true);
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  assert.equal(
    await access(join(directory, ".sandbox-data", ".server-lock")).then(
      () => true,
      () => false,
    ),
    false,
  );
  console.log(
    "PASS: real sandbox runtime startup, HTTP health and graceful lock cleanup.",
  );
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await exited;
  await rm(directory, { recursive: true, force: true });
}
