# 0016 — Platform configuration-as-code: manifests, plans and blockers
Status: Proposed (confirm at Phase 0 review)   Date: 2026-11-06   Requirements: FR-GH-001, FR-JIRA-001, FR-CI-001, C15, hard rules 2–3

## Context
C15 asks for the Jira workflow and fields, the GitHub rulesets and branch protection, and the Keycloak realm as reviewed configuration-as-code. The sandbox targets are now known:
- GitHub `arbehera/factory-sample`, owned by a personal account;
- Jira project `AGENSDLC`.

Their credentials are not available yet (Q-04). The agents' GitHub identity will be two GitHub Apps, `adlc-agent` and `adlc-ci` (decision 2026-11-06).

## Options
1. **Terraform providers.** These add a new toolchain and state store, and the Jira provider landscape is uneven.
2. **Click-ops plus a written checklist.** Not reviewable and not repeatable.
3. **Small TypeScript tool over the REST APIs, driven by YAML manifests** (chosen). Its plan is shown before any apply.

## Decision
1. **Manifests.** These hold only tool-specific facts, validated by Zod with an exported JSON Schema:
   - `infra/github/<repo>.yaml`;
   - `infra/jira/<project>.yaml`.

   Task statuses, transitions and gate IDs are **derived** from `@adlc/domain`, so Jira cannot disagree with the orchestrator.
2. **`config-sync`** (`pnpm config:sync …`).
   - `plan` reads the live state, or assumes one with `--offline`, and prints the actions, the unmanaged items, the manual steps, the blockers and the notes.
   - `apply` needs `--confirm <owner/repo>` and **refuses any plan with blockers**. A blocker is resolved by changing the manifest through review, never by a flag.
   - Only rulesets named `adlc-*` are owned by the tool; others are reported and left alone.
   - It is a human operator's tool, run with an admin token. No agent, gateway route or portal route can reach it (hard rule 3).
3. **GitHub rulesets** (SDD §10.2):
   - **`adlc-main`.** PR, a code-owner approval of the latest push, stale approvals dismissed, the required checks, and a merge queue of one. **No bypass actors.** Each required check is pinned to the `adlc-ci` App (`integration_id`), so a status posted by any other identity does not count.
   - **`adlc-agent-branches`.** On `task/*` and `spec/*`: no deletion and no force push, for anyone.
   - **`adlc-other-branches` and `adlc-tags`.** Everything else is locked (creation, update and deletion). Only the repository admin role may bypass, and a GitHub App is never a repository role. Merge-queue branches are excluded.
   - **Bootstrap.** An empty repository gets `CODEOWNERS` before any ruleset; once `main` is locked, later CODEOWNERS changes go by PR.
4. **Jira.**
   - The tool renders the desired state, with every workflow condition named:
     - `Done` only by `adlc-orchestrator`;
     - gate approve and reject only by `adlc-approvers-<gate>`, with both service accounts excluded and a comment required.
   - Two-key gates remain the orchestrator's check (domain).
   - The live drift check and apply come with sandbox access.
5. **Jenkins** runs in Compose behind the `ci` profile:
   - the image is pinned by digest, and all 71 plugins are pinned, dependencies included (`--latest false`);
   - Jenkins is configured as code (`casc.yaml`): no executors on the controller, no anonymous access, admin from `.env`;
   - a TLS-inspecting proxy's CA can be added to dev builds through a git-ignored `infra/jenkins/certs/`.
6. **Keycloak.** The realm is already configuration-as-code (`infra/compose/keycloak/realm-adlc.json`, P0-WP11). WP6 adds nothing there.

## Consequences
- **Blocked until a human decides:**
  - **Merge queue.** GitHub offers merge queues only on organization-owned repositories (OPEN-14). The plan for `factory-sample` is blocked until either the repository moves into an organization, or the manifest records the deviation. It is not weakened silently.
  - **CI App ID.** Unknown until the `adlc-ci` App exists, so the required checks cannot yet be pinned.
- **Deferred checks.** `adlc/paths` (P3-WP3) and `adlc/gate` (P1-WP2) are not required yet. Nothing posts them, so requiring them now would block every merge. Every plan reports them until they are added. This deviation from FR-GH-001 needs confirmation at the Phase 0 review.
- **Unverified API details.** Real API behaviour is unverified until the sandbox run (Q-04):
  - GitHub: the ruleset API details (admin role ID 5, `allowed_merge_methods`);
  - Jira: how a per-gate group condition is expressed (one workflow per gate, or a field-based condition).

  The Jira mechanism is an open design point for that run.
- **Jenkins agents.** No build agents (`adlc-build`, `adlc-signer`), credentials or jobs exist yet. `verify.Jenkinsfile` stays a skeleton until the agents and the sandbox exist.
