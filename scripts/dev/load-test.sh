#!/usr/bin/env bash
# `pnpm test:load` (AT-P0-05, NFR-004): 20 concurrent dummy runs against the running Compose stack.
# Recreates the orchestrators with 20 executor slots, 5 s heartbeats and 60 s of dummy work, runs the
# k6 scenario on the Compose network, then restores the defaults. Requires `pnpm dev:up` first.
set -euo pipefail
cd "$(dirname "$0")/../.."
compose_dir=infra/compose
export DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"
set -a
# shellcheck disable=SC1091
. "$compose_dir/images.env"
# shellcheck disable=SC1091
. "$compose_dir/.env"
set +a
compose() {
  AGENT_IMAGE="$(docker image inspect -f '{{.Id}}' adlc-agent-runtime:dev)" DOCKER_SOCKET="${DOCKER_HOST#unix://}" \
    docker compose -f "$compose_dir/compose.yaml" --env-file "$compose_dir/images.env" --env-file "$compose_dir/.env" "$@"
}
runs="${RUNS:-20}"
heartbeat_ms="${HEARTBEAT_MS:-5000}"
mkdir -p test/load/results
echo "load-test: orchestrators with $runs slots, ${heartbeat_ms} ms heartbeats, 60 s dummy work"
EXECUTOR_SLOTS="$runs" AGENT_HEARTBEAT_MS="$heartbeat_ms" AGENT_DUMMY_WORK_MS=60000 compose up -d --wait orchestrator-a orchestrator-b
status=0
docker run --rm --user 0:0 --network adlc_adlc -v "$PWD/test/load:/scripts:ro" -v "$PWD/test/load/results:/out" \
  -e RUNS="$runs" -e HEARTBEAT_MS="$heartbeat_ms" -e FAKES_URL=http://dev-fakes:4000 -e FAKES_TOKEN="$FAKES_TOKEN" \
  -e PORTAL_API_URL=http://portal-api:3002 -e TOKEN_URL=http://keycloak:8080/realms/adlc/protocol/openid-connect/token \
  -e PORTAL_USER=platform-admin -e PORTAL_PASSWORD="$ADLC_DEV_USER_PASSWORD" \
  "$K6_IMAGE" run --quiet /scripts/twenty-runs.js || status=$?
echo "load-test: restoring default orchestrator settings"
compose up -d --wait orchestrator-a orchestrator-b >/dev/null
echo "load-test: k6 exit $status (summary: test/load/results/at-p0-05-summary.json)"
exit "$status"
