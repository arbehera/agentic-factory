#!/usr/bin/env bash
# `pnpm test:failover` (AT-P0-06, NFR-002): control-plane failover drill on the Compose stack.
# Simulates losing the primary site: the PostgreSQL primary and the leader orchestrator stop while
# a run is in flight. The runbook steps follow (docs/runbooks/control-plane-failover.md): promote
# the replica, move the `db` alias to it. Then the drill checks:
#   - a surviving orchestrator becomes leader, and the RTO (primary loss -> leader ready) is < 1 h;
#   - the in-flight lease survives with the same fencing token, keeps renewing, and its run succeeds;
#   - new work is dispatched after the failover.
# Destructive for the dev stack: afterwards the replica is the primary and there is no standby.
# Reset with `pnpm dev:down --volumes && pnpm dev:up`.
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
sql() { docker exec "$1" psql -U adlc_owner -d adlc -Atc "$2"; }
fakes() { curl -fsS -H "authorization: Bearer $FAKES_TOKEN" -H "content-type: application/json" "localhost:4000/$1" ${2:+-d "$2"}; }
leader_port() { for p in 3100 3101; do curl -fsS -m 2 "localhost:$p/ready" 2>/dev/null | grep -q '"leader":true' && { echo "$p"; return 0; }; done; return 1; }
fail() { echo "FAILOVER DRILL: FAIL — $*" >&2; exit 1; }
wait_for() { local what=$1 timeout=$2; shift 2; for _ in $(seq 1 "$timeout"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; fail "timed out after ${timeout}s waiting for $what"; }

echo "drill: preconditions"
[ "$(sql adlc-pg-primary-1 "select state from pg_stat_replication limit 1")" = "streaming" ] || fail "the replica is not streaming"
echo "drill: orchestrators with 5 s heartbeats and 90 s dummy work (a run is in flight during the failover)"
AGENT_HEARTBEAT_MS=5000 AGENT_DUMMY_WORK_MS=90000 compose up -d --wait orchestrator-a orchestrator-b >/dev/null
wait_for "a leader" 60 leader_port

key="PILOT-$(( $(date +%s) % 100000 * 10 ))"
fakes admin/seedIssue "{\"args\":[{\"key\":\"$key\",\"type\":\"Task\",\"status\":\"To Do\",\"summary\":\"failover drill\",\"description\":\"\"}]}" >/dev/null
running() { [ "$(sql adlc-pg-primary-1 "select state from agent_run where task_key = '$key' order by created_at desc limit 1")" = "running" ]; }
wait_for "the in-flight run" 60 running
read -r token expires_before < <(sql adlc-pg-primary-1 "select fencing_token, extract(epoch from expires_at)::bigint from lease where task_key = '$key'" | tr '|' ' ')
lag=$(sql adlc-pg-primary-1 "select coalesce(pg_wal_lsn_diff(sent_lsn, replay_lsn), 0) from pg_stat_replication limit 1")
old_leader=$(leader_port)
old_leader_service=$([ "$old_leader" = 3100 ] && echo orchestrator-a || echo orchestrator-b)
echo "drill: run for $key in flight (fencing token $token); replication lag ${lag} bytes; leader $old_leader_service"

t0=$(date +%s)
echo "drill: primary site lost — stopping pg-primary and $old_leader_service"
docker stop adlc-pg-primary-1 "adlc-$old_leader_service-1" >/dev/null

echo "drill: runbook step 1 — promote the replica"
docker exec adlc-pg-replica-1 psql -U adlc_owner -d adlc -Atc "select pg_promote(true, 60)" | grep -q t || fail "pg_promote failed"
echo "drill: runbook step 2 — move the db alias to the promoted replica"
docker network disconnect adlc_adlc adlc-pg-replica-1
docker network connect --alias db --alias pg-replica adlc_adlc adlc-pg-replica-1
wait_for "a new leader" 300 leader_port
t1=$(date +%s)
rto=$(( t1 - t0 ))
echo "drill: new leader on port $(leader_port) after ${rto}s"
[ "$rto" -lt 3600 ] || fail "RTO ${rto}s exceeds 1 h"

echo "drill: checking the in-flight lease"
renewed() { [ "$(sql adlc-pg-replica-1 "select fencing_token from lease where task_key = '$key' and extract(epoch from expires_at) > $expires_before")" = "$token" ]; }
wait_for "a heartbeat to renew the lease on the promoted database" 120 renewed
done_ok() { [ "$(sql adlc-pg-replica-1 "select state from agent_run where task_key = '$key' order by created_at desc limit 1")" = "succeeded" ]; }
wait_for "the in-flight run to finish" 240 done_ok
runs=$(sql adlc-pg-replica-1 "select count(*) from agent_run where task_key = '$key'")
[ "$runs" = 1 ] || fail "$key needed $runs runs; the lease did not survive"

echo "drill: checking that new work is dispatched"
key2="${key}1"
fakes admin/seedIssue "{\"args\":[{\"key\":\"$key2\",\"type\":\"Task\",\"status\":\"To Do\",\"summary\":\"after failover\",\"description\":\"\"}]}" >/dev/null
claimed() { [ -n "$(sql adlc-pg-replica-1 "select id from agent_run where task_key = '$key2'")" ]; }
wait_for "a run for $key2" 60 claimed

echo "AT-P0-06: PASS rto_seconds=$rto replication_lag_bytes=$lag lease_token=$token task=$key"
