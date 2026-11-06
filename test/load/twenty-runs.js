// AT-P0-05 / NFR-004: 20 concurrent dummy runs on the Compose stack (P0-WP11).
// Pass criteria (thresholds below):
//   - dispatch latency < 30 s: seeded in Jira -> run claimed, for every task;
//   - no heartbeat loss: while a run is running, its last heartbeat is never older than two
//     intervals, and every run ends succeeded (no lease lost or reaped);
//   - the portal shows all runs: at one moment the portal API lists all 20 as running.
// Run with `pnpm test:load` (scripts/dev/load-test.sh), which sets the environment below.
import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const RUNS = Number(__ENV.RUNS || 20);
const HEARTBEAT_S = Number(__ENV.HEARTBEAT_MS || 5000) / 1000;
const FAKES = __ENV.FAKES_URL;
const PORTAL = __ENV.PORTAL_API_URL;

const dispatchLatency = new Trend("adlc_dispatch_latency_ms", true);
const heartbeatAge = new Trend("adlc_heartbeat_age_s");
const concurrentRunning = new Trend("adlc_concurrent_running");
const notSucceeded = new Counter("adlc_runs_not_succeeded");

export const options = {
  scenarios: { twenty: { executor: "shared-iterations", vus: 1, iterations: 1, maxDuration: "15m" } },
  thresholds: {
    adlc_dispatch_latency_ms: ["max<30000"],
    adlc_heartbeat_age_s: [`max<${2 * HEARTBEAT_S + 2}`],
    adlc_concurrent_running: [`max>=${RUNS}`],
    adlc_runs_not_succeeded: ["count==0"],
    checks: ["rate==1"],
  },
};

function token() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = http.post(__ENV.TOKEN_URL, { grant_type: "password", client_id: "adlc-portal", username: __ENV.PORTAL_USER, password: __ENV.PORTAL_PASSWORD, scope: "openid" });
    if (res.status === 200) return res.json("access_token");
    if (res.status !== 0 && res.status < 500) fail(`token request failed: HTTP ${res.status} ${res.body}`);
    sleep(2); // Keycloak still starting
  }
  fail("token request failed: Keycloak did not answer");
}

const fakes = (path, args) => http.post(`${FAKES}/${path}`, JSON.stringify({ args }), { headers: { authorization: `Bearer ${__ENV.FAKES_TOKEN}`, "content-type": "application/json" } });

const TERMINAL = ["succeeded", "failed", "stopped", "lost"];

export default function () {
  let bearer = token();
  const base = (Math.floor(Date.now() / 1000) % 100000) * 100;
  const seededAt = {};
  for (let i = 0; i < RUNS; i++) {
    const key = `PILOT-${base + i}`;
    const res = fakes("admin/seedIssue", [{ key, type: "Task", status: "To Do", summary: `load test ${i + 1}/${RUNS}`, description: "" }]);
    check(res, { "task seeded": (r) => r.status === 200 });
    seededAt[key] = Date.now();
  }
  const keys = Object.keys(seededAt);
  const claimed = {};
  const deadline = Date.now() + 12 * 60_000;
  let latest = {};
  while (Date.now() < deadline) {
    let res = http.get(`${PORTAL}/api/runs`, { headers: { authorization: `Bearer ${bearer}` } });
    if (res.status === 401) {
      bearer = token();
      res = http.get(`${PORTAL}/api/runs`, { headers: { authorization: `Bearer ${bearer}` } });
    }
    if (res.status !== 200) fail(`portal /api/runs: HTTP ${res.status}`);
    latest = {};
    for (const run of res.json()) {
      if (!(run.taskKey in seededAt)) continue;
      if (!(run.taskKey in latest)) latest[run.taskKey] = run; // rows are newest first
      const created = Date.parse(run.createdAt);
      if (!(run.taskKey in claimed) || created < claimed[run.taskKey]) claimed[run.taskKey] = created;
      if (run.state === "running" && run.heartbeatAgeSeconds !== null) heartbeatAge.add(run.heartbeatAgeSeconds);
    }
    concurrentRunning.add(Object.values(latest).filter((r) => r.state === "running").length);
    if (keys.every((k) => latest[k] && TERMINAL.includes(latest[k].state))) break;
    sleep(2);
  }
  for (const k of keys) {
    if (k in claimed) dispatchLatency.add(claimed[k] - seededAt[k]);
    else dispatchLatency.add(Number.MAX_SAFE_INTEGER); // never claimed: fail the threshold
    if (!latest[k] || latest[k].state !== "succeeded") notSucceeded.add(1, { task: k, state: latest[k] ? latest[k].state : "missing" });
  }
  const state = http.get(`${FAKES}/admin/state`, { headers: { authorization: `Bearer ${__ENV.FAKES_TOKEN}` } }).json("result");
  const reviewed = state.issues.filter((i) => i.key in seededAt && i.status === "In Review").length;
  check(reviewed, { "every task is In Review with its PR": (n) => n === RUNS });
}

export function handleSummary(data) {
  const m = (name, stat) => (data.metrics[name] ? data.metrics[name].values[stat] : null);
  const line = `AT-P0-05: runs=${RUNS} dispatch_latency_ms max=${m("adlc_dispatch_latency_ms", "max")} p95=${m("adlc_dispatch_latency_ms", "p(95)")} ` +
    `heartbeat_age_s max=${m("adlc_heartbeat_age_s", "max")} concurrent_running max=${m("adlc_concurrent_running", "max")} not_succeeded=${m("adlc_runs_not_succeeded", "count") || 0}\n`;
  return { stdout: line, "/out/at-p0-05-summary.json": JSON.stringify(data, null, 2) };
}
