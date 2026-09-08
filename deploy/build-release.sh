#!/bin/sh
set -eu
: "${1:?Supply the release environment file}"
deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for service in scanner media-image api preview-worker gateway; do
  COMPOSE_PARALLEL_LIMIT=1 docker compose --env-file "$1" -f "$deploy_dir/compose.yaml" build "$service"
done
