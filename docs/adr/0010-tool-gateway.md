# 0010 — Tool gateway: sessions, role policy, fencing, secrets and audit
Status: Proposed (confirm at Phase 0 review)   Date: 2026-11-05   Requirements: spec.md §7, NFR-001, hard rules 3, 5, 9, 10, 11; AT-P0-04 (gateway layer)

## Context
Agents reach Jira, GitHub and the Decision store only through the gateway's MCP servers (C4). spec.md fixes the servers and the permission matrix (SDD §11.2), but not the mechanics.

## Decision
1. **Identity: one session per run.**
   - When the orchestrator dispatches a run, it issues a random 256-bit bearer token for that run. The token is bound to the run's role, project, task key and fencing token.
   - Only its SHA-256 is stored (`gateway_session`). It expires with the lease deadline and is revoked when the run ends.
   - A task-scoped session must carry a fencing token (CHECK constraint).
2. **Call pipeline.** Every call: authenticate → the role policy lists the tool → arguments validated with Zod → the tool's own policy checks → task-scoped writes run inside `LeaseRepository.withFence` → known secret values redacted from the result → audit. Allowed and denied calls are both audited, with argument and result hashes.
3. **Role policy** is data in `agents/<role>/policy.yaml`, validated by `rolePolicySchema`.
   - **What it holds:** `tools`, Jira create types and own-task transitions, writable branches (`task/{taskKey}`, `spec/*`), write and blocked path globs, and answerable Decision classes.
   - **What the schema refuses:** Done transitions, Gate issue types, branches outside `task/` and `spec/`, and human-only Decision classes (gate, risk, requirement).
   - **Start-up check:** the gateway refuses to start if a policy names a tool that does not exist.
4. **Platform invariants are also checked in code, whatever a policy says:**
   - **Tools that don't exist:** merge, approve, delete, force-push and configuration tools.
   - **Jira:** never Done, never a Gate issue, never another task's status, and searches are always scoped to the run's project. Searches use structured filters, never raw JQL, because raw JQL can escape the project scope.
   - **GitHub:** never `main`, never a branch outside the role's patterns, never a path outside its write paths (traversal rejected), and PRs always target `main`.
   - **Decisions:** an agent may answer a Decision only if it is in the run's project, of a class the role may answer, owned by the caller's role, not routed to a human, and not raised by the same run. Agent-raised Decisions never auto-resolve. A `raised_by` column records who raised each Decision.
5. **Secrets (hard rule 9).**
   - Adapters are built inside the gateway with credentials from a `SecretProvider`. Tools receive adapter instances, never credentials.
   - Every secret value handed out is scrubbed from tool results and audit reasons.
   - Dev reads `ADLC_SECRET_*`; the vault backend comes with deployment (P0-WP11).
6. **Errors toward the agent.** Policy, permission, unknown-tool and argument errors return their reason. Anything else returns only the error class name, so internal details don't leak.
7. **MCP transport.** Stateless Streamable HTTP at `POST /mcp/<server>`, built on the SDK's low-level `Server`. JSON Schemas are generated from our Zod 4 schemas (the SDK depends on Zod 3). `tools/list` shows only the role's tools. Results are returned as data (hard rule 10).

## Consequences
- **Real clients.** The Jira Cloud and GitHub App clients are written when sandbox access exists (plan Q-04). Until then the gateway has no runnable entrypoint, so fakes can never be wired into production.
- **AT-P0-04 coverage.** The gateway half passes now. The platform half (Jira workflow conditions, GitHub rulesets) is P0-WP6 plus the sandbox.
- **Later work.** Injection screening of PR and code text (SDD §15.1) and gateway-logged model calls (FR-EVD-002) arrive with the reviewer and evidence work (P0-WP7, Phase 3).
