#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "Handoff operations: $*" >&2; exit 1; }
private_file() {
  python3 - "$1" <<'PY'
import os, stat, sys
p = sys.argv[1]
s = os.lstat(p)
if not stat.S_ISREG(s.st_mode) or stat.S_IMODE(s.st_mode) & 0o077 or s.st_uid != os.geteuid():
    raise SystemExit("Private configuration must be a regular file owned by the current user with mode 600 or 400")
PY
}
command=${1:-preflight}
env_file=${HANDOFF_OPS_ENV:-/etc/handoff/ops.env}
private_file "$env_file"
set -a
source "$env_file"
set +a
: "${COMPOSE_FILE:?Set COMPOSE_FILE}"
: "${COMPOSE_PROJECT_NAME:?Set the actual deployed Compose project name}"
: "${COMPOSE_ENV_FILE:?Set COMPOSE_ENV_FILE}"
: "${HANDOFF_DATA_DIR:?Set HANDOFF_DATA_DIR}"
: "${RESTIC_REPOSITORY:?Set RESTIC_REPOSITORY}"
: "${RESTIC_PASSWORD_FILE:?Set RESTIC_PASSWORD_FILE}"
: "${BACKUP_TAG:?Set a unique host/environment BACKUP_TAG}"
private_file "$COMPOSE_ENV_FILE"
private_file "$RESTIC_PASSWORD_FILE"
API_SERVICE=${API_SERVICE:-api}
STATE_DIR=${STATE_DIR:-/var/lib/handoff-backup}
STAGING_DIR=${STAGING_DIR:-$STATE_DIR/staging}
DATA_UID=${DATA_UID:-1000}
DATA_GID=${DATA_GID:-1000}
KEEP_DAILY=${KEEP_DAILY:-7}
KEEP_WEEKLY=${KEEP_WEEKLY:-4}
KEEP_MONTHLY=${KEEP_MONTHLY:-6}
MAX_BACKUP_AGE_HOURS=${MAX_BACKUP_AGE_HOURS:-30}
MIN_FREE_GB=${MIN_FREE_GB:-5}
READINESS_URL=${READINESS_URL:-http://127.0.0.1:8080/api/ready}
for binary in docker restic flock curl python3; do command -v "$binary" >/dev/null || fail "Missing required tool: $binary"; done
for setting in DATA_UID DATA_GID KEEP_DAILY KEEP_WEEKLY KEEP_MONTHLY MAX_BACKUP_AGE_HOURS MIN_FREE_GB; do
  [[ ${!setting} =~ ^[0-9]+$ ]] || fail "Invalid numeric setting: $setting"
done
[[ $HANDOFF_DATA_DIR = /* && $STATE_DIR = /* && $STAGING_DIR = /* ]] || fail "Data and backup paths must be absolute"
if [[ $command = backup || $command = preflight || $command = check ]]; then
  [[ -d $HANDOFF_DATA_DIR && -f $HANDOFF_DATA_DIR/handoff.sqlite ]] || fail "Existing Handoff data directory required"
fi
HANDOFF_DATA_DIR=$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "$HANDOFF_DATA_DIR")
STATE_DIR=$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "$STATE_DIR")
STAGING_DIR=$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "$STAGING_DIR")
export HANDOFF_DATA_DIR
[[ $STATE_DIR != "$HANDOFF_DATA_DIR" && $STATE_DIR != "$HANDOFF_DATA_DIR/"* && $STAGING_DIR != "$HANDOFF_DATA_DIR" && $STAGING_DIR != "$HANDOFF_DATA_DIR/"* ]] || fail "Backups must be outside live data"
[[ $RESTIC_REPOSITORY = s3:https://* || $RESTIC_REPOSITORY = sftp:* || $RESTIC_REPOSITORY = rest:https://* ]] || fail "Configure an encrypted offsite repository over HTTPS or SFTP"
[[ $COMPOSE_PROJECT_NAME =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "Invalid Compose project name"
compose_files=("$COMPOSE_FILE")
compose_args=(--project-name "$COMPOSE_PROJECT_NAME" --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE")
if [[ -n ${COMPOSE_OVERRIDE_FILE:-} ]]; then
  compose_files+=("$COMPOSE_OVERRIDE_FILE")
  compose_args+=(-f "$COMPOSE_OVERRIDE_FILE")
fi
compose() { docker compose "${compose_args[@]}" "$@"; }
repo() { restic "$@" >> "$STATE_DIR/operations.log" 2>&1; }
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
exec 9>"$STATE_DIR/operations.lock"
if ! flock --nonblock 9; then
  if [[ $command = check ]]; then printf '%s\n' 'Health check deferred while maintenance is running.'; exit 0; fi
  fail "Another backup, restore or check is running"
fi
compose config --quiet
configured_image=$(compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"][sys.argv[1]]["image"])' "$API_SERVICE")
validate_stack() {
  local ids
  ids=$(docker ps --all --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter "label=com.docker.compose.service=$API_SERVICE" --filter "label=com.docker.compose.oneoff=False" --format '{{.ID}}')
  [[ $ids =~ ^[a-f0-9]{12,64}$ ]] || fail "Expected exactly one API container in the configured Compose project"
  docker inspect "$ids" | python3 "$(dirname "${BASH_SOURCE[0]}")/validate-stack.py" "$COMPOSE_PROJECT_NAME" "$API_SERVICE" "$HANDOFF_DATA_DIR" "$configured_image" "${compose_files[@]}"
}

disk_check() {
  python3 - "$HANDOFF_DATA_DIR" "$STATE_DIR" "$MIN_FREE_GB" <<'PY'
import pathlib, shutil, sys
for value in sys.argv[1:3]:
    path = pathlib.Path(value)
    while not path.exists(): path = path.parent
    if shutil.disk_usage(path).free < int(sys.argv[3]) * 1024**3:
        raise SystemExit("Handoff disk space is below the configured minimum")
PY
}
readiness() { curl --fail --silent --show-error --max-time 15 "$READINESS_URL" >/dev/null; }
repo_check() { repo snapshots --tag "$BACKUP_TAG" --latest 1; }
restart_api=0
cleanup() {
  status=$?
  if [[ $restart_api = 1 ]]; then
    if ! compose start "$API_SERVICE"; then printf '%s\n' 'CRITICAL: Handoff API could not be restarted' >&2; status=1; fi
  fi
  if [[ $status != 0 ]]; then printf '%s\n' 'Handoff operation failed; inspect the private operations log and service journal' >&2; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
case "$command" in
  preflight)
    validate_stack
    disk_check
    repo_check
    readiness
    printf '%s\n' 'Preflight passed; no services stopped and no snapshots changed.'
    ;;
  init-repository)
    repo init
    printf '%s\n' 'Encrypted offsite repository initialized.'
    ;;
  backup)
    validate_stack
    disk_check
    repo_check
    [[ ! -e $STAGING_DIR/snapshot ]] || fail "Previous staging snapshot exists; review it before retrying"
    mkdir -p "$STAGING_DIR"
    chmod 700 "$STAGING_DIR"
    chown "$DATA_UID:$DATA_GID" "$STAGING_DIR"
    running=$(compose ps --status running --services "$API_SERVICE")
    [[ $running = "$API_SERVICE" ]] || fail "Expected exactly one running API service"
    restart_api=1
    compose stop --timeout 120 "$API_SERVICE"
    compose run --rm --no-deps --user "$DATA_UID:$DATA_GID" -v "$STAGING_DIR:/backup" "$API_SERVICE" npm run ops -- backup /data /backup/snapshot
    compose start "$API_SERVICE"
    restart_api=0
    for attempt in $(seq 1 12); do if readiness; then break; fi; [[ $attempt != 12 ]] || fail "API did not become ready after backup"; sleep 5; done
    repo backup --tag "$BACKUP_TAG" "$STAGING_DIR/snapshot"
    repo check
    repo forget --tag "$BACKUP_TAG" --group-by host,tags,paths --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" --prune
    repo check
    date +%s > "$STATE_DIR/last-success"
    rm -rf -- "$STAGING_DIR/snapshot"
    printf '%s\n' 'Encrypted offsite backup and repository checks passed; API is running.'
    ;;
  restore-test|restore-recovery)
    snapshot=${2:?Supply snapshot id or latest}
    target=${3:?Supply a new absolute restore target}
    [[ $snapshot = latest || $snapshot =~ ^[a-f0-9]{8,64}$ ]] || fail "Invalid snapshot identifier"
    [[ $target = /* ]] || fail "Restore target must be absolute"
    target=$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "$target")
    [[ $target = /* && ! -e $target && $target != "$HANDOFF_DATA_DIR" && $target != "$HANDOFF_DATA_DIR/"* && $target != "$STAGING_DIR/"* ]] || fail "Restore target must be a fresh isolated absolute path"
    disk_check
    work=$(mktemp -d "$STATE_DIR/restore.XXXXXXXX")
    chmod 700 "$work"
    repo restore "$snapshot" --tag "$BACKUP_TAG" --path "$STAGING_DIR/snapshot" --target "$work" --verify
    recovered="$work$STAGING_DIR/snapshot"
    [[ -f $recovered/snapshot.json ]] || fail "Snapshot manifest missing from restored archive"
    python3 - "$recovered" <<'PYTHON'
import os, pathlib, stat, sys
root = pathlib.Path(sys.argv[1])
for base, directories, files in os.walk(root, followlinks=False):
    for path in [pathlib.Path(base), *(pathlib.Path(base) / name for name in directories + files)]:
        info = path.lstat()
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise SystemExit("Restored snapshot contains a symbolic link or special file")
        os.chown(path, 0, 0, follow_symlinks=False)
        os.chmod(path, 0o700 if stat.S_ISDIR(info.st_mode) else 0o600, follow_symlinks=False)
PYTHON
    output=$(mktemp -d "$STATE_DIR/recovery-output.XXXXXXXX")
    chmod 700 "$output"
    mkdir -p "$(dirname "$target")"
    operation=restore
    [[ $command != restore-recovery ]] || operation=restore-recovery
    docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0 --entrypoint node -e HANDOFF_LOCK_MANAGED=0 --tmpfs /tmp:rw,noexec,nosuid,size=64m -v "$recovered:/snapshot:ro" -v "$output:/restore" "$configured_image" --import tsx src/ops.ts "$operation" /snapshot /restore/data
    chown -R "$DATA_UID:$DATA_GID" "$output/data"
    chmod 700 "$output/data"
    mv --no-clobber --no-target-directory -- "$output/data" "$target"
    [[ ! -e $output/data ]] || fail "Restore target appeared during verification; verified data retained in private output directory"
    rm -rf -- "$work" "$output"
    printf '%s\n' 'Isolated restore verified. Live data was not replaced and the API was not stopped.'
    [[ $command != restore-recovery ]] || printf '%s\n' 'Recovered sessions, challenges, pairings and devices revoked. Review retention before a separately approved cutover.'
    ;;
  retention-dry-run)
    repo forget --tag "$BACKUP_TAG" --group-by host,tags,paths --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" --dry-run
    printf '%s\n' 'Retention preview saved in private operations.log; nothing removed.'
    ;;
  check)
    validate_stack
    disk_check
    readiness
    repo_check
    python3 - "$STATE_DIR/last-success" "$MAX_BACKUP_AGE_HOURS" <<'PY'
import pathlib, sys, time
p = pathlib.Path(sys.argv[1])
if not p.is_file() or not 0 <= time.time() - int(p.read_text().strip()) <= int(sys.argv[2]) * 3600:
    raise SystemExit("No sufficiently recent successful encrypted backup")
PY
    printf '%s\n' 'Readiness, disk, offsite access and backup age checks passed.'
    ;;
  *) fail 'Choose preflight, init-repository, backup, restore-test, restore-recovery, retention-dry-run or check' ;;
esac
