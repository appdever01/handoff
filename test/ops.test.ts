import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  access,
  chmod,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
const exec = promisify(execFile);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "handoff-ops-"));
  const source = join(directory, "data");
  await mkdir(source);
  await mkdir(join(source, "originals"));
  await writeFile(join(source, "originals", "asset"), "private original");
  const db = new DatabaseSync(join(source, "handoff.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE sessions (id TEXT); CREATE TABLE challenges (id TEXT); CREATE TABLE pairings (id TEXT); CREATE TABLE devices (id TEXT); CREATE TABLE handoffs (id TEXT);",
  );
  for (const table of [
    "sessions",
    "challenges",
    "pairings",
    "devices",
    "handoffs",
  ])
    db.exec(`INSERT INTO ${table} VALUES ('retained')`);
  db.close();
  return {
    directory,
    source,
    backup: join(directory, "backup"),
    target: join(directory, "restore"),
  };
}
function ops(...args: string[]) {
  return exec(process.execPath, ["--import", "tsx", "src/ops.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HANDOFF_LOCK_MANAGED: "0" },
  });
}

test("offline snapshot recovery verifies originals and revokes sessions without erasing deliveries", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, ".runtime.lock"), "lock inode");
    await ops("backup", f.source, f.backup);
    await assert.rejects(access(join(f.backup, ".runtime.lock")));
    assert.equal(
      await readFile(join(f.source, ".runtime.lock"), "utf8"),
      "lock inode",
    );
    const snapshotFiles = (await readdir(f.backup)).sort();
    const snapshotDatabase = await readFile(join(f.backup, "handoff.sqlite"));
    await ops("verify-snapshot", f.backup);
    await ops("verify-snapshot", f.backup);
    assert.deepEqual((await readdir(f.backup)).sort(), snapshotFiles);
    assert.deepEqual(
      await readFile(join(f.backup, "handoff.sqlite")),
      snapshotDatabase,
    );
    await ops("restore-recovery", f.backup, f.target);
    assert.equal(
      await readFile(join(f.target, "originals", "asset"), "utf8"),
      "private original",
    );
    const db = new DatabaseSync(join(f.target, "handoff.sqlite"));
    for (const table of ["sessions", "challenges", "pairings", "devices"])
      assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM handoffs").get()?.n, 1);
    db.close();
    await assert.rejects(ops("restore", f.backup, f.target));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("snapshot operations refuse active servers, tampering, unlisted files and symlinks", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, ".server-lock"), "running");
    await assert.rejects(ops("backup", f.source, f.backup), /Stop Handoff/);
    await rm(join(f.source, ".server-lock"));
    await ops("backup", f.source, f.backup);
    await writeFile(join(f.backup, "extra"), "unlisted");
    await assert.rejects(ops("restore", f.backup, f.target), /inventory/);
    await rm(join(f.backup, "extra"));
    await writeFile(join(f.backup, "originals", "asset"), "tampered");
    await assert.rejects(ops("restore", f.backup, f.target), /integrity/);
    await rm(join(f.backup, "originals", "asset"));
    await symlink(
      join(f.source, "originals", "asset"),
      join(f.backup, "originals", "asset"),
    );
    await assert.rejects(ops("restore", f.backup, f.target), /symbolic links/);
    await assert.rejects(access(f.target));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("backup script restarts only the API after snapshot failure and never uploads partial data", async () => {
  const f = await fixture();
  try {
    const bin = join(f.directory, "bin");
    await mkdir(bin);
    const log = join(f.directory, "commands");
    for (const binary of ["docker", "restic", "flock", "curl"]) {
      const script = `#!/usr/bin/env bash
printf '%s\\n' '${binary} '"$*" >> "$MOCK_COMMAND_LOG"
${
  binary === "docker"
    ? `if [[ "$*" == *"config --format json"* ]]; then printf '{"services":{"api":{"image":"handoff-api:test"}}}\\n'; fi
if [[ "$1" = ps ]]; then printf 'abcdef012345\\n'; fi
if [[ "$1" = inspect ]]; then python3 -c 'import json,os; print(json.dumps([{"Config":{"Image":"handoff-api:test","Labels":{"com.docker.compose.project":os.environ["COMPOSE_PROJECT_NAME"],"com.docker.compose.service":"api","com.docker.compose.project.config_files":os.environ["COMPOSE_FILE"]}},"Mounts":[{"Type":"bind","Source":os.environ["HANDOFF_DATA_DIR"],"Destination":"/data"}]}]))'; fi
if [[ "$*" == *"ps --status running --services api"* ]]; then printf 'api\\n'; fi
if [[ "$*" == *"run --rm"* ]]; then if [[ \${MOCK_FAIL_RUN:-1} = 1 ]]; then exit 7; fi; mkdir -p "$STAGING_DIR/snapshot"; fi`
    : ""
}
`;
      await writeFile(join(bin, binary), script, { mode: 0o700 });
    }
    const releaseEnv = join(f.directory, "release.env");
    const password = join(f.directory, "password");
    await writeFile(releaseEnv, "", { mode: 0o600 });
    await writeFile(password, "local-test-only", { mode: 0o600 });
    const envFile = join(f.directory, "ops.env");
    await writeFile(
      envFile,
      [
        `COMPOSE_FILE=${join(f.directory, "compose.yaml")}`,
        "COMPOSE_PROJECT_NAME=handoff-test",
        `COMPOSE_ENV_FILE=${releaseEnv}`,
        `HANDOFF_DATA_DIR=${f.source}`,
        `RESTIC_PASSWORD_FILE=${password}`,
        "RESTIC_REPOSITORY=s3:https://backup.invalid/handoff",
        "BACKUP_TAG=local-test",
        `STATE_DIR=${join(f.directory, "state")}`,
        `STAGING_DIR=${join(f.directory, "state", "staging")}`,
        `DATA_UID=${process.getuid!()}`,
        `DATA_GID=${process.getgid!()}`,
        "MIN_FREE_GB=0",
      ].join("\n"),
      { mode: 0o600 },
    );
    await assert.rejects(
      exec("bash", ["deploy/ops/handoff-ops.sh", "backup"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          HANDOFF_OPS_ENV: envFile,
          MOCK_COMMAND_LOG: log,
        },
      }),
    );
    const commands = await readFile(log, "utf8");
    assert.match(commands, /stop --timeout 120 api/);
    assert.match(commands, /start api/);
    assert.doesNotMatch(commands, /restic backup/);
    assert.doesNotMatch(commands, /stop.*scanner/);
    await chmod(envFile, 0o644);
    await assert.rejects(
      exec("bash", ["deploy/ops/handoff-ops.sh", "preflight"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          HANDOFF_OPS_ENV: envFile,
          MOCK_COMMAND_LOG: log,
        },
      }),
      /mode 600/,
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("maintenance rejects a Coolify project, compose file or data mount mismatch", async () => {
  const project = "coolify-actual-project";
  const file = "/data/coolify/services/actual/docker-compose.yml";
  const container = {
    Config: {
      Image: "handoff-api:release",
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": "api",
        "com.docker.compose.project.config_files": file,
      },
    },
    Mounts: [
      { Type: "bind", Source: "/var/lib/handoff/data", Destination: "/data" },
    ],
  };
  for (const args of [
    ["handoff", "api", "/var/lib/handoff/data", "handoff-api:release", file],
    [
      project,
      "api",
      "/var/lib/handoff/data",
      "handoff-api:release",
      "/opt/handoff/compose.yaml",
    ],
    [project, "api", "/var/lib/another/data", "handoff-api:release", file],
  ]) {
    await assert.rejects(
      new Promise((resolve, reject) => {
        const child = execFile(
          "python3",
          ["deploy/ops/validate-stack.py", ...args],
          { cwd: process.cwd() },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
        child.stdin!.end(JSON.stringify([container]));
      }),
    );
  }
});
