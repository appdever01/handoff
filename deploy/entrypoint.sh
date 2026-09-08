#!/bin/sh
set -eu
umask 077
: "${DATA_DIR:=/data}"
test -d "$DATA_DIR"
test -w "$DATA_DIR"
exec flock --exclusive --nonblock --no-fork "$DATA_DIR/.runtime.lock" env HANDOFF_LOCK_MANAGED=1 "$@"
