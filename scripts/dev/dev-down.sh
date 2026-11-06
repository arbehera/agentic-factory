#!/usr/bin/env bash
# `pnpm dev:down` stops the Compose stack; `pnpm dev:down --volumes` also deletes its data.
set -euo pipefail
cd "$(dirname "$0")/../.."
export DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"
AGENT_IMAGE=unused DOCKER_SOCKET=/dev/null docker compose -f infra/compose/compose.yaml --env-file infra/compose/images.env \
  --env-file infra/compose/.env down --remove-orphans "$@"
