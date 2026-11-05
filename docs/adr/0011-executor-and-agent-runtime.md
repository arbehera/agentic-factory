# 0011 — Docker executor, agent network, run launch and the agent runtime
Status: Proposed (confirm at Phase 0 review)   Date: 2026-11-05   Requirements: FR-ORC-013, FR-ORC-014, FR-ORC-008, FR-ORC-015, hard rules 6, 8, 9

## Context
P0-WP4 runs every agent in its own container (hard rule 6) on the dev host from plan Q-03 (rootless Docker in WSL2, runbook `docs/runbooks/wsl2-rootless-docker.md`). A rootless daemon cannot program host firewall rules per container, but FR-ORC-013 still asks for a network allow-list.

## Decision
1. **One hardened container config, no options.**
   - **Where:** `hardenedContainerConfig`. Every spec first passes `assertHardenedRunSpec`, which fails closed, and the fake backend applies the same check.
   - **Filesystem:** read-only root; the only writable space is a size-capped tmpfs at `/workspace` and a `noexec` tmpfs at `/tmp`. Together they are the disk limit.
   - **Privileges:** uid 65532, `CapDrop: ALL`, `no-new-privileges`, the daemon's default seccomp, no privileged mode, no binds or mounts (so no Docker socket and no host paths).
   - **Limits:** memory with no swap, CPU, PIDs. Also private IPC, an init process, no restart policy, and capped JSON logs.
2. **Daemon baseline.** The backend refuses a daemon without rootless mode, seccomp or cgroup v2.
3. **Images.**
   - Images must be referenced by digest: a repo digest, or a local image ID in dev.
   - Until image signing exists (OPEN-23), a digest must also be on the backend's trusted-image list.
   - Both Dockerfiles refuse a base image that is not digest-pinned.
4. **Network allow-list = the gateway only.**
   - Agent containers join one `internal` Docker network (no route out), and the gateway is the only service on it.
   - **Why that's enough:** agents reach Git only through the `github` tools and test targets only through gateway tools (later). Claude API calls will go through the gateway when model-call logging arrives (FR-EVD-002, P0-WP7 / Phase 3).
   - This is narrower than the SDD list (gateway, Git, Claude API, test targets), and a rootless daemon enforces it without host firewall rules.
   - The backend creates the network as internal and refuses an existing network that is not.
5. **Launch path.**
   - **Dispatcher (leader):** claims the task, then enqueues `start-run` in the PostgreSQL job queue (hard rule 8). The queue uses `FOR UPDATE SKIP LOCKED`, lock leases, dedupe keys and retries.
   - **`RunLauncher` (every replica's worker):**
     - re-checks the run's live lease;
     - issues the run's gateway session (bound to the fencing token, expiring at the lease deadline);
     - creates and starts the container.
   - **Container environment:** six non-secret variables, plus the session token as the only credential.
   - **Launch failure:** the container is removed, the session revoked, the lease released and the run ended.
   - **Slots:** FR-ORC-014 uses 8 slots, at most 2 for sandbox projects (`project.environment`). Both numbers are configuration.
6. **Supervision (leader).** Exit codes are a contract (`RUN_EXIT_CODES`): `0` succeeded, `3` stopped on directive, anything else failed; a vanished container means `lost`. On any exit the session is revoked and the lease released. Succeeded and stopped containers are removed; failed ones are kept for diagnosis until logs are archived (P0-WP10/WP11).
7. **Heartbeats go through the gateway** (`POST /runtime/heartbeat`), the only endpoint an agent can reach.
   - The fencing token comes from the session, never from the request, so a run can renew only its own lease.
   - A `409` means the lease is gone and the run must stop.
   - Heartbeat, budget and kill-switch logic moved to `packages/control-plane`, so the gateway and orchestrator share it without an app-to-app dependency.
8. **Agent runtime.**
   - One bundled ESM file on a digest-pinned Node 22 base, running as uid 65532.
   - The bundle step fails if a Docker client ends up in it. The agent side imports only `@adlc/executor/contract`.
   - The Phase 0 dummy role is deterministic and repeat-safe, so a resumed run continues on its branch without duplicate commits.

## Consequences
- **Proof today:**
  - the hardened container, probed from inside on rootless Docker;
  - the agent image running under the executor;
  - the dummy agent through a real in-process gateway;
  - launch and supervise against the fake backend.
- **Still to prove:** the containerised agent talking to a containerised gateway on the internal network is the Compose topology (P0-WP11, AT-P0-01).
- **Known gap:** re-running the dummy agent after its PR was opened opens a second PR. Real GitHub refuses duplicates with HTTP 422; a "find open PR" read tool is added when the real client exists (Q-04).
- **Docker suites:** they skip, and report as skipped, without a rootless daemon. The Linux runner and CI set `ADLC_REQUIRE_ROOTLESS_DOCKER=1` so a skip becomes a failure.
