#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
HANDOFF_REMOTE="$(git remote get-url origin)"
for surface in frontend backend docs; do
  if [ -e "$surface" ]; then
    if [ ! -e "$surface/.git" ]; then
      printf '%s exists but is not an independent clone.\n' "$surface" >&2
      exit 1
    fi
    git -C "$surface" rev-parse --is-inside-work-tree >/dev/null
  else
    git clone --branch "$surface" --single-branch "$HANDOFF_REMOTE" "$surface"
  fi
done
