# ADLC Platform — Build Specification (spec.md)

| Item | Value |
|---|---|
| Document | ADLC Platform build specification for Claude Code |
| Version | 0.1 — draft for review by Arabinda Behera |
| Source design | ADLC-SDD-001 v0.5 "Agentic Development Lifecycle (ADLC) System Design" (section numbers below as `[SDD §n]`) |
| Audience | Claude Code (implementer) and the ADLC platform team (reviewers) |
| Status markers | `REVIEW:` = decision to confirm before the phase starts. `OPEN-nn` = open item from SDD §22; never invent an answer, use the stub described. |

---

## 0. How to use this specification

1. **Build phase by phase.** Phases are in §11. Work only on the phase recorded as current in `docs/phase-status.md`. A phase ends with its acceptance tests passing and a phase report (template in CLAUDE.md). The next phase starts only after a human records approval in `docs/phase-status.md`.
2. **Requirement IDs.** Every requirement has an ID (`FR-<area>-nnn`, `NFR-nnn`, `AT-P<phase>-nn`). Code, tests and PRs reference the IDs they implement or verify.
3. **Precedence.** This spec governs the build. Where it is silent, follow the SDD. Where the two conflict, stop and raise the conflict; do not choose.
4. **This platform is not built by ADLC.** ADLC agents do not exist yet. It is built by the platform team using Claude Code.

---

## 1. What we are building

ADLC is an on-prem platform where role-based AI agents (Product Manager, Architect, Security Engineer, Process Engineer, Scrum Master, Senior Engineer, Engineer pool, Code Reviewer, QA Engineer, DevOps; HW Engineer and Program Manager in Release 2) carry out product-engineering work. Humans approve at defined gates. [SDD §1, §6]

| Half | What it does | How |
|---|---|---|
| Front half | Idea → specs → plan → tasks | GitHub Spec Kit 1.2.6 plus a Pioneer bundle (preset, extension, workflow), run headlessly by agents [SDD §3.1] |
| Seam | Tasks into Jira | Pioneer task importer [SDD §3.3] |
| Back half | Task → reviewed, signed, merged change | Pioneer-owned task pipeline (S0–S12) that applies AI-SDLC *practices*. No AI-SDLC code is used. [SDD §3.2, §8] |

The core is **technology-neutral**. Process packs, technology packs and a per-product profile supply everything technology-specific [SDD §5]. The pilot uses the ASPICE process pack and the iND880 embedded-C reference pack [SDD Appendix F].

---

## 2. Scope of the build

**In scope:** everything in §4–§10 across the phases in §11.

**Out of scope:**
- Building the pilot product itself (the platform's agents do that from Phase 1 onward, under human gates).
- Physical HIL bench hardware.
- Writing Pioneer QMS templates (OPEN-01; the platform consumes them).
- Kubernetes backend (post-pilot; design for it, do not build it) [SDD §17.4].
- Any AI-SDLC runtime code.

---

## 3. Architecture (components)

| ID | Component | Responsibility | SDD |
|---|---|---|---|
| C1 | **Orchestrator** | Deterministic control plane: lifecycle state machine, Spec Kit workflow runner, DoR engine, dispatch (frontier, locks, back-pressure, fair share), leases, budgets, Decisions, gate tracking, kill switch. Never calls an LLM to decide anything. | §8 |
| C2 | **Executor backend** | Creates, runs and destroys one container per agent run (Docker in the pilot) behind the `ExecutorBackend` interface | §17.2, §17.4 |
| C3 | **Agent runtime** | Runs inside the executor container: Claude Agent SDK (TypeScript) with the role definition, pack skills, work packet and gateway-provided tools; heartbeats; pushes WIP | §14 |
| C4 | **Tool gateway** | MCP servers (jira, github, jenkins, test-target, analysis, docs, qms, trace, decisions, evidence) with per-role policy, secret injection, injection screening and audit | §11 |
| C5 | **Importer** | Parses Spec Kit 1.2.6 `tasks.md` plus Pioneer tokens into `tasks.import.json`; after G4, creates Jira issues idempotently | §3.3 |
| C6 | **Trace service** | Global ID allocation, trace graph, gap reports, effective-requirements view, impact queries | §9.2, §9.3 |
| C7 | **QMS renderer** | Renders Markdown masters into Pioneer .docx/.xlsx templates; render-diff check | §9.4, §12.4 |
| C8 | **Evidence service + signer** | Write-once evidence store (reviewer verdicts, check results); signing job in a separate trust domain (DSSE/in-toto) | §8.5, §15.1 |
| C9 | **Agent Operations Portal** | Web UI and API: fleet, run detail, live logs, failures, queues, packs, capacity and cost, audit; audited controls | §16.2 |
| C10 | **Notification service** | Event catalogue, routing, rota, escalation, channels | §16.3 |
| C11 | **Pack SDK + packs** | Pack interfaces, product-profile loader, pack registry and qualification; `ind880-c` reference pack; `cloud-ts` second pack (Release 2) | §5, App. F |
| C12 | **Spec Kit bundle `pioneer-adlc`** | Preset `pioneer-aspice`, extension `pioneer`, workflow `pioneer-aspice` | §3.1 |
| C13 | **Agent definitions** | `AgentDefinition` YAML, prompts, skills, eval suites, canary corpus per role | §14 |
| C14 | **CI/CD integration** | Jenkins pipelines (verify, main, nightly, release), required GitHub statuses | §12.1 |
| C15 | **Platform configuration-as-code** | Jira workflow and fields, GitHub rulesets and branch protection, Keycloak realm — as reviewed scripts/manifests | §10 |

**External systems:** Jira Cloud, GitHub Cloud (Enterprise Cloud assumed, OPEN-14), Jenkins, Claude API, Keycloak, KMS/HSM, internal container registry, SMTP, optional Teams/SMS.

---

## 4. Technology stack and repository layout

### 4.1 Stack (decided)

| Area | Choice |
|---|---|
| Language | TypeScript 5.x, `strict: true`, Node.js 22 LTS |
| Monorepo | pnpm workspaces + Turborepo |
| Services | NestJS (orchestrator, gateway, portal-api, notifier, importer service, trace, evidence) |
| Portal UI | React 18 + Vite + TanStack Query; server-sent events for live updates |
| Database | PostgreSQL 16 (primary + streaming replica). Job queue on PostgreSQL (`SKIP LOCKED`). **No Redis, no BullMQ.** |
| ORM / migrations | Drizzle ORM + drizzle-kit (REVIEW: or Prisma) |
| Validation | Zod schemas, generated JSON Schema for YAML configs |
| Agent runtime | `@anthropic-ai/claude-agent-sdk` (TypeScript), API-key authentication only |
| MCP | `@modelcontextprotocol/sdk` |
| Containers | Docker Engine (rootless) via `dockerode` in the Docker backend |
| Auth (portal) | Keycloak (OIDC); shared realm with the ASPICE Process Portal (OPEN-22) |
| Logging / telemetry | pino (JSON) + OpenTelemetry (traces, metrics) |
| Testing | Vitest (unit), Testcontainers (PostgreSQL), Playwright (portal e2e), k6 (load) |
| Spec Kit | `specify` CLI 1.2.6 (Python, pinned) inside agent images |
| QMS rendering | docxtemplater + exceljs (REVIEW: or Python docxtpl in a sidecar) |
| Signing | DSSE envelopes, in-toto statements; KMS/HSM via PKCS#11 or cloud-KMS-compatible API (OPEN-07) |

### 4.2 Repository layout (`adlc-platform`)

```
adlc-platform/
  CLAUDE.md  spec.md  README.md
  docs/            phase-status.md, phase-reports/, adr/, runbooks/, design/ADLC-SDD-001-v0.5.docx (reference)
  apps/
    orchestrator/  gateway/  portal-api/  portal-web/  notifier/
    importer/      trace/    evidence/    signer/      qms-renderer/
    agent-runtime/                       # entrypoint baked into every agent image
  packages/
    domain/        # entities, state machines, IDs (no I/O)
    schemas/       # Zod + JSON Schema for all YAML/JSON contracts
    db/            # migrations, repositories
    pack-sdk/      # BuildAdapter, AnalysisAdapter, BudgetSchema, TestTargetAdapter, ReleaseAdapter, SkillBundle
    executor/      # ExecutorBackend interface + docker backend
    adapters/      # jira, github, jenkins, smtp, teams (stub), sms (stub), keycloak
    mcp-servers/   # one module per MCP server
    telemetry/  testing/  config/
  packs/
    process/aspice-cyber/          # process pack
    tech/ind880-c/                 # reference technology pack (Dockerfile, adapters, skills, fragments, evals)
    tech/cloud-ts/                 # Release 2
  bundles/pioneer-adlc/            # Spec Kit preset, extension, workflow, bundle.yml
  agents/<role>/                   # agent.yaml, prompt.md, checklists; evals/<role>/; canaries/
  infra/
    compose/                       # pilot deployment (Docker Compose)
    jira/ github/ keycloak/ jenkins/   # configuration-as-code
    k8s/                           # placeholders only until post-pilot
  test/e2e/  test/load/  test/fixtures/speckit-1.2.6/
```

---

## 5. Domain model

Store only what Jira and Git must not hold [SDD §4.2 P3]. **Never store a copy of Jira task content** beyond the cache needed for a dispatch decision; always re-read before acting.

| Entity | Key fields | Notes |
|---|---|---|
| `Project` | id, name, jiraProjectKey, repos[], productProfileRef, status | One per product |
| `ProductProfile` | version, processPack, components[{name, pack, paths}], thresholds, hardware, testTargets | Loaded from `.adlc/product-profile.yaml`; approved at G0 |
| `PackVersion` | packId, kind (process/tech), semver, status (Draft/Qualified/Restricted/Retired), imageDigest, ownerId | [SDD §5.7] |
| `AgentDefinition` | name, version, role, tier, modelId, tools, constraints, handoffs, governance, budgets, autonomyLevel, ownerRole, release | Loaded from `agents/<role>/agent.yaml` |
| `AgentRun` | id, agentDefVersion, projectId, kind (speckit-command / task-pipeline / review / canary), taskKey?, componentPack, step, state, containerId, startedAt, heartbeatAt, tokensIn/Out, costUsd, exitReason | One container per run |
| `Lease` | taskKey, runId, fencingToken, expiresAt (TTL 15 min, renewed every 5 min heartbeat, capped by wall-clock budget) | Fencing token required on every write |
| `ComponentLock` | projectId, component, state (active / pending-merge), taskKey | [SDD §8.4] |
| `StepRecord` | runId, step (S0–S12 or command), status, startedAt, endedAt, wipCommitSha, errorSignature | Loop detection uses `errorSignature` |
| `Decision` | id (DEC-nnnn), class (clarification/consult/escalation/risk/gate), route (operational/design/human), options, owner, timebox, reversible, autoResolve (only for lookup consults), status, outcome, decidedBy, jiraKey | Gate class: `reversible=false`, `autoResolve=false`, `onTimeout=escalate` |
| `Gate` | id (G0–G6, G-CR, G2Δ/G3Δ/G4Δ), projectId, scope, jiraGateKey, prRef?, readinessReportRef, status, approvedBy, approvedAt | Two-key for G1–G4 |
| `EvidenceRecord` | prNumber, headSha, mergeGroupSha?, patchId, reviewerVerdicts[{role, tier, verdictHash, modelCallId}], checkResults[], envelopeRef, status | Write-once |
| `TraceNode` / `TraceLink` | id (STK/SYS/HWR/CSR/SWR/SWC/SWU/test IDs), type, source, status, supersedes; link(from, rel, to) | Rebuilt on merge |
| `AuditEvent` | ts, actor (agent run / human user / service), action, target, reason, before/after hash | Append-only, hash-chained daily export |
| `Notification` | id, event, severity, recipients, channel, sentAt, ackBy, ackAt, escalationLevel | [SDD §16.3] |
| `BudgetLedger` | scope (task/project/day/month), tokens, costUsd, cap | Drives pause on cap |
| `TestTargetLease` | targetId, pack, runId, expiresAt, health | Via TestTargetAdapter |

---

## 6. Contracts (schemas)

All schemas live in `packages/schemas`. Every YAML or JSON contract is validated at load time, and an invalid config fails fast with a clear error.

| Contract | Location | Shape (abridged) — full examples in SDD Appendix B/C, §5.5 |
|---|---|---|
| ProductProfile | `.adlc/product-profile.yaml` (product repo) | `processPack`, `components[]`, `thresholds`, `hardware`, `testTargets` |
| AgentDefinition | `agents/<role>/agent.yaml` | `role, goal, backstory, model{tier,id}, tools[], constraints{maxFilesPerChange, requireTests, languages, blockedPaths}, handoffs[], governance{merge:never,…}, budgets{S,M,L}, autonomy{level}` |
| Tech pack manifest | `packs/tech/<id>/pack.yaml` | id, version, languages, codingStandard, image, adapters{build, analysis, testTarget, release}, budgetSchema, dodThresholds, humanLedCategories, humanExecutedVerification, templateFragments, skills, evals |
| Process pack manifest | `packs/process/<id>/pack.yaml` | processes, informationItems, gateMapping, templates, constitutionArticles |
| WorkPacket / ResultPacket | JSON | SDD Appendix B (plus `fencingToken`, `componentPack`, `reviewerSet`) |
| tasks.import.json | `specs/NNN-*/tasks.import.json` | `[{taskId, title, requirementIds[], component, complexity S/M/L, flags[], depends[], acceptanceCriteria[], specRef{feature, taskId, path, sha}}]` |
| Decision | DB + Jira mirror | SDD Appendix C |
| Evidence statement | in-toto v1 statement in a DSSE envelope | subject = PR head SHA (and merge-group SHA); predicate = verdicts, checks, agent versions, patch-id |

---

## 7. Interfaces

```ts
// packages/executor
interface ExecutorBackend {
  create(spec: RunSpec): Promise<RunHandle>;      // image digest, env, limits, network policy
  start(h: RunHandle): Promise<void>;
  stop(h: RunHandle, reason: string): Promise<void>;
  status(h: RunHandle): Promise<RunStatus>;
  logs(h: RunHandle, opts: { follow: boolean }): AsyncIterable<LogLine>;
  delete(h: RunHandle): Promise<void>;
}
// packages/pack-sdk
interface BuildAdapter     { build(c: Component, variant: string): Promise<BuildResult>; test(level: TestLevel): Promise<TestResult>; coverage(): Promise<Coverage>; artifacts(): Promise<Artifact[]>; }
interface AnalysisAdapter  { analyse(commit: Sha, baseline: Sha): Promise<Finding[]>; ruleSetVersion(): string; }
interface BudgetSchema     { fields: BudgetField[]; measure(field: string, ctx: MeasureCtx): Promise<Measurement>; }
interface TestTargetAdapter{ lease(type: string, minutes: number): Promise<TargetLease>; deploy(l: TargetLease, a: Artifact): Promise<void>; run(l: TargetLease, suite: string): Promise<SuiteResult>; collect(l: TargetLease): Promise<Artifact[]>; release(l: TargetLease): Promise<void>; health(id: string): Promise<Health>; }
interface ReleaseAdapter   { package(b: Baseline): Promise<Artifact[]>; sign(a: Artifact[]): Promise<Signed[]>; publish(s: Signed[]): Promise<ReleaseRef>; }
```

**External adapters:** `IssueTracker` (Jira Cloud REST v3; two identities, `adlc-orchestrator` and `adlc-agent`), `SourceControl` (GitHub App), `CIPipeline` (Jenkins REST), `NotifierChannel` (portal inbox, email, Teams stub, SMS stub).

**MCP servers exposed to agents** (tools and per-role rights per SDD §11.1–§11.2): `jira`, `github`, `jenkins`, `test-target`, `analysis`, `docs`, `qms`, `trace`, `decisions`, `evidence` (reviewer roles only).

---

## 8. Functional requirements

### 8.1 Orchestrator — lifecycle, dispatch and runs (C1, C2, C3)

| ID | Requirement |
|---|---|
| FR-ORC-001 | Maintain project lifecycle P0–P7 and gate states. A phase transition happens only when the preceding gate is Approved in Jira (polled every 60 s). |
| FR-ORC-002 | Run the Spec Kit `pioneer-aspice` workflow. For each command, spawn the owning agent role in a container. Resolve `gate` steps from Jira (`verdict_input`). |
| FR-ORC-003 | After every Spec Kit command, run deterministic re-checks (ID allocation done by the trace service, template conformance, task format, Constitution Check fields, `[NEEDS CLARIFICATION]` count). A mismatch fails the step. |
| FR-ORC-004 | Allocate feature numbers (passed to Spec Kit). Verify the allocated number was used. |
| FR-ORC-005 | Ready frontier: Jira To Do, all blockers Done, DoR passed, module lock free, `dispatchable`. Order: effective priority, then critical-path length, then age. Fair share across projects. |
| FR-ORC-006 | Back-pressure: no new claims while the G5 queue > 2 × on-duty G5 approvers, any test-target queue wait > 30 min, or a budget cap is reached. |
| FR-ORC-007 | Routing: S/M → Engineer (Tier B), L → Senior (Tier A), XL rejected (must be split or human). Pack human-led categories are never dispatched to agents at autonomy level 1. Tasks flagged for a test target that does not yet exist are held. |
| FR-ORC-008 | Leases: TTL 15 min, renewed by a 5-min heartbeat, capped by the wall-clock budget (S 1 h, M 4 h, L 8 h). Every write carries a fencing token, and stale tokens are rejected. Execution leases end at S10; a pending-merge component lock is kept until merge or rejection. |
| FR-ORC-009 | Pipeline S0–S12 exactly as SDD §8.5, including: WIP push after each step; max 2 fix passes; reviewer set per author role, on the other tier; S9 signing preconditions; S11 merge-group rule. |
| FR-ORC-010 | Loop detection: the same `errorSignature` three times triggers an escalation Decision. |
| FR-ORC-011 | Budgets: per-task token and time caps; per-project daily cap pauses claims; monthly budget alert at 80%. |
| FR-ORC-012 | Kill switch: stop all claims; running steps finish, push WIP and stop. |
| FR-ORC-013 | Executor backend (Docker): one container per run, from a signed image by digest; rootless; read-only root FS; no Docker socket or host mounts; dropped capabilities; seccomp; network policy (gateway, Git, Claude API, pack test targets only); CPU/memory/disk limits. |
| FR-ORC-014 | Sandbox quota: at most 2 of 8 slots in the pilot (configurable). |
| FR-ORC-015 | Leader-elected dispatcher (PostgreSQL advisory lock). Other orchestrator replicas are stateless workers. |

### 8.2 Definition of Ready and Decisions

| ID | Requirement |
|---|---|
| FR-DOR-001 | Stage A (deterministic): the seven checks of SDD §8.3 plus the five Pioneer checks. Stage B (LLM yes/no per check) runs only if Stage A passes. |
| FR-DOR-002 | DoR runs on the staged set before G4 and again at claim time. On failure: Jira status Needs Clarification, questions raised as Decisions; after three rounds, the Scrum Master role owner is notified. |
| FR-DEC-001 | Decision classes and routes as SDD §8.6. Only *lookup* consults auto-answer, deterministically, with an artifact and SHA citation. |
| FR-DEC-002 | Gate, clarification, risk and requirement Decisions never auto-resolve and never default on timeout; a timeout escalates. **A conformance test in CI must prove this** (AT-P2-05). |
| FR-DEC-003 | Approver fatigue caps per approver per day (3 large, 8 medium, 25 small); excess is queued and reported. |

### 8.3 Seam, trace and QMS (C5, C6, C7)

| ID | Requirement |
|---|---|
| FR-IMP-001 | Parse Spec Kit 1.2.6 `tasks.md` (`- [ ] T### [P] [US#] description`) plus Pioneer tokens `[REQ-IDs] {comp:} {cx:} {flags}`, a `depends:` line and `ACn:` lines. Output `tasks.import.json`. Unknown format → error with line number. |
| FR-IMP-002 | Contract test against real `/speckit.tasks` output fixtures for each allowed Spec Kit version (`test/fixtures/speckit-1.2.6/`). |
| FR-IMP-003 | After G4: create Jira Epics, Stories and Tasks and their "blocks" links idempotently (External ID `<feature>/<T###>`). Re-runs create nothing new. |
| FR-TRC-001 | Allocate global IDs (STK, SYS, HWR, CSR, SWR, SWC/SWU, test IDs); never reuse. Called by the orchestrator, not by hooks. |
| FR-TRC-002 | Rebuild the trace graph on every merge from spec IDs, `supersedes:`, task requirement IDs, `@implements`/`@verifies` tags and Jira links. |
| FR-TRC-003 | Gap report per gate scope (checks in SDD §9.3). Effective-requirements view = baselined minus superseded. |
| FR-QMS-001 | Render Markdown masters into Pioneer templates via a mapping table. If templates are missing (OPEN-01), render a generic structure and mark it "TEMPLATE PENDING". |
| FR-QMS-002 | Render-diff check: the text of the rendered document equals the Markdown master; any difference blocks the baseline. |

### 8.4 Jira, GitHub, Jenkins, evidence (C8, C14, C15)

| ID | Requirement |
|---|---|
| FR-JIRA-001 | Configuration-as-code for issue types, statuses (SDD §8.2), custom fields, gate workflow (approve/reject restricted to `adlc-approvers-<gate>` groups), and the Done transition restricted to `adlc-orchestrator`. |
| FR-JIRA-002 | Re-read the issue (changelog ID) before every write. Human edits win; on conflict, re-plan. Back off on HTTP 429. |
| FR-GH-001 | Configuration-as-code: rulesets (agents push only to `task/*` and `spec/*`; no deletion or force push); branch protection on main (merge queue, group size 1 in pilot; CODEOWNERS; dismiss stale approvals; require approval of the latest push; required statuses `adlc/verify`, `adlc/evidence`, `adlc/paths`, `adlc/gate` for spec PRs; no bypass actors). |
| FR-GH-002 | `adlc/paths` check: the changed paths of a PR must match the author role's allow-list for the component's paths. |
| FR-GH-003 | `adlc/gate`: posted from the Jira gate status for spec baseline PRs. |
| FR-CI-001 | Jenkins pipelines verify / main / nightly / release that call pack adapters. Verify posts `adlc/verify`. |
| FR-EVD-001 | Reviewer verdicts are written by `adlc-reviewer` through the gateway into a write-once store, each bound to a head SHA and a model call ID. |
| FR-EVD-002 | Signer (dedicated node, never runs PR code): signs only if (a) the role's required reviewer set is complete, (b) every verdict names the head SHA, (c) each verdict matches a gateway-logged model call, and (d) checks pass. Posts `adlc/evidence`. For merge groups: post on the merge-group SHA only if the parent is current main, the PR-head evidence verifies and the patch-id is unchanged. |

### 8.5 Packs (C11, C12, C13)

| ID | Requirement |
|---|---|
| FR-PCK-001 | Load and validate the product profile and pack manifests; route each task to its component's pack. |
| FR-PCK-002 | Enforce the gate floor (SDD §5.6). A pack or profile cannot remove floor checks; loosening a default needs a Decision record. |
| FR-PCK-003 | Pack status lifecycle Draft → Qualified → Restricted → Retired. Production dispatch only on Qualified packs. |
| FR-PCK-004 | Compose Spec Kit templates from the process-pack template plus technology-pack fragments. |
| FR-PCK-005 | **Core-neutrality check:** CI fails if any file under `apps/` or `packages/` names a specific OS, platform, language toolchain or vendor tool (deny-list maintained in `packages/config/neutrality-denylist.txt`; allow-list for tests). |
| FR-AGT-001 | Agent runtime: load the AgentDefinition, pack skills and work packet; tools only via the gateway; return a ResultPacket; stamp agent version and model ID on PRs and evidence. |
| FR-AGT-002 | Reviewer tier rule: the reviewer tier ≠ the author tier; Senior-authored PRs require a blind pre-merge human review. |
| FR-AGT-003 | Eval runner: golden tasks per role and pack with graders; canary runner (weekly, rolling 6-week window, ≥ 40 seeds per major class; pass when the Wilson 90% lower bound ≥ 75%). |

### 8.6 Portal and notifications (C9, C10)

| ID | Requirement |
|---|---|
| FR-POR-001 | Views: agent fleet, run detail (timeline, live logs via SSE, transcript with RBAC, evidence, links), failures and interventions, queues, packs and versions, capacity and cost, audit. [SDD §16.2] |
| FR-POR-002 | Controls with reason and audit: pause/resume, stop, restart from checkpoint (fence the old lease, go through S0–S2, only before S10), retry step (counts against fix-pass cap and loop detection), extend budget (Decision if beyond the size cap), reassign to human, drain/concurrency, quarantine target, kill switch. |
| FR-POR-003 | RBAC via Keycloak roles: viewer, operator, role-owner, pack-owner, lead, platform-admin, auditor. Controls that change Jira go through `adlc-orchestrator`, with the human recorded in audit. |
| FR-POR-004 | The portal cannot approve gates, merge, or edit packs or configuration (no such API exists). |
| FR-NOT-001 | Event catalogue, severities and acknowledgement SLAs as SDD §16.3. |
| FR-NOT-002 | Rota-based routing; escalation to backup, then Program Lead, on missed SLA; dedupe; daily digest for low severity; working hours Asia/Kolkata except Critical. |
| FR-NOT-003 | Channels: portal inbox and email (Phase 0); Teams and SMS adapters as stubs until OPEN-21 is resolved. |

---

## 9. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-001 | **Security:** no secrets in code, logs, prompts or model context; secrets from vault via gateway injection; all external content treated as untrusted data; least privilege per role; audit for every state change and control. |
| NFR-002 | **Resilience:** RPO 5 min, RTO 1 h for the control plane; active/passive with a documented manual failover runbook; failover test in Phase 0. |
| NFR-003 | **Performance:** dispatch latency < 30 s; portal live-log latency < 5 s; verify pipeline target < 25 min (pack-dependent). |
| NFR-004 | **Scalability:** Phase 0 load test with 20 concurrent dummy runs (no heartbeat loss, dispatch < 30 s). Stateless services; executor backend swappable (Kubernetes post-pilot). [SDD §17.3–§17.5] |
| NFR-005 | **Observability:** OpenTelemetry traces and metrics across all services; `ai_sdlc.*`-style metric families; KPIs of SDD §16.1. |
| NFR-006 | **Data:** time-partitioned audit; transcripts and logs in object storage with retention per ISMS (REVIEW: object store choice, e.g. MinIO); daily hash-chained WORM export. |
| NFR-007 | **Quality of platform code:** TypeScript strict; ≥ 85% line coverage on `packages/domain`, orchestrator and signer; ≥ 75% elsewhere; zero lint errors; every FR has at least one test. |
| NFR-008 | **Determinism:** orchestrator decisions are reproducible from DB state plus inputs. No LLM call in C1, C5, C6, C8. |
| NFR-009 | **Portability:** all services containerised; configuration by environment; health and readiness endpoints. |
| NFR-010 | **Licences:** Spec Kit (MIT) used as a pinned tool; no AI-SDLC code; any reused AI-SDLC schema text keeps the Apache 2.0 NOTICE. |

---

## 10. Environments

| Env | Purpose | Notes |
|---|---|---|
| `dev` | Developer laptops / CI | Docker Compose; fake Jira/GitHub/Jenkins/Claude adapters (`packages/testing`) |
| `sandbox` | Agent and pack qualification, canaries, platform change tests | Separate Jira project and GitHub repos; capped container quota |
| `prod` | Pilot | VMs per SDD §17.1 |

---

## 11. Phase plan

Each phase lists its **entry criteria**, **work packages (WP)**, **acceptance tests (AT)** and **exit**. Claude Code must stop at the end of each phase, write `docs/phase-reports/phase-<n>.md` and wait for human approval in `docs/phase-status.md`. Durations are planning figures from SDD §21.

### Phase 0 — Foundation

**Entry:** this spec approved; OPEN-07 (KMS), OPEN-14 (GHEC) and OPEN-22 (Keycloak realm) either resolved or stubbed with interfaces.

| WP | Content | FRs |
|---|---|---|
| P0-WP1 | Monorepo, CI (lint, typecheck, test, coverage, neutrality check), ADR process, `docs/phase-status.md` | FR-PCK-005, NFR-007 |
| P0-WP2 | `packages/domain`, `schemas`, `db` (migrations for all entities in §5), audit with hash chain | NFR-001, NFR-006 |
| P0-WP3 | Orchestrator skeleton: state machine, leases with fencing, heartbeat, budgets, kill switch, leader election | FR-ORC-008, 011, 012, 015 |
| P0-WP4 | Executor backend (Docker) with the security baseline; agent-runtime image skeleton; "dummy agent" role that edits a file and opens a PR | FR-ORC-013, 014 |
| P0-WP5 | Gateway with `jira`, `github`, `decisions` MCP servers; per-role policy; secret injection; audit | §7 |
| P0-WP6 | Jira, GitHub and Keycloak configuration-as-code (sandbox first) | FR-JIRA-001, FR-GH-001 |
| P0-WP7 | Jenkins verify pipeline skeleton + signer job on a dedicated node + evidence store (minimal: one dummy reviewer verdict) | FR-CI-001, FR-EVD-001/002 |
| P0-WP8 | Pack SDK interfaces, product-profile loader, pack registry; `ind880-c` toolchain image skeleton | FR-PCK-001, 003 |
| P0-WP9 | Importer parser + contract tests against Spec Kit 1.2.6 fixtures | FR-IMP-001, 002 |
| P0-WP10 | Portal skeleton (fleet view, run detail with live logs, kill switch) + notifier (Needs Human and gate-ready; inbox + email) | FR-POR-001 (partial), FR-NOT-001 (partial) |
| P0-WP11 | Compose deployment, replica, failover runbook; load test harness | NFR-002, NFR-004 |

| AT | Acceptance test |
|---|---|
| AT-P0-01 | A dummy task flows Jira → dispatch → container → PR → `adlc/verify` + `adlc/evidence` → human approval → merge queue → Jira Done, visible live in the portal. |
| AT-P0-02 | A forced run failure creates Needs Human and an email + inbox notification. Escalation fires when it is not acknowledged within its SLA (time-compressed test). |
| AT-P0-03 | Stale fencing token is rejected; a killed container's task resumes from its branch via a new lease. |
| AT-P0-04 | An agent identity cannot: transition a Gate issue, set Done, approve or merge a PR, push to main, or delete a branch. Each is attempted and fails. |
| AT-P0-05 | 20 concurrent dummy runs: no heartbeat loss; dispatch latency < 30 s; portal shows all runs. |
| AT-P0-06 | Failover to the passive control plane within RTO; leases resume. |
| AT-P0-07 | Neutrality check fails on a seeded vendor/tool string in `packages/`. |
| AT-P0-08 | Importer parses all 1.2.6 fixtures; rejects malformed lines with line numbers. |

**Exit:** all AT-P0 tests pass; phase report written; human approval recorded.

### Phase 1 — Front half + Phase 1a mock assessment support

**Entry:** Phase 0 approved; QMS templates available or stubbed (OPEN-01).

| WP | Content | FRs |
|---|---|---|
| P1-WP1 | Bundle `pioneer-adlc`: preset (constitution, three spec levels, plan/tasks templates with fragments), extension commands (`product`, `system`, `tara`, `hwreq`, `verify-spec`, `trace`, `baseline`, `import`), converge override (report only), workflow with gate steps | FR-PCK-004, FR-ORC-002 |
| P1-WP2 | Orchestrator front-half runner: command spawning, re-checks, feature numbering, spec-branch handling, `adlc/gate` status | FR-ORC-001–004, FR-GH-003 |
| P1-WP3 | Trace service (ID allocation, graph, gaps, effective view) | FR-TRC-001–003 |
| P1-WP4 | QMS renderer + render-diff | FR-QMS-001, 002 |
| P1-WP5 | Agent definitions, prompts, skills and golden tasks: Process Engineer, Product Manager, Architect, Security Engineer | FR-AGT-001, 003 |
| P1-WP6 | Gate readiness report generator; evidence index export (for 1a) | §13.1 SDD |

| AT | Acceptance test |
|---|---|
| AT-P1-01 | From a sample requirement input in `test/fixtures/intake/`, agents produce the constitution, product spec and system spec; G0–G2 run through Jira two-key approvals in the sandbox. |
| AT-P1-02 | First feature spec and plan reach G3 with `/speckit.analyze` showing no CRITICAL/HIGH findings and zero trace gaps. |
| AT-P1-03 | A deliberately skipped hook (simulated) is caught by the deterministic re-check. |
| AT-P1-04 | Rendered .docx passes the render-diff; approval records appear in document control. |
| AT-P1-05 | Golden-task pass rates for the four roles are recorded (baseline; no threshold yet). |

### Phase 2 — Planning seam 

| WP | Content | FRs |
|---|---|---|
| P2-WP1 | Scrum Master agent; Pioneer tasks format; `tasks.import.json` in the planning PR | FR-IMP-001 |
| P2-WP2 | DoR engine (Stage A + B) and Decision engine (classes, routes, timeboxes, fatigue caps, digest) | FR-DOR-001/002, FR-DEC-001–003 |
| P2-WP3 | Jira creation after G4 (idempotent), dependency links, dispatch frontier | FR-IMP-003, FR-ORC-005 |

| AT | Acceptance test |
|---|---|
| AT-P2-01 | The G4 pack shows the dependency graph with reasons, critical path and DoR results. |
| AT-P2-02 | Approval at G4 creates the Jira issues and links; re-running creates no duplicates. |
| AT-P2-03 | DoR failure sets Needs Clarification and raises Decisions; three rounds notify the owner. |
| AT-P2-04 | The frontier orders tasks by effective priority and critical path. |
| AT-P2-05 | **Conformance:** for every gate/clarification/risk/requirement Decision, timeout leads to escalation, never to auto-resolution (property-based test). |

### Phase 3 — Back half on host 

| WP | Content | FRs |
|---|---|---|
| P3-WP1 | Engineer and Senior agents; full S0–S12 pipeline; routing; locks; back-pressure; loop detection | FR-ORC-005–010 |
| P3-WP2 | Reviewer agents (Code Reviewer with code and test lenses, QA test review, Security); tier rule; reviewer set per author role | FR-AGT-002 |
| P3-WP3 | Evidence and signer complete, including the merge-group rule; `adlc/paths` | FR-EVD-001/002, FR-GH-002 |
| P3-WP4 | Blind formal-review queue (hides agent verdicts); G5 checklist enforcement; depth audit | SDD §13.3–§13.4 |
| P3-WP5 | Canary runner and corpus; eval runner in sandbox | FR-AGT-003 |
| P3-WP6 | Portal full controls; all notification events; Teams/SMS stubs | FR-POR-001–004, FR-NOT-001–003 |
| P3-WP7 | `ind880-c` pack: build, analysis (MISRA tool or stub until OPEN-03), budgets on host; flagged test-target tasks held | FR-PCK-001–003 |

| AT | Acceptance test |
|---|---|
| AT-P3-01 | ≥ 20 pilot tasks merged through G5 with complete signed evidence. |
| AT-P3-02 | A merge-group commit with a changed patch-id does not receive `adlc/evidence`. |
| AT-P3-03 | A QA-authored PR gets the QA reviewer set (no self-review) and is approved by the Engineering G5 group. |
| AT-P3-04 | Restart from checkpoint never produces two active executors on one task. |
| AT-P3-05 | Back-pressure stops claims when the G5 queue exceeds the limit. |
| AT-P3-06 | Canary results are computed with the Wilson bound; failing a class demotes the reviewer version (sandbox). |

### Phase 4 — Target verification and release 

| WP | Content | FRs |
|---|---|---|
| P4-WP1 | `ind880-c` TestTargetAdapter + HIL bench manager service; timing probe; CPU-load suite; on-target coverage | SDD App. F |
| P4-WP2 | QA agent: verification specs (agent and human-executed), converge report, regression selection | SDD §6.10 |
| P4-WP3 | Release pipeline and ReleaseAdapter (signing after G6), evidence export, QMS pack | FR-CI-001 |
| P4-WP4 | G6 readiness and release flow | SDD §13.1 |

| AT | Acceptance test |
|---|---|
| AT-P4-01 | A flagged task runs HIL smoke and a timing probe through the adapter; bench health and quarantine work. |
| AT-P4-02 | A release candidate passes G6 and is published with binaries, SBOM, release notes, QMS pack and evidence export. |

### Phase 5 — Release 2, change handling and second pack 

| WP | Content |
|---|---|
| P5-WP1 | HW Engineer and Program Manager agents |
| P5-WP2 | CR flow: impact analysis, supersedes, revision folders, delta gates G2Δ/G3Δ/G4Δ |
| P5-WP3 | Second technology pack `cloud-ts` (or the pack chosen at OPEN-19), qualified in the sandbox |

| AT | Acceptance test |
|---|---|
| AT-P5-01 | One CR and five defects are handled end-to-end; the effective SRS is regenerated. |
| AT-P5-02 | A sample feature is built through the second pack **with zero changes to `apps/` or `packages/`**. |

### Phase 6 — Pilot assessment support 

| WP | Content |
|---|---|
| P6-WP1 | KPI and go/no-go dashboard (SDD §21.1); evidence export for the external assessor; final reports |

| AT | Acceptance test |
|---|---|
| AT-P6-01 | All go/no-go metrics are computed from platform data and exported. |

---

## 12. Open items Claude Code should ask when required and update the spec

| OPEN | Item | What to do until resolved |
|---|---|---|
| OPEN-01 | Pioneer QMS templates | Generic templates, marked "TEMPLATE PENDING" |
| OPEN-03 | Licensed MISRA analyser and stack tool | `AnalysisAdapter` with cppcheck/clang-tidy; mark results "baseline only" |
| OPEN-04 | indie SDK licence and NDA for model use | Do not put SDK files in agent context; stub the toolchain image |
| OPEN-05 | HIL bench details | Simulated TestTargetAdapter in dev/sandbox |
| OPEN-07 | KMS/HSM | Software key in dev only, behind the signer interface; never in prod |
| OPEN-14 | GitHub Enterprise Cloud | Verify merge queue and ruleset APIs in sandbox |
| OPEN-19 | Second pack choice | Build against `cloud-ts` placeholder manifest |
| OPEN-21 | Teams/SMS | Stub channels |
| OPEN-22 | Keycloak realm | Local Keycloak in Compose for dev |
| OPEN-23 | Container registry and image signing | Local registry in dev |

---

## 13. Traceability to the design

| Spec area | SDD sections |
|---|---|
| §3 Components | §4, §17 |
| §5 Domain model | §8, §9, §13–§16 |
| §8.1 Orchestrator | §8.1–§8.7, §17.2 |
| §8.2 DoR/Decisions | §3.2.2, §8.3, §8.6 |
| §8.3 Seam/trace/QMS | §3.3, §9 |
| §8.4 Jira/GitHub/CI/evidence | §10, §12.1, §8.5, §15.1 |
| §8.5 Packs | §5, App. F, §14 |
| §8.6 Portal/notifications | §16 |
| §9 NFRs | §15, §17, §18 |
| §11 Phases | §21 |
