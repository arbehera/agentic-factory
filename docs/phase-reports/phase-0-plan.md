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

## 5. Questions for the human (blocking items marked ⛔)

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
| Q-09 | Review the initial core-neutrality deny-list (`packages/config/neutrality-denylist.txt`). | Generic embedded toolchain, RTOS, MCU and analyser names; platform infrastructure (Docker, Jira, GitHub, Jenkins, Keycloak, PostgreSQL) is **not** denied because spec §4 puts it in the core. |

Notes:
- **k6** (load tests) is AGPL-3.0. The spec chose it, and we only run it as an external binary, so the licence obligations don't reach platform code. Noted here for the licence check.
- Drizzle (not Prisma) is used, as decided in CLAUDE.md §3. ADR-0002 records it.

## 6. Progress

| WP | Status |
|---|---|
| P0-WP1 | done locally on `phase-0/p0-wp1-monorepo` (uncommitted): workspace, strict TS, ESLint (no `any`, no `!`), Vitest + per-package coverage thresholds, `pnpm verify`, neutrality check + 12 tests (AT-P0-07 passes), ADR-0001–0003. Remaining: CI wiring (Q-01). |
| others | not started |
