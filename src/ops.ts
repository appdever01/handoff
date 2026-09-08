import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  cp,
  readdir,
  lstat,
  realpath,
  rm,
  access,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { hash } from "./auth.ts";

const [command, sourceArg, targetArg] = process.argv.slice(2);
const source = await realpath(resolve(sourceArg ?? ".data"));
if (process.env.HANDOFF_LOCK_MANAGED === "1")
  await rm(join(source, ".server-lock"), { force: true });
if (
  await access(join(source, ".server-lock")).then(
    () => true,
    () => false,
  )
)
  throw new Error(
    "Stop Handoff before backup, restore or support administration. If it crashed, verify no server is running before removing .server-lock.",
  );
async function files(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const name of await readdir(join(directory, prefix))) {
    if (
      !prefix &&
      ["snapshot.json", ".server-lock", ".runtime.lock"].includes(name)
    )
      continue;
    const relative = join(prefix, name);
    const info = await lstat(join(directory, relative));
    if (info.isDirectory()) result.push(...(await files(directory, relative)));
    else if (info.isFile()) result.push(relative);
    else
      throw new Error(
        "Snapshots cannot contain symbolic links or special files",
      );
  }
  return result;
}
async function verifySnapshot(directory: string) {
  if (!(await lstat(join(directory, "snapshot.json"))).isFile())
    throw new Error("Snapshot manifest must be a regular file");
  const manifest = JSON.parse(
    await readFile(join(directory, "snapshot.json"), "utf8"),
  ) as { files: Record<string, string> };
  if (
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  )
    throw new Error("Invalid snapshot manifest");
  const actual = (await files(directory)).sort();
  const expectedFiles = Object.keys(manifest.files).sort();
  if (
    JSON.stringify(actual) !== JSON.stringify(expectedFiles) ||
    !actual.includes("handoff.sqlite")
  )
    throw new Error("Backup file inventory check failed");
  for (const [name, expected] of Object.entries(manifest.files)) {
    const path = resolve(directory, name);
    if (
      !path.startsWith(directory + "/") ||
      !/^[a-f0-9]{64}$/.test(expected) ||
      hash(await readFile(path)) !== expected
    )
      throw new Error("Backup integrity check failed");
  }
  const scratch = await mkdtemp(join(tmpdir(), "handoff-snapshot-check-"));
  try {
    for (const name of [
      "handoff.sqlite",
      "handoff.sqlite-wal",
      "handoff.sqlite-shm",
    ]) {
      if (actual.includes(name))
        await cp(join(directory, name), join(scratch, name));
    }
    const db = new DatabaseSync(join(scratch, "handoff.sqlite"), {
      readOnly: true,
    });
    try {
      if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
        throw new Error("Snapshot database failed integrity check");
    } finally {
      db.close();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return manifest;
}

if (command === "backup") {
  if (!targetArg)
    throw new Error("Usage: npm run ops -- backup DATA_DIR NEW_BACKUP_DIR");
  const target = resolve(targetArg);
  if (target.startsWith(source + "/"))
    throw new Error("Backup must be outside the data directory");
  await files(source);
  await access(join(source, "handoff.sqlite"));
  await mkdir(target, { mode: 0o700 });
  const db = new DatabaseSync(join(source, "handoff.sqlite"));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  for (const name of (await readdir(source)).filter(
    (name) =>
      !["snapshot.json", ".server-lock", ".runtime.lock"].includes(name),
  ))
    await cp(join(source, name), join(target, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  const entries: Record<string, string> = {};
  for (const name of await files(target))
    entries[name] = hash(await readFile(join(target, name)));
  await writeFile(
    join(target, "snapshot.json"),
    JSON.stringify({ createdAt: new Date().toISOString(), files: entries }),
    { mode: 0o600 },
  );
  await verifySnapshot(target);
  console.log(
    `Backup verified: ${Object.keys(entries).length} files in ${target}`,
  );
} else if (command === "restore" || command === "restore-recovery") {
  if (!targetArg)
    throw new Error("Usage: npm run ops -- restore BACKUP_DIR NEW_DATA_DIR");
  await verifySnapshot(source);
  const target = resolve(targetArg);
  await mkdir(target, { mode: 0o700 });
  for (const name of (await readdir(source)).filter(
    (name) =>
      !["snapshot.json", ".server-lock", ".runtime.lock"].includes(name),
  ))
    await cp(join(source, name), join(target, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  const db = new DatabaseSync(join(target, "handoff.sqlite"));
  const check = db.prepare("PRAGMA integrity_check").get();
  if (command === "restore-recovery") {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["sessions", "challenges", "pairings", "devices"]) {
        if (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            )
            .get(table)
        )
          db.exec(`DELETE FROM ${table}`);
      }
      db.exec("COMMIT");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  db.close();
  if (check?.integrity_check !== "ok")
    throw new Error("Restored database failed integrity check");
  console.log(
    `Restore verified: ${target}. Run retention before serving restored files.`,
  );
} else if (command === "verify-snapshot") {
  await verifySnapshot(source);
  console.log("Snapshot hashes, inventory and database integrity verified.");
} else if (command === "support") {
  const db = new DatabaseSync(join(source, "handoff.sqlite"));
  const rows = db.prepare("SELECT id,handoff,wallet,data FROM support").all();
  console.log(JSON.stringify(rows, null, 2));
  db.close();
} else if (command === "resolve-support") {
  const [id, outcome, reference] = process.argv.slice(4);
  if (
    !id ||
    !["resolved", "refund-recorded", "declined"].includes(outcome ?? "")
  )
    throw new Error(
      "Usage: npm run ops -- resolve-support DATA_DIR TICKET_ID resolved|refund-recorded|declined [TRANSACTION_REFERENCE]",
    );
  if (outcome === "refund-recorded" && !reference)
    throw new Error(
      "Record the creator refund transaction reference; this does not verify or issue a refund",
    );
  const db = new DatabaseSync(join(source, "handoff.sqlite"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS support_audit (id INTEGER PRIMARY KEY, ticket TEXT NOT NULL, previous TEXT NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL)",
  );
  const row = db.prepare("SELECT data FROM support WHERE id=?").get(id) as
    { data: string } | undefined;
  if (!row) throw new Error("Ticket not found");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO support_audit(ticket,previous,outcome,at) VALUES(?,?,?,?)",
    ).run(id, row.data, outcome, Date.now());
    db.prepare("UPDATE support SET data=? WHERE id=?").run(
      JSON.stringify({
        ...JSON.parse(row.data),
        status: outcome,
        refundTransaction: reference ?? null,
        resolvedAt: Date.now(),
      }),
      id,
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.close();
  }
  console.log("Support record updated. No funds moved.");
} else
  throw new Error(
    "Choose backup, verify-snapshot, restore, restore-recovery, support or resolve-support",
  );
