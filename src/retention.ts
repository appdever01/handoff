import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "./store.ts";
import type { Handoff, Receipt } from "../packages/contracts/index.ts";

export async function retain(
  store: Store,
  directory: string,
  now = Date.now(),
) {
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS deletions (handoff TEXT PRIMARY KEY, at INTEGER NOT NULL)",
  );
  const rows = store.db.prepare("SELECT data FROM handoffs").all() as {
    data: string;
  }[];
  const keep = new Set<string>();
  for (const row of rows) {
    const h: Handoff = JSON.parse(row.data);
    const entitlement = store.db
      .prepare("SELECT data FROM entitlements WHERE handoff=?")
      .get(h.id) as { data: string } | undefined;
    const receipt: Receipt | undefined =
      entitlement && JSON.parse(entitlement.data);
    const pending = store.db
      .prepare("SELECT id FROM intents WHERE handoff=?")
      .get(h.id);
    const expiry =
      receipt?.expiresAt ??
      (h.status === "draft"
        ? Date.parse(h.createdAt) + 30 * 86400_000
        : Date.parse(h.deadline) + (pending ? 7 * 86400_000 : 0));
    if (expiry > now) {
      for (const f of h.files) keep.add(f.id);
      continue;
    }
    for (const file of h.files) {
      await rm(join(directory, "originals", file.id), { force: true });
      await rm(join(directory, "previews", `${file.id}.jpg`), { force: true });
    }
    store.db
      .prepare("INSERT OR IGNORE INTO deletions VALUES(?,?)")
      .run(h.id, now);
    if (expiry + 365 * 86400_000 <= now) {
      store.db.exec("BEGIN IMMEDIATE");
      try {
        if (
          store.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='support_audit'",
            )
            .get()
        )
          store.db
            .prepare(
              "DELETE FROM support_audit WHERE ticket IN (SELECT id FROM support WHERE handoff=?)",
            )
            .run(h.id);
        if (
          store.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='demo_chain'",
            )
            .get()
        )
          store.db
            .prepare(
              "DELETE FROM demo_chain WHERE intent IN (SELECT id FROM intents WHERE handoff=?)",
            )
            .run(h.id);
        for (const table of [
          "requests",
          "intents",
          "entitlements",
          "access_events",
          "support",
          "deletions",
        ])
          store.db.prepare(`DELETE FROM ${table} WHERE handoff=?`).run(h.id);
        store.db.prepare("DELETE FROM handoffs WHERE id=?").run(h.id);
        store.db.exec("COMMIT");
      } catch (error) {
        store.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
  for (const kind of ["originals", "previews"]) {
    for (const name of await readdir(join(directory, kind)).catch(
      () => [] as string[],
    )) {
      const id = name.replace(/\.jpg$/, "");
      if (
        !keep.has(id) &&
        (await stat(join(directory, kind, name))).mtimeMs < now - 3600_000
      )
        await rm(join(directory, kind, name), { force: true });
    }
  }
  store.db.prepare("DELETE FROM challenges WHERE expires<=?").run(now);
  store.db.prepare("DELETE FROM sessions WHERE expires<=?").run(now);
}
