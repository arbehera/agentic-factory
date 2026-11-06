# 0013 — Notifications for manual intervention and the portal skeleton
Status: Proposed (confirm at Phase 0 review)   Date: 2026-11-05   Requirements: FR-NOT-001 (partial), FR-NOT-002, FR-NOT-003 (inbox + email), FR-POR-001 (partial), FR-POR-002 (kill switch), FR-POR-003, FR-POR-004, AT-P0-02

## Context
SDD §16.2–§16.3 describe the portal and the notification service. P0-WP10 covers part of each: the Needs Human and gate-ready events (inbox and email), plus a portal with the fleet view, run detail with live logs, and the kill switch. The rota, approver groups, working hours and holidays are Pioneer facts that are still open (OPEN-06, OPEN-21; plan Q-14).

## Decision
1. **Outbox, not direct sending.** Producers (the orchestrator's supervisor today) only insert a `notification` row: event, severity, *audience* (`role:<role>`, `gate:<gate>`), title, body, link and dedupe key. The notifier owns routing, deadlines, delivery and escalation. A failed email is retried on the next tick; a producer never blocks on SMTP.
2. **Deadlines in working time.**
   - `ackDeadline` counts only working time in the configured time zone, skipping nights, weekends and holidays. Critical events count wall-clock time (SDD §16.3).
   - Calendar and rota are YAML contracts (`config/working-calendar.yaml`, `config/rota.yaml`). They hold **dev defaults and placeholder `@example.invalid` addresses**, clearly marked; nothing Pioneer-specific is invented.
3. **Escalation.**
   - The ladder is the on-duty member (first in the group), then the backup (second), then the Program Lead.
   - Past the top, the Program Lead is re-notified every window until someone acknowledges.
   - An audience missing from the rota still reaches a human (the Program Lead) and is logged.
4. **Noise control.** A partial unique index on the dedupe key, for unacknowledged rows only, merges duplicates of an open event; once acknowledged, a new event starts a new notification. The daily low-severity digest arrives with the rest of the catalogue (P3-WP6).
5. **Needs Human (AT-P0-02).** When a run ends `failed` or `lost`, the supervisor raises `run.needs-human` for the role's owner group (deduplicated per task). It then re-reads the Jira task and moves it to *Needs Human* if the task state machine allows it, with an audit event. If a human changed the issue, the human's change wins.
6. **Inbox = the same rows.** The portal inbox shows notifications whose *current* recipients include the user; escalation moves an item to the next person's inbox. Recipients acknowledge their own items, operators any item. Acknowledgements are audited and idempotent.
7. **Portal API.**
   - **Auth:** NestJS with OIDC JWT verification (`jose`). Issuer, audience and Keycloak realm roles map to the FR-POR-003 roles; tests use a local signing key, never a real Keycloak.
   - **Controls:** every control checks the role and needs a reason (3–2000 characters), and is audited with the human as the actor. The kill switch is limited to `platform-admin` and `lead` (SDD §16.2).
   - **FR-POR-004:** a test enumerates every route and fails if an approve, merge, gate, pack, config or policy route appears.
8. **Live logs.**
   - They are streamed as NDJSON over a normal authenticated `fetch`. EventSource would need the token in the URL, which would leak it into logs.
   - The portal reads them through a `RunLogSource` port. Whether that source is local or proxied from the orchestrator host, keeping container access off the portal, is decided with the deployment topology (P0-WP11).
9. **Portal web.**
   - React 18 + Vite + TanStack Query: fleet, run detail with live logs, inbox, kill switch. Times are shown in Asia/Kolkata.
   - The kill switch needs a reason and an on-page second confirmation.
   - Sign-in is OIDC code + PKCE through `oidc-client-ts`. The Keycloak realm and client come with P0-WP6/WP11.

## Consequences
- **Proven:**
  - a forced failure reaches the on-duty owner by email and inbox, and the Jira task shows Needs Human;
  - escalation to the backup and the Program Lead runs in working time (time-compressed test);
  - acknowledgement stops escalation; the portal enforces roles, reasons and audit.
- **Still to come:**
  - the full catalogue, digest and Teams/SMS stubs (P3-WP6);
  - portal screenshots and Playwright e2e (CLAUDE.md §8), with Keycloak in Compose (P0-WP11);
  - the real Jira identity for the Needs Human transition (Q-04).
