#!/usr/bin/env bash
# `pnpm audit:verify`: verifies the write-once audit/evidence export against itself and the
# database (NFR-006, ADR-0015). Read-only. Exits 1 on any finding. Requires `pnpm dev:up`.
set -euo pipefail
cd "$(dirname "$0")/../.."
export DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"
# exec only interpolates the file; the executor settings are not used by this command.
AGENT_IMAGE=unused DOCKER_SOCKET=/dev/null docker compose -f infra/compose/compose.yaml --env-file infra/compose/images.env \
  --env-file infra/compose/.env exec -T orchestrator-a node apps/orchestrator/dist/audit-export-cli.js verify
