# 0004 — Domain vocabularies and state machines
Status: Proposed (confirm at Phase 0 review)   Date: 2026-11-04   Requirements: P0-WP2, FR-DEC-002, FR-JIRA-001

## Context
spec.md §5 names fields such as `AgentRun.state`, `Decision.status` and `StepRecord.status` without listing their values. SDD §8.2 and §10.1 give the Jira task and gate workflows only in prose.

## Options
1. Free-text columns, validated later.
2. Closed vocabularies in `packages/domain`, reused by the Zod schemas and the DB CHECK constraints.

## Decision
Option 2. The lists live in `packages/domain/src/vocabulary.ts`, and the state machines are explicit transition tables:
- **Task status** (SDD §8.2, §8.4):
  - Lease expiry returns In Progress or In Review to To Do.
  - G5 rejection or a merge-queue failure returns Awaiting Approval to To Do.
  - Done is terminal and can be set only by the `adlc-orchestrator` service identity.
- **AgentRun:** queued → starting → running → succeeded / failed / stopped / lost. `lost` means the lease expired without a heartbeat.
- **Gate** (SDD §10.1):
  - Open → Ready for Approval → Approved / Rejected.
  - Only human actors resolve a gate, and G1–G4 need two distinct approvers.
  - Rejected is terminal: a re-submission is a new gate record (to be confirmed).
- **Decision:**
  - Statuses: open → escalated (repeatable) → decided / withdrawn.
  - **There is no `onTimeout` field.** Timeout is the constant `escalate`, so no Decision can be configured to default.
  - `autoResolve` is allowed only for consults, and gate Decisions are irreversible. Both rules are enforced in code (domain + Zod) and as DB CHECK constraints.
- **Decision IDs:** `DEC-nnnn` (four or more digits), formatted in code from a DB sequence.

## Consequences
A change to any of these vocabularies is one edit in `packages/domain`, followed by a generated migration. Values not in the spec are marked "to be confirmed" here.
