# 0009 — Orchestrator control plane: leases, heartbeats, budgets, kill switch, leader election
Status: Proposed (confirm at Phase 0 review)   Date: 2026-11-05   Requirements: FR-ORC-008, FR-ORC-011, FR-ORC-012, FR-ORC-015, NFR-008, NFR-009

## Context
P0-WP3 builds the deterministic core of the orchestrator. spec.md fixes the numbers (TTL 15 min, heartbeat 5 min, S/M/L budgets, 80 % alert) but not the mechanisms.

## Decision
1. **Time is an input.** Every decision takes `now` from an injected `Clock`. The orchestrator never reads `now()` inside SQL, so behaviour is reproducible from DB state plus inputs (NFR-008), and tests can compress time.
2. **Leases and fencing (FR-ORC-008).**
   - **One row per task.** Each grant takes a token from the global `fencing_token_seq`, so tokens only grow, even across row deletion.
   - **Acquiring.** Acquisition is serialised per task with a transaction advisory lock (`hashtextextended('lease:' || taskKey, 0)`). A live lease → `LeaseHeldError`. An expired one is displaced, and its run is retired.
   - **Renewing.** `renew` works only with the current token while the lease is live, and never past `deadline_at`.
   - **Fenced writes.** `withFence` share-locks the lease row for the whole task-scoped write. A takeover therefore waits until the write commits, and a stale token never writes.
   - **Reaping.** The leader-only reaper deletes expired leases with `FOR UPDATE SKIP LOCKED`. It sets runs to `lost`, or to `stopped` if they never started.
   - **Auditing.** Grant, release and expiry are audited. Renewals are liveness, not state changes, and are not audited (`agent_run.heartbeat_at` records them).
   - **Budget scope (plan Q-13).** The wall-clock budget is per lease; a re-claimed task gets a fresh budget.
3. **Heartbeats.**
   - A heartbeat renews the lease, checks that the caller is the lease-holding run, and records liveness and usage in one fenced transaction.
   - The reply is `continue` or `stop-after-step`. It is `stop-after-step` when the kill switch is engaged or the task token cap is exhausted.
   - A stale or expired lease throws, and the executor must stop.
4. **Budgets (FR-ORC-011).**
   - **Ledger keys.** Usage is added atomically to three keys: `task:<key>`, `day:<project>:<YYYY-MM-DD>` and `month:<project>:<YYYY-MM>`, with UTC buckets.
   - **Caps.** The task cap is in tokens; the day and month caps are in USD.
   - **Effects.** An exhausted task cap → `stop-after-step`. An exhausted day cap → the dispatcher skips that project. The month alert at 80 % is returned now; the notification is P0-WP10.
5. **Kill switch (FR-ORC-012).**
   - **Storage.** A row in the new `control_flag` table, shared by all replicas. This is control-plane state, not a §5 entity.
   - **Who may toggle it.** Any actor may engage it; only a human may release it. Both need a reason and are audited.
   - **Effect.** While engaged, the dispatcher claims nothing and heartbeats answer `stop-after-step`.
6. **Leader election (FR-ORC-015).**
   - **Mechanism.** `pg_try_advisory_lock(ADVISORY_LOCKS.dispatcherLeader)` on one dedicated connection, polled every `LEADER_POLL_MS`. The leader runs `select 1` on every poll and steps down on any error. When its session dies, PostgreSQL frees the lock for the next replica.
   - **Leader-only jobs.** Dispatch, reap and audit-partition maintenance run only while leading. A job never overlaps itself, and a failure is logged and retried.
   - **Overlap is harmless.** For a moment an old leader and a new one may both act. Lease uniqueness and fencing tokens make that safe.
7. **Shell.** NestJS is used only for `/health` and `/ready` (NFR-009). It uses explicit `@Inject` tokens and `experimentalDecorators`, and does not rely on emitted metadata. Every service is a plain class built by `buildOrchestrator`.
8. **Test infrastructure.**
   - `packages/testing` holds the Testcontainers PostgreSQL harness: one container per run, a fresh database per test file.
   - It does not depend on `@adlc/db`; callers pass their own migrate function, so there is no dependency cycle.

## Consequences
- **Ready frontier.** The dispatcher's `CandidateSource` is empty until the Jira-backed frontier exists (FR-ORC-005, Phase 2). The AT-P0-01 flow supplies a source backed by a Jira fake.
- **Job queue.** Starting containers will run as PostgreSQL `SKIP LOCKED` jobs on worker replicas (P0-WP4).
