import {
  mkdir,
  readFile,
  writeFile,
  cp,
  readdir,
  stat,
  access,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hash } from "./auth.ts";

const [command, sourceArg, targetArg] = process.argv.slice(2);
const source = resolve(sourceArg ?? ".data");
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
    if (name === "snapshot.json" || name === ".server-lock") continue;
    const relative = join(prefix, name);
    const info = await stat(join(directory, relative));
    if (info.isDirectory()) result.push(...(await files(directory, relative)));
    else if (info.isFile()) result.push(relative);
  }
  return result;
}
if (command === "backup") {
  if (!targetArg)
    throw new Error("Usage: npm run ops -- backup DATA_DIR NEW_BACKUP_DIR");
  const target = resolve(targetArg);
  if (target.startsWith(source + "/"))
    throw new Error("Backup must be outside the data directory");
  await mkdir(target, { mode: 0o700 });
  const db = new DatabaseSync(join(source, "handoff.sqlite"));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  for (const name of await readdir(source))
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
  console.log(
    `Backup verified: ${Object.keys(entries).length} files in ${target}`,
  );
} else if (command === "restore") {
  if (!targetArg)
    throw new Error("Usage: npm run ops -- restore BACKUP_DIR NEW_DATA_DIR");
  const manifest = JSON.parse(
    await readFile(join(source, "snapshot.json"), "utf8"),
  ) as { files: Record<string, string> };
  for (const [name, expected] of Object.entries(manifest.files)) {
    const path = resolve(source, name);
    if (
      !path.startsWith(source + "/") ||
      hash(await readFile(path)) !== expected
    )
      throw new Error("Backup integrity check failed");
  }
  const target = resolve(targetArg);
  await mkdir(target, { mode: 0o700 });
  for (const name of await readdir(source))
    await cp(join(source, name), join(target, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  const db = new DatabaseSync(join(target, "handoff.sqlite"));
  const check = db.prepare("PRAGMA integrity_check").get();
  db.close();
  if (check?.integrity_check !== "ok")
    throw new Error("Restored database failed integrity check");
  console.log(
    `Restore verified: ${target}. Run retention before serving restored files.`,
  );
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
} else throw new Error("Choose backup, restore, support or resolve-support");
