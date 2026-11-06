#!/usr/bin/env bash
# Verifies the write-once audit/evidence export against itself and the database (NFR-006,
# ADR-0015). Read-only. Exits 1 on any finding. Requires `pnpm dev:up`.
set -euo pipefail
compose_dir="$(cd "$(dirname "$0")/../../infra/compose" && pwd)"
exec docker compose -f "$compose_dir/compose.yaml" --env-file "$compose_dir/images.env" --env-file "$compose_dir/.env" \
  exec -T orchestrator-a node apps/orchestrator/dist/audit-export-cli.js verify
