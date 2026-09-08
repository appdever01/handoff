import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app.ts";
const { preview } =
  await import("../../frontend/node_modules/vite/dist/node/index.js");
const directory = await mkdtemp(join(tmpdir(), "handoff-http-"));
const app = await buildApp({ directory });
let site: Awaited<ReturnType<typeof preview>> | undefined;
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const backend = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  site = await preview({
    configFile: false,
    root: resolve("../frontend"),
    preview: { host: "127.0.0.1", port: 0, proxy: { "/api": backend } },
  });
  const origin = `http://127.0.0.1:${(site.httpServer.address() as AddressInfo).port}`;
  for (const path of [
    "/",
    "/pair",
    "/purchases",
    "/h/00000000-0000-4000-8000-000000000000",
  ]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await response.text(), /assets\/index/);
  }
  const health = await fetch(origin + "/api/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).checkoutEnabled, false);
  assert.equal(
    (
      await fetch(
        origin +
          "/api/originals/00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000001",
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(origin + "/api/handoffs", {
        method: "POST",
        headers: {
          Origin: "https://evil.invalid",
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  console.log(
    "PASS: built SPA routes, API proxy, unpaid original denial, origin enforcement.",
  );
} finally {
  if (site)
    await new Promise<void>((resolve, reject) =>
      site!.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
