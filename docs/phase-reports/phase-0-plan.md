# Phase 0 plan — Foundation

Date: 2026-11-04   Status: IN PROGRESS (phase `CURRENT` in `docs/phase-status.md`)
Sources: `spec.md` §11 Phase 0; ADLC-SDD-001 v0.5 §8, §10, §11, §15–§17, §21.

## 1. Work packages

| WP | Content | Requirements | Acceptance tests it feeds |
|---|---|---|---|
| P0-WP1 | Monorepo (pnpm + Turborepo), lint, typecheck, test, coverage, neutrality check, ADR process | FR-PCK-005, NFR-007 | AT-P0-07 |
| P0-WP2 | `packages/domain`, `packages/schemas`, `packages/db` (migrations for every §5 entity), audit with hash chain | NFR-001, NFR-006 | all (audit) |
| P0-WP3 | Orchestrator skeleton: state machine, leases + fencing, heartbeat, budgets, kill switch, leader election | FR-ORC-008, 011, 012, 015 | AT-P0-03, 05, 06 |
| P0-WP4 | Docker executor backend with the security baseline; agent-runtime image skeleton; deterministic "dummy agent" that edits a file and opens a PR | FR-ORC-013, 014 | AT-P0-01, 03, 05 |
| P0-WP5 | Tool gateway with `jira`, `github`, `decisions` MCP servers; per-role policy; secret injection; audit | spec §7, NFR-001 | AT-P0-01, 04 |
| P0-WP6 | Jira, GitHub and Keycloak configuration-as-code (sandbox first), with dry-run | FR-JIRA-001, FR-GH-001 | AT-P0-01, 04 |
| P0-WP7 | Jenkins verify pipeline skeleton; signer job on a dedicated node; write-once evidence store (one dummy reviewer verdict) | FR-CI-001, FR-EVD-001, FR-EVD-002 | AT-P0-01 |
| P0-WP8 | Pack SDK interfaces, product-profile loader, pack registry; `ind880-c` toolchain image skeleton | FR-PCK-001, 003 | AT-P0-01 |
| P0-WP9 | Importer parser + contract tests on Spec Kit 1.2.6 fixtures | FR-IMP-001, 002 | AT-P0-08 |
| P0-WP10 | Portal skeleton (fleet, run detail with SSE live logs, kill switch) + notifier (Needs Human, gate-ready; inbox + email) | FR-POR-001 (partial), FR-NOT-001 (partial) | AT-P0-01, 02, 05 |
| P0-WP11 | Compose deployment, PostgreSQL replica, failover runbook, k6 load-test harness | NFR-002, NFR-004 | AT-P0-05, 06 |

## 2. Order and branch plan

The order follows the dependencies: contracts and storage first, then the control plane, then the edges that need external systems.

| # | Branch | WP | Depends on | Why this position |
|---|---|---|---|---|
| 1 | `phase-0/p0-wp1-monorepo` | WP1 | — | Every other WP needs the build, lint and test gates; the neutrality check must exist before any core code. |
| 2 | `phase-0/p0-wp2-domain-db-audit` | WP2 | WP1 | Entities, IDs, state machines and the audit chain are used by every service. |
| 3 | `phase-0/p0-wp9-importer` | WP9 | WP2 (schemas) | Self-contained; closes AT-P0-08 early. |
| 4 | `phase-0/p0-wp8-pack-sdk` | WP8 | WP2 | The orchestrator routes by pack; interfaces must exist first. |
| 5 | `phase-0/p0-wp3-orchestrator` | WP3 | WP2, WP8 | Leases, fencing and leader election (PostgreSQL only: `SKIP LOCKED`, advisory locks). |
| 6 | `phase-0/p0-wp5-gateway` | WP5 | WP2, WP3 | The agent's only path to tools; policy and audit tested against `packages/testing` fakes. |
| 7 | `phase-0/p0-wp4-executor` | WP4 | WP3, WP5 | The container needs a gateway to talk to. |
| 8 | `phase-0/p0-wp7-evidence-signer` | WP7 | WP2, WP5 | Evidence store, signer (software key in dev only, OPEN-07), Jenkins skeleton. |
| 9 | `phase-0/p0-wp6-config-as-code` | WP6 | WP5 | Needs sandbox Jira/GitHub/Keycloak access (Q-04). Scripts are written and dry-run against fakes earlier. |
| 10 | `phase-0/p0-wp10-portal-notifier` | WP10 | WP3, WP4 | Shows live runs; kill-switch control. |
| 11 | `phase-0/p0-wp11-deploy-load-failover` | WP11 | all | Compose stack, replica, failover drill, k6 20-run load test. |

Each WP is one PR (or less). Conventional Commits with `Implements:` / `Tests:` IDs in the body.

## 3. Acceptance tests and how each is proven

| AT | Proof | Needs |
|---|---|---|
| AT-P0-01 | e2e on Compose with fakes (CI) **and** once in the sandbox with real Jira/GitHub/Jenkins | Q-04 sandbox |
| AT-P0-02 | Integration test with a fake clock (time-compressed SLA); email via a local SMTP sink | — |
| AT-P0-03 | Testcontainers PostgreSQL: stale token rejected; killed container → lease expiry → new lease resumes from `task/<KEY>` WIP | Docker (Q-03) |
| AT-P0-04 | Gateway-policy tests against fakes (CI) **and** real attempts by the agent identity in the sandbox; each must fail at the platform (Jira workflow condition, ruleset, branch protection), not only in the gateway | Q-04 sandbox |
| AT-P0-05 | k6 + 20 dummy containers on a Linux host | Q-03 |
| AT-P0-06 | Failover drill on Compose (primary stop → promote replica → orchestrator leader re-elected → leases continue) | Docker |
| AT-P0-07 | Vitest: seed a deny-listed string into a temp tree under `packages/`; the check exits non-zero | — |
| AT-P0-08 | Vitest contract tests over `test/fixtures/speckit-1.2.6/` plus malformed-line cases | Fixtures (Q-08) |

## 4. Open items and stubs in Phase 0

| OPEN | Stub (spec.md §12) | Where |
|---|---|---|
| OPEN-03 | `AnalysisAdapter` stub, results marked "baseline only" | WP8 (interface only in Phase 0) |
| OPEN-04 | `ind880-c` toolchain image is a stub; no SDK files | WP8 |
| OPEN-07 | Software signing key in dev only, behind the `Signer` interface | WP7 |
| OPEN-14 | Merge queue and ruleset APIs verified in the sandbox | WP6 |
| OPEN-21 | Teams/SMS channels are stubs | WP10 |
| OPEN-22 | Local Keycloak in Compose | WP6, WP10, WP11 |
| OPEN-23 | Local registry in dev | WP4, WP11 |
| OPEN-06 (no stub in spec §12) | Placeholder sandbox groups `adlc-approvers-<gate>` with test users only; no real names | WP6 |
| OPEN-08 (no stub in spec §12) | Not needed: the Phase 0 dummy agent is deterministic and makes no Claude API call | WP4 |

## 5. Questions for the human — answered 2026-11-05

| Q | Answer | Effect |
|---|---|---|
| Q-01 | Jenkins | Root `Jenkinsfile` calls `pnpm verify`. |
| Q-02 | Human creates the remote | Branches stay local until the URL is shared; then one PR per WP. |
| Q-03 | Rootless Docker in WSL2 on the dev machine | Container security and load tests (WP4, WP11) run in WSL2. Setup: `docs/runbooks/wsl2-rootless-docker.md`; check: `scripts/dev/check-rootless-docker.sh` (10 checks fail on 2026-11-05, before setup). |
| Q-04 | Sandbox later; fakes now | AT-P0-01/04 built against fakes + dry-run; reported "not run" until sandbox access exists. |
| Q-05 | SeaweedFS (Apache-2.0) | ADR-0006. S3-compatible `ObjectStore` adapter; used by the WORM export (WP11). |
| Q-06 | Pin Node 22 everywhere | `engines` = `>=22 <23`; CI and images use 22. The dev machine needs Node 22 installed (currently 24). |
| Q-07 | Not platform scope | Baseline data (OPEN-17) is a Program Lead task; noted in the phase report. |
| Q-08 | Provisional fixtures, then real | Provisional 1.2.6 fixtures marked as such; real `specify` 1.2.6 output must replace them before the phase report. |
| Q-09 | Scope OK; terms reviewed by the human / Pack Owner | ADR-0003 stays; the deny-list is updated as review comments arrive. |
| Q-10 | Add a sixth class `requirement` | spec.md §5 updated; domain, schema and DB migration 0002 updated; it never auto-resolves. |

### New questions

| Q | Question | Assumption until answered |
|---|---|---|
| Q-11 | A task's `{comp:}` (e.g. `ExposureCtrl`, SDD §3.1.2) names a module, but profile components are coarse (`ecu-firmware`, SDD §5.5), and SDD §5.5 routes "by the paths a task belongs to". How does a task map to its profile component? | `{comp:}` is used when it equals a profile component name; otherwise the task's paths decide, and every path must belong to one component (ADR-0008). |
| Q-13 | Is the wall-clock budget (S 1 h, M 4 h, L 8 h) per lease or per task in total? After a crash the next lease currently gets a fresh budget; loop detection (FR-ORC-010, Phase 3) limits repeats. | Per lease (ADR-0009). |
| Q-14 | What are the working hours and holiday calendar for notification SLAs (SDD §16.3 says Asia/Kolkata; hours and holidays not given)? | `config/working-calendar.yaml`: 09:00–18:00 Mon–Fri, no holidays (dev default). The real rota and approver groups are OPEN-06/OPEN-21; `config/rota.yaml` uses placeholder addresses. |
| Q-12 | spec.md §5 gives `ProductProfile.version`, but the SDD §5.5 example has no version field. | `metadata.version` (semver) is required in `.adlc/product-profile.yaml`. |

### Original questions

| Q | Question | Proposed default until answered |
|---|---|---|
| Q-01 | Which CI runs the **platform repo's own** checks: Jenkins (on-prem, like C14) or GitHub Actions? spec.md says "CI" without naming one. | One `pnpm verify` entry point that any CI can call; CI wiring waits for the answer. |
| Q-02 | The folder was not a Git repository. Where is the `adlc-platform` remote? | Local `git init` with the WP1 branch; nothing pushed. |
| Q-03 ⛔ | This dev machine is Windows; the Docker daemon is not running, and Docker Desktop is not rootless Docker. Hard rule 6 and AT-P0-03/05/06 need a **Linux host with rootless Docker**. Which host do we use? | Unit work continues; container and Testcontainers tests run when Docker is available and are reported as not run, never skipped silently. |
| Q-04 ⛔ | Sandbox Jira project, GitHub org/repos (GHEC, OPEN-14), Jenkins and Keycloak access for AT-P0-01/04/06. | Fakes + dry-run only; the ATs stay "fail/not run" until sandbox access exists. |
| Q-05 ⛔ | Object store for transcripts, logs and the WORM audit export (NFR-006 `REVIEW`). The suggested MinIO is **AGPL-3.0** (non-permissive → CLAUDE.md §10). | `ObjectStore` interface with a filesystem backend in dev; choice recorded in an ADR once you decide (options: MinIO under AGPL, SeaweedFS Apache-2.0, an existing Pioneer store). |
| Q-06 | The spec pins Node 22 LTS; this machine has Node 24. | `.nvmrc` = 22 and `engines >=22`; CI must run 22. |
| Q-07 | SDD §21 lists "human baseline data collected / go/no-go baselines recorded" in Phase 0 exit; spec.md §11 does not. Is this in Phase 0 platform scope? | Not built; recorded here as a difference to confirm (a data task, OPEN-17). |
| Q-08 | AT-P0-08 needs **real** `/speckit.tasks` 1.2.6 output. Can we generate the fixtures with `specify` 1.2.6, or will you supply them? | Hand-written fixtures in the documented 1.2.6 format, marked as provisional, until real output is captured. |
| Q-10 | spec.md §5 lists Decision classes clarification/consult/escalation/risk/gate, but FR-DEC-002 and SDD §8.6 also name **requirement** Decisions. Is "requirement" a sixth class, or a kind of clarification? | Not added. The five §5 classes are used; none of them can auto-resolve except consult. |
| Q-09 | Review the initial core-neutrality deny-list (`packages/config/neutrality-denylist.txt`). | Generic embedded toolchain, RTOS, MCU and analyser names; platform infrastructure (Docker, Jira, GitHub, Jenkins, Keycloak, PostgreSQL) is **not** denied because spec §4 puts it in the core. |

Notes:
- **k6** (load tests) is AGPL-3.0. The spec chose it, and we only run it as an external binary, so the licence obligations don't reach platform code. Noted here for the licence check.
- Drizzle (not Prisma) is used, as decided in CLAUDE.md §3. ADR-0002 records it.

## 6. Progress

| WP | Status |
|---|---|
| P0-WP1 | done locally on `phase-0/p0-wp1-monorepo` (uncommitted): workspace, strict TS, ESLint (no `any`, no `!`), Vitest + per-package coverage thresholds, `pnpm verify`, neutrality check + 12 tests (AT-P0-07 passes), ADR-0001–0003. Remaining: CI wiring (Q-01). |
| P0-WP2 | done locally on `phase-0/p0-wp2-domain-db-audit`:
- `@adlc/domain`: vocabularies, state machines, IDs, Decision invariants, hash chain. 100% line coverage; property-based tests.
- `@adlc/schemas`: boundary schemas.
- `@adlc/db`: Drizzle tables for every §5 entity, a partitioned append-only audit table, `AuditRepository`, and 11 PostgreSQL 16 integration tests.
- ADR-0004 and ADR-0005.
- Deferred: the WORM export (waits on Q-05); revoking UPDATE/DELETE/TRUNCATE from DB roles (P0-WP11). |
| P0-WP9 | done locally on `phase-0/p0-wp9-importer`:
- `@adlc/importer` parser + CLI (`import:tasks`).
- `tasks.import.json` Zod contract + committed JSON Schema.
- Contract test auto-discovers `test/fixtures/speckit-<ver>/` (2 **provisional** fixtures, golden files reviewed).
- 30 malformed-line cases, each with its line number; ADR-0007.
- **AT-P0-08 passes against provisional fixtures only.** Real `specify` 1.2.6 output must be added before the phase report (Q-08). |
| P0-WP8 | done locally on `phase-0/p0-wp8-pack-sdk`:
- `@adlc/pack-sdk`: §7 interfaces, profile and manifest loaders (strict YAML), task routing.
- `@adlc/schemas`: profile, tech-pack and process-pack contracts + JSON Schemas.
- `@adlc/domain`: pack lifecycle (Qualified needs a digest + 2 human approvers; production dispatch only on Qualified).
- `@adlc/db`: `PackVersionRepository` (immutable versions, audited transitions, X.Y resolution); DB tests share one container.
- `packs/tech/ind880-c`: Draft manifest + digest-pinned Dockerfile skeleton.
- ADR-0008.
- Deferred: adapter contract-test suites (with the first adapter, P0-WP7 / P3-WP7); gate floor FR-PCK-002 (Phase 3). |
| P0-WP3 | done locally on `phase-0/p0-wp3-orchestrator`:
- `@adlc/domain`: lease timing, budget levels.
- `@adlc/db`:
  - Leases with fencing: global token sequence, `withFence` share-lock, SKIP LOCKED reaper.
  - Run, budget-ledger and control-flag repositories; partition maintenance.
- `apps/orchestrator`:
  - Heartbeat (renew + usage + stop directive), reaper, kill switch, budgets, dispatcher skeleton.
  - Advisory-lock leader election + leader-only job runtime.
  - NestJS `/health`, `/ready`.
- `packages/testing` (shared Postgres harness), `packages/telemetry` (pino logger).
- ADR-0009.
- **AT-P0-03 passes for the orchestrator part** (container kill + WIP resume completes with P0-WP4).
- **AT-P0-06 passes in-process** (leader session killed → another replica leads, leases intact). The Compose primary/replica failover drill is P0-WP11.
- Deferred: PostgreSQL job queue for workers (P0-WP4, starting containers); component locks (Phase 3); notification of the 80 % month alert (P0-WP10); OpenTelemetry spans (NFR-005). |
| P0-WP5 | done locally on `phase-0/p0-wp5-gateway`:
- `apps/gateway`: session auth, policy, fencing, redaction, audit pipeline; MCP Streamable HTTP; health.
- `packages/mcp-servers`: jira, github, decisions tools with platform invariants.
- `packages/adapters`: IssueTracker and SourceControl ports, SecretProvider, redaction.
- Fakes in `packages/testing`.
- `rolePolicySchema` + `agents/dummy/policy.yaml`.
- DB: `gateway_session`, `DecisionRepository`, `decision.raised_by`.
- ADR-0010.
- **AT-P0-04 passes at the gateway layer** (no merge/approve/delete tools; Done, Gate and `main` refused, end to end over MCP). The platform layer needs P0-WP6 + sandbox.
- Security review finding fixed: Decision answers are bound to owner role, non-human route and a different raiser.
- Deferred: real Jira/GitHub clients and the gateway entrypoint (Q-04); injection screening and model-call logging (P0-WP7 / Phase 3). |
| P0-WP4 | done on `phase-0/p0-wp4-executor`:
- `packages/executor`: hardened Docker backend; daemon baseline; trusted digests; internal network.
- PostgreSQL job queue; `RunLauncher` / `Supervisor` / `Worker`; FR-ORC-014 slots.
- Gateway heartbeat endpoint; `packages/control-plane`.
- `apps/agent-runtime`: dummy agent, bundle, image.
- WSL2 runbook + check script. ADR-0011.
- Dev host: Ubuntu 24.04.1, WSL 2.6.3, Docker Engine 29.3.1 rootless.
- **Proven on rootless Docker:** an agent container from the inside (uid 65532, no caps, no-new-privs, seccomp, read-only root, no socket, limits, no egress, gateway reachable); the agent image runs under it.
- **Deferred:** containerised agent ↔ containerised gateway (P0-WP11 Compose); log archiving (P0-WP10/WP11); duplicate-PR check (needs real client, Q-04). |
| P0-WP7 | done on `phase-0/p0-wp7-evidence-signer`:
- `evaluateSigning` (4 conditions, property-tested).
- `packages/attestation`: DSSE + in-toto, software Ed25519 key dev-only (OPEN-07).
- Write-once `model_call` / `reviewer_verdict` / `evidence_record`.
- Gateway model proxy + `evidence.write_verdict` (review-target binding, one verdict per model call).
- `apps/signer`; dummy reviewer; reviewer sets; Jenkins verify skeleton; ADR-0012.
- **Proven in-process:** PR → verify → verdict → signed evidence → `adlc/evidence`; a push invalidates; request-changes blocks.
- **Deferred:** signer CLI and real GitHub (Q-04); merge-group / patch-id (P3-WP3); review dispatch (Phase 3; a minimal trigger for AT-P0-01 in P0-WP11); model streaming (Phase 1). |
| P0-WP10 | done on `phase-0/p0-wp10-portal-notifier`:
- Working-time deadlines and event catalogue (domain).
- Notification outbox + inbox (db); `apps/notifier` (route, escalate, deliver; SMTP).
- Supervisor raises Needs Human + Jira transition.
- `apps/portal-api`: OIDC/RBAC; fleet, run detail, NDJSON live logs, inbox ack, kill switch; no approve/merge routes.
- `apps/portal-web`: React skeleton. ADR-0013.
- **AT-P0-02 passes** (time-compressed: on-duty → backup → Program Lead → ack).
- **Deferred:** portal screenshots and Playwright e2e with Keycloak (P0-WP11); log-source topology (P0-WP11); full catalogue and digest (P3-WP6). |
| others | not started |

## 7. P0-WP11 breakdown (2026-11-06)

WP11 is the first time the services run as separate processes, so it starts by giving every service an entrypoint. Steps, each a commit on `phase-0/p0-wp11-deploy-load-failover`:

| Step | Content | Proves |
|---|---|---|
| 11a | **Runnable services.** Adapter selection in `@adlc/adapters` (`ADAPTERS=dev-fakes` → HTTP clients for a fakes service; the real Jira/GitHub clients refuse to start until Q-04). `apps/dev-fakes` serves the in-memory fakes over HTTP, plus admin calls that stand in for humans (seed, edit, approve and merge). Entrypoints for the gateway and portal-api; the orchestrator wires the executor, the issue tracker and a **minimal ready source** (Jira `To Do` tasks of registered projects; the full ready frontier FR-ORC-005 stays Phase 2). Live logs: the portal-api reads them from the orchestrator over an internal authenticated route, so only the executor host touches Docker. | units + integration |
| 11b | **Compose stack** (`infra/compose`, `pnpm dev:up`): PostgreSQL primary + streaming replica, one-shot migrate, dev-fakes, gateway (also on the internal agent network), two orchestrator replicas, notifier, portal-api, portal-web, Keycloak (dev realm), Mailpit (SMTP sink), SeaweedFS. Images pinned by digest. Services connect as an application DB role without UPDATE/DELETE/TRUNCATE on the write-once tables. | stack health |
| 11c | **AT-P0-05:** k6 scenario (`pnpm test:load`) seeds 20 dummy tasks and checks dispatch latency < 30 s, no heartbeat loss and that the portal lists all 20 runs. | AT-P0-05 |
| 11d | **AT-P0-06:** failover runbook and drill script: stop the primary, promote the replica, re-point the `db` alias, measure RTO; the leader is re-elected and leases resume. | AT-P0-06 |
| 11e | **AT-P0-01 with fakes:** fake CI posts `adlc/verify`, minimal review trigger + signer posts `adlc/evidence`, a human approves and merges through the dev-fakes admin call, the orchestrator sets Done. Playwright e2e and portal screenshots with Keycloak. | AT-P0-01 (fakes half) |
| 11f | WORM export of audit and evidence to SeaweedFS (ADR-0006). | NFR audit |

Decisions recorded in ADR-0014. The executor host role means the orchestrator container gets the rootless Docker socket. Agent containers never do (hard rule 6), and Kubernetes replaces this post-pilot.
