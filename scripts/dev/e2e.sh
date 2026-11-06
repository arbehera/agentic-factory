#!/usr/bin/env bash
# `pnpm test:e2e` (AT-P0-01 with fakes, P0-WP11): one dummy task through the whole Phase 0 flow on
# the running Compose stack, then the portal checked in a browser (Playwright, screenshots).
#   Jira To Do -> dispatch -> agent container -> PR -> adlc/verify (CI, played here) -> review run
#   -> verdict -> signer -> adlc/evidence -> Awaiting Approval -> human approval + merge queue
#   (dev-fakes admin call, played here) -> Jira Done.
# The sandbox half of AT-P0-01 (real Jira, GitHub, Jenkins) waits for plan Q-04. Requires `pnpm dev:up`.
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
repo=org/product
fakes() { curl -fsS -H "authorization: Bearer $FAKES_TOKEN" -H "content-type: application/json" "localhost:4000/$1" ${2:+-d "$2"}; }
state() { fakes admin/state | python3 -c "import json,sys; r=json.load(sys.stdin)['result']; $1"; }
fail() { echo "AT-P0-01 (fakes): FAIL — $*" >&2; exit 1; }
wait_for() { local what=$1 timeout=$2; shift 2; for _ in $(seq 1 "$timeout"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; fail "timed out after ${timeout}s waiting for $what"; }
status_is() { [ "$(state "print([i['status'] for i in r['issues'] if i['key']=='$key'][0])")" = "$1" ]; }

key="PILOT-$(( $(date +%s) % 100000 * 10 + 7 ))"
echo "e2e: $key To Do in Jira"
fakes admin/seedIssue "{\"args\":[{\"key\":\"$key\",\"type\":\"Task\",\"status\":\"To Do\",\"summary\":\"AT-P0-01 end to end\",\"description\":\"\"}]}" >/dev/null
wait_for "the dummy agent's PR and In Review" 120 status_is "In Review"
pr=$(state "print([p['number'] for p in r['pullRequests'] if p['head']=='task/$key'][-1])")
head=$(fakes github/getPullRequest "{\"args\":[\"$repo\",$pr]}" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['headSha'])")
echo "e2e: PR #$pr at $head; CI reports adlc/verify (played here as Jenkins)"
fakes github/setCommitStatus "{\"args\":[\"$repo\",\"$head\",{\"context\":\"adlc/verify\",\"state\":\"success\",\"description\":\"verify passed (e2e)\"}]}" >/dev/null
evidence_green() { [ "$(fakes github/checkStatuses "{\"args\":[\"$repo\",\"$head\"]}" | python3 -c "import json,sys; print([s['state'] for s in json.load(sys.stdin)['result'] if s['context']=='adlc/evidence'])")" = "['success']" ]; }
wait_for "the review run, the verdict and the signed adlc/evidence" 180 evidence_green
wait_for "Awaiting Approval" 60 status_is "Awaiting Approval"
echo "e2e: Awaiting Approval; a human approves and the merge queue merges (played here)"
fakes admin/mergeAsHuman "{\"args\":[\"$repo\",$pr]}" >/dev/null
wait_for "Done" 60 status_is "Done"
trail=$(docker exec adlc-pg-primary-1 psql -U adlc_owner -d adlc -Atc "select string_agg(reason, ' | ' order by seq) from audit_event where action = 'task.status' and target = 'task:$key'")
echo "e2e: Jira status trail: $trail"

echo "e2e: portal in a browser (Playwright $PLAYWRIGHT_IMAGE)"
mkdir -p test/e2e/results
docker run --rm --user 0:0 --network container:adlc-keycloak-1 --ipc=host -v "$PWD:/work" -w /work/test/e2e \
  -e E2E_TASK_KEY="$key" -e PORTAL_PASSWORD="$ADLC_DEV_USER_PASSWORD" -e CI=1 \
  "$PLAYWRIGHT_IMAGE" npx playwright test -c playwright.config.ts || fail "portal checks failed (test/e2e/results)"
echo "AT-P0-01 (fakes): PASS task=$key pr=$pr head=$head screenshots=test/e2e/results/*.png"
