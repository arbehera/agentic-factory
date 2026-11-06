#!/usr/bin/env bash
# Re-resolves the Compose stack's third-party images to digests and rewrites infra/compose/images.env.
# Review the diff like any dependency change (CLAUDE.md §9).
set -euo pipefail
cd "$(dirname "$0")/../.."
export DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"
declare -A TAGS=(
  [NODE_IMAGE]=node:22-bookworm-slim
  [POSTGRES_IMAGE]=postgres:16-bookworm
  [KEYCLOAK_IMAGE]=quay.io/keycloak/keycloak:26.4
  [MAILPIT_IMAGE]=axllent/mailpit:v1.27
  [SEAWEEDFS_IMAGE]=chrislusf/seaweedfs:3.97
  [NGINX_IMAGE]=nginxinc/nginx-unprivileged:1.29-alpine
  [K6_IMAGE]=grafana/k6:1.3.0
  # Must match @playwright/test in test/e2e/package.json.
  [PLAYWRIGHT_IMAGE]=mcr.microsoft.com/playwright:v1.65.0-noble
)
out=infra/compose/images.env
{
  echo "# Third-party images for the Compose stack, pinned by digest (hard rule 6, CLAUDE.md §9)."
  echo "# Resolved $(date -u +%F) on Docker Engine $(docker version -f '{{.Server.Version}}'). Update with scripts/dev/pin-images.sh and review the diff."
  for key in NODE_IMAGE POSTGRES_IMAGE KEYCLOAK_IMAGE MAILPIT_IMAGE SEAWEEDFS_IMAGE NGINX_IMAGE K6_IMAGE PLAYWRIGHT_IMAGE; do
    docker pull -q "${TAGS[$key]}" >/dev/null
    echo "$key=$(docker image inspect -f '{{index .RepoDigests 0}}' "${TAGS[$key]}")"
  done
} >"$out.tmp"
mv "$out.tmp" "$out"
echo "pinned: $out"
