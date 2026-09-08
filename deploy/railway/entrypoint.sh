#!/bin/sh
set -eu
umask 077
: "${DATA_DIR:=/data}"
if [ "$DATA_DIR" != /data ] || [ "${RAILWAY_VOLUME_MOUNT_PATH:-/data}" != /data ]; then
  printf '%s\n' 'Attach the Railway persistent volume at /data and set DATA_DIR=/data.' >&2
  exit 78
fi
if [ -L /data ] || ! mountpoint -q /data; then
  printf '%s\n' 'A real persistent volume mounted at /data is required.' >&2
  exit 78
fi
if [ "$(id -u)" = 0 ]; then
  chown --no-dereference 1000:1000 /data
  chmod 0700 /data
  exec setpriv --reuid=1000 --regid=1000 --clear-groups --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all "$0" "$@"
fi
if [ "$(id -u)" != 1000 ] || [ "$(id -g)" != 1000 ] || [ ! -w /data ]; then
  printf '%s\n' 'The application requires a writable private volume and UID/GID 1000.' >&2
  exit 78
fi
if [ -L /data/.runtime.lock ] || { [ -e /data/.runtime.lock ] && [ ! -f /data/.runtime.lock ]; }; then
  printf '%s\n' 'The runtime lock must be a regular file inside the data volume.' >&2
  exit 78
fi
if [ "$#" = 0 ]; then
  printf '%s\n' 'An application command is required.' >&2
  exit 78
fi
exec flock --exclusive --nonblock --conflict-exit-code 73 --no-fork /data/.runtime.lock env HANDOFF_LOCK_MANAGED=1 "$@"
