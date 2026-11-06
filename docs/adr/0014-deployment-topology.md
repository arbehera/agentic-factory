# 0014 — Deployment topology for Phase 0: runnable services, fakes over HTTP, executor host
Status: Proposed (confirm at Phase 0 review)   Date: 2026-11-06   Requirements: NFR-002, NFR-004, FR-ORC-005 (stand-in), FR-POR-001, AT-P0-01, AT-P0-05, AT-P0-06

## Context
P0-WP11 runs the platform as separate processes for the first time (Compose, failover drill, 20-run load test, AT-P0-01 with fakes). Until now the gateway and the portal API had no entrypoint, because the real Jira and GitHub clients wait for sandbox access (plan Q-04). The orchestrator had no source of work, because the ready frontier (FR-ORC-005) is Phase 2. ADR-0013 left open where the portal reads live logs from.

## Options considered
- **Fakes per process** (each service builds its own in-memory fake): rejected, because every process would see a different Jira and GitHub.
- **A fake that imitates the Jira and GitHub REST APIs**: rejected for now. It would mean guessing at API behaviour that Q-04 is meant to verify.
- **One fakes service behind the existing ports** (chosen): services talk to it through HTTP clients that implement `IssueTracker` and `SourceControl`, so it is exactly as capable as the ports, no more.

## Decision
1. **Explicit adapter selection.**
   - `createAdapters` in `@adlc/adapters` builds the IssueTracker and SourceControl from `ADAPTERS`, which has **no default**. `dev-fakes` builds HTTP clients for `apps/dev-fakes`.
   - `jira-github` refuses to start until the real clients exist (Q-04). A deployment cannot run half-configured.
2. **dev-fakes service** (dev and CI only).
   - It serves `@adlc/testing`'s in-memory fakes over HTTP (`POST /jira/<method>`, `POST /github/<method>`), and only the port methods. So, as with the ports, there is no merge, approve or delete route (hard rule 3).
   - Typed port errors (`IssueConflictError`, `IssueNotFoundError`, `BranchMovedError`) survive the round trip.
   - `/admin/*` calls stand in for humans (seed, edit an issue, push to a branch) and expose state to tests.
   - Every call needs a shared bearer token.
3. **Phase 0 ready source** (stand-in for FR-ORC-005).
   - `JiraReadySource` offers `To Do` tasks of active projects, plus `In Progress` tasks with no live lease (resume, AT-P0-03), oldest first, to one configured role (`DISPATCH_ROLE`). It reads Jira on every tick.
   - No blockers, DoR, priorities, component locks or fair share: those stay Phase 2.
4. **The Jira task follows its run**, as `adlc-orchestrator`.
   - Claim: To Do → In Progress, at launch.
   - Success: In Progress → In Review.
   - Failure: Needs Human (ADR-0013).
   - Each move re-reads the issue, follows the task state machine, loses to a concurrent human edit, and is audited.
   - A task a human moved after it was offered is not started: its lease is released and the run retired.
5. **Live-log topology.**
   - Only the executor host (the orchestrator replica with an executor) talks to Docker.
   - The portal API reads logs through the orchestrator's internal route `GET /internal/runs/:id/logs`. The route needs an internal service token (compared in constant time) and is off without one. The run's container is looked up there, never taken from the caller.
   - The portal tries each replica in turn, validates every NDJSON line, and ends a stream cleanly if the source fails mid-way.
6. **Executor host.** In Compose the orchestrator containers get the rootless Docker socket so they can start agent containers. Agent containers never get it (hard rule 6, ADR-0011). Kubernetes replaces this post-pilot (NFR-004).

7. **Minimal review flow (AT-P0-01; full review dispatch is P3-WP2).** A leader job checks each task In Review or Awaiting Approval against its PR (`task/<key>`), deterministically:
   - **CI green:** with `adlc/verify` green on the head, it requests one review run per required reviewer role (`agents/reviewer-sets.yaml`). The job is keyed by the head, so each head is reviewed once and a push triggers a new review.
   - **The review run:** it holds no task lease. Its gateway session may record a verdict only on that head, and it never moves the task.
   - **Signing:** once every verdict is in, it asks for a signature, once per head.
   - **Signed:** with `adlc/evidence` green, the task moves In Review → Awaiting Approval.
   - **Merged:** once the merge queue has merged the PR, Awaiting Approval → Done. Done is reserved for `adlc-orchestrator` and enforced by `assertTaskTransition`.
   - **Nothing approves or merges.** Without the human merge a task stays Awaiting Approval indefinitely (hard rules 2 and 3).
8. **Signing through the queue.** The orchestrator enqueues `sign-evidence` jobs. The signer (`apps/signer`) is a separate worker that claims only those jobs and holds the only key. It re-checks all four FR-EVD-002 conditions itself, so a request is never a decision. The queue stays in PostgreSQL (hard rule 8), and `Worker` moved to `@adlc/control-plane` so both services use it.
9. **Observing merges.** `SourceControl` gains two read-only operations, `findPullRequest(repo, head)` and `PullRequest.merged`, and still has no operation that merges. In the fake, `mergeAsHuman` is a test control that stands in for the human approval and the merge queue. It merges only with the required statuses green on the head.
10. **End-to-end with fakes.** `pnpm test:e2e` plays CI and the human. Playwright runs in the pinned image inside Keycloak's network namespace, so `localhost:8080` (the token issuer) is Keycloak and the portal is `portal-web:8080`. It signs in through the real login page and saves screenshots. The sandbox half of AT-P0-01 waits for Q-04.

## Consequences
- **Now runnable:** every service has an entrypoint and validated configuration; the composition roots are tested.
- **Socket risk:** the orchestrator container is as powerful as the rootless Docker user. This is accepted for the pilot and limited by rootless mode, and recorded as a risk in the phase report.
- **Found by running the stack:**
  - Services crashed when PostgreSQL closed idle connections; the pool now reports the error and reconnects.
  - The first ready source starved tasks behind in-flight ones, because leased tasks filled its fixed search window. The window is now `limit` plus the runs holding a slot.
- **Fakes vs reality:** the fakes do not model Jira workflow permissions or GitHub rulesets. Those are proven in the sandbox (AT-P0-04, Q-04).
