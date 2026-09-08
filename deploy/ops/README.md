# Encrypted backups and recovery

Prepared 8 September 2026. These files are deployment tooling, not evidence that a production backup destination, systemd timer or offsite restore has been activated. No external notifications are sent. An operator must supply and verify the host, offsite account, private credentials and encryption password before enabling schedules.

## Requirements and configuration

Use a Linux host with Docker Compose v2, Bash, Python 3, `flock` (util-linux), curl and a current supported restic binary. Use the release package's `api` service and its kernel-locking entrypoint. Run operations as root through the supplied host systemd units. Keep exactly one API service and one matching data volume.

Copy `ops.env.example` to `/etc/handoff/ops.env` as a regular root-owned mode 600 file, then replace every placeholder. The script reads it without printing values. Also make the release environment file and `RESTIC_PASSWORD_FILE` regular root-owned mode 600 files. Quote shell-sensitive values in the operations file. Do not put credentials in the repository URL, source control, a frontend variable or a command line. A dedicated restricted S3 credential is preferable to an account-wide key.

For Coolify, inspect the deployed API container's `com.docker.compose.project`, `com.docker.compose.service`, and `com.docker.compose.project.config_files` labels on its actual host. Set the required `COMPOSE_PROJECT_NAME` to that exact project, `API_SERVICE` to that service key, and `COMPOSE_FILE` to Coolify's generated Compose file. If there is one override, set `COMPOSE_OVERRIDE_FILE` too. Every file recorded by the deployed container must match. Do not point these settings at the packaged `name: handoff` Compose file when Coolify owns a differently named project. `COMPOSE_ENV_FILE` must contain the actual generated deployment's interpolation values and retain its private permissions. Review these paths after every Coolify redeployment: generated locations may change.

For a CLI-managed deployment, use its explicit `--project-name` and exact deployed file/override set. Operations always pass that project name. Before stopping an API, the script requires exactly one matching non-oneoff container and checks its project, service, generated Compose files, image reference and `/data` bind mount. A mismatch fails before stopping anything. It never runs `compose up`, deploys dependencies, or assumes a container name. Pause conflicting deployment automation while maintenance runs.

Isolated restore uses a network-disabled, read-only oneoff Docker container from the configured API image, with only the recovered snapshot and fresh destination mounted. It does not create another Compose stack or mount live data. Use the matching application release for a disaster-recovery snapshot.

`COMPOSE_FILE` and `COMPOSE_ENV_FILE` must point to the exact installed release. `HANDOFF_DATA_DIR` is the same host path mounted at `/data` by Compose. `DATA_UID` and `DATA_GID` default to the API's 1000:1000. `STATE_DIR` and `STAGING_DIR` are private host directories outside all live data and served directories. Keep the staging path stable: it identifies this backup set inside restic. `BACKUP_TAG` must uniquely identify this host/environment and remain stable on a replacement host.

The repository must be remote S3 over HTTPS, REST over HTTPS or SFTP. Restic encrypts data and metadata before uploading. Store a copy of the encryption password in the operator's secure recovery store, separately from this host; losing it makes the backups unrecoverable. Credentials authorize storage access and the password decrypts the repository; both are needed for recovery.

The example retains seven daily, four weekly and six monthly snapshots. These are restic calendar buckets, not guaranteed numbers of days if backups are missed. Configure an external bucket retention policy only after ensuring it does not remove objects restic still references. Review [restic retention](https://restic.readthedocs.io/en/stable/060_forget.html).

## First run and scheduling

The commands below affect the configured destination. Run them only on the intended host after configuration review:

```sh
/opt/handoff/backend/deploy/ops/handoff-ops.sh init-repository
/opt/handoff/backend/deploy/ops/handoff-ops.sh preflight
/opt/handoff/backend/deploy/ops/handoff-ops.sh backup
/opt/handoff/backend/deploy/ops/handoff-ops.sh retention-dry-run
/opt/handoff/backend/deploy/ops/handoff-ops.sh check
```

Skip `init-repository` for an existing repository. Preflight checks configuration permissions, Compose configuration, available tools, local free space, repository access and HTTP readiness without stopping services or changing snapshots. The first backup must succeed before the backup-age check can pass. Retention preview writes only to private `operations.log`.

A backup acquires a host maintenance lock, checks offsite access before downtime, stops only `api`, then runs the offline snapshot command through the same `/data/.runtime.lock` used by API startup. The trusted entrypoint clears a stale `.server-lock` only after the kernel lock is held. The persistent `.runtime.lock` inode is never unlinked, copied or restored. Scanner and preview-worker services remain running. The API restarts immediately after local snapshot verification, before encrypted upload or pruning. Failure during the snapshot still attempts to restart the API. The operation fails if restart readiness fails.

Do not launch API maintenance with `docker exec` against a running API: that bypasses this stop/lock protocol. Do not remove `.runtime.lock` to clear a problem. The direct local `npm run ops` workflow still refuses a `.server-lock` unless it is run through the trusted production entrypoint after acquiring the lock.

Restic uploads the consistent snapshot, checks repository structure, applies retention and pruning, then checks repository structure again. The success timestamp is written only after all steps succeed. Snapshot hashes and SQLite integrity are checked locally before upload. A repository structure check is not a full retrieval of every stored byte; periodically perform a restore test to verify retrieval and plaintext hashes. See [restic restore](https://restic.readthedocs.io/en/stable/050_restore.html).

After a successful backup and isolated restore drill, install the four supplied units under `/etc/systemd/system/`, verify their `/opt/handoff` paths, and run:

```sh
systemctl daemon-reload
systemctl enable --now handoff-backup.timer handoff-health.timer
systemctl list-timers handoff-backup.timer handoff-health.timer
```

The backup runs around 03:00 in the host's configured time zone. The health job runs every five minutes and checks readiness, data/staging disk space, offsite access and a successful backup within 30 hours. It defers while maintenance holds the host lock to avoid false alerts during a backup. Configure the URL to a reachable same-origin `/api/ready`; the default assumes the release's loopback gateway on port 8080.

These jobs emit local systemd failure states and journal entries only. An operator must separately authorize and configure notification routing to make failures reach a person. Inspect:

```sh
systemctl --failed
journalctl -u handoff-backup.service -u handoff-health.service
```

Detailed restic output is in the mode-restricted `$STATE_DIR/operations.log`. Monitor and rotate that private log. A failed upload intentionally leaves the private staging snapshot for investigation; retry refuses to overwrite it. After reviewing the error, retain or securely remove that specific staging snapshot before retrying. Free-space checks use a configurable floor, not a prediction of the next snapshot's size: reserve capacity for live files, one full local snapshot and a restore drill. Never publish these paths.

## Isolated restore and actual disaster recovery

Test a known snapshot ID or the latest snapshot for this backup tag and staging path:

```sh
/opt/handoff/backend/deploy/ops/handoff-ops.sh restore-test latest /var/lib/handoff-restore-drill
```

The destination must not exist and cannot be inside live data or staging. The private downloaded copy is normalized to root-owned mode 700 directories and mode 600 files before verification; this permits capability-free root inside the container to read snapshots originally owned by the API user on native Linux. The container writes into a separate private root-owned output directory. Only after verification does the host assign the API UID/GID and move it into the fresh destination without overwriting an existing path. No additional Docker capabilities or live parent-directory mounts are granted. Restic restores into a private temporary directory with `--verify`; the Node tool then checks the exact file inventory, every recorded SHA-256 and SQLite integrity before copying into the new destination. Symlinks, special files and unlisted files are rejected. The live API and its files are untouched. Keep the drill directory isolated: it contains private originals and valid copied session records. Remove it after the approved drill. No drill directory should be mounted into a running API or gateway.

For actual recovery use:

```sh
/opt/handoff/backend/deploy/ops/handoff-ops.sh restore-recovery SNAPSHOT_ID /var/lib/handoff/recovered-data
```

This also clears all recovered sessions, login challenges, pairings and paired devices while preserving handoffs, receipts and payment intents. It supports a fresh host where the former live data directory is absent. Recovery does not automatically switch Compose mounts or start serving restored data.

For the separate cutover, stop the old API, preserve its data for incident review, point the reviewed release configuration at the new verified directory, and start exactly one API. Startup retention must run before serving, payment reconciliation must recover, and every user must sign in again. Verify a known paid file against its receipt, deny unpaid/expired access and confirm fresh backups before declaring recovery complete. Never run the old and restored API concurrently against different data directories for the same deployment.

## Verification delivered with this change

`node --import tsx --test --test-concurrency=2 test/ops.test.ts` checks real offline SQLite backup/recovery, original-byte equality, session revocation, active-server refusal, existing-target refusal, changed/extra files, symlinks, unchanged kernel-lock inode and mocked Compose recovery after snapshot failure. The shell script passes `bash -n`.

A native Linux Docker-volume check also reproduced the UID1000/mode700 access failure for capability-free root and verified recovery after private ownership normalization: original bytes and deliveries survived, sessions were revoked, and all Docker capabilities remained dropped. Its temporary volume and containers were removed. This verifies Linux file permissions, not encrypted offsite retrieval.

A real remote restic account, host systemd execution and an offsite restore are still operator acceptance gates. Mocked command tests do not establish storage availability or encryption-key recovery.
