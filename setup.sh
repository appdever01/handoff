#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
HANDOFF_REMOTE="$(git remote get-url origin)"
for surface in frontend backend docs; do
  if [ -e "$surface" ]; then
    git -C "$surface" rev-parse --is-inside-work-tree >/dev/null
  else
    git clone --branch "$surface" --single-branch "$HANDOFF_REMOTE" "$surface"
  fi
done
