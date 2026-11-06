# 0012 — Review evidence: model-call log, write-once verdicts, DSSE evidence and the signer
Status: Proposed (confirm at Phase 0 review)   Date: 2026-11-05   Requirements: FR-EVD-001, FR-EVD-002, FR-CI-001, hard rules 1, 3, 9

## Context
SDD §8.5 S9 and §15.1 define the evidence chain against forged or replayed review evidence. P0-WP7 asks for a minimal version with one dummy reviewer verdict. FR-EVD-002 condition (c), "each verdict matches a gateway-logged model call", needs the gateway to see model calls, which it did not.

## Decision
1. **The four conditions** are one pure function, `evaluateSigning` (`@adlc/domain`), property-tested. It returns every unmet reason.
   - Only verdicts naming the exact head count.
   - Verdicts on earlier heads stay in the write-once store and are ignored, not treated as blocking. A later push simply needs new verdicts on the new head.
2. **Model proxy in the gateway.**
   - `POST /model/v1/messages`, authenticated by the run's session token. The gateway injects the API key from secrets (hard rule 9) and caps `max_tokens`.
   - Every successful call is logged in `model_call` (provider ID, run, model, token counts, request and response hashes), append-only.
   - Non-streaming only; streaming arrives with the Agent SDK roles (Phase 1). Upstream errors pass through and are not logged as calls.
3. **Write-once evidence store.** `model_call`, `reviewer_verdict` and `evidence_record` reject UPDATE, DELETE and TRUNCATE (triggers, migration 0010).
   - One verdict per reviewer role per PR head.
   - **A model call backs at most one verdict** (UNIQUE `model_call_id`).
4. **`evidence.write_verdict`** (gateway, reviewer roles only, `adlc-reviewer` identity).
   - The reviewer role is the run's policy role, never an argument.
   - **The session is bound to the one PR head it reviews** (`gateway_session.review_*`, set when the review run's session is issued). Any other repo, PR or head is refused, and a session without a review target cannot write verdicts at all.
   - The cited model call must be one this run made through the gateway.
   - (Bullets 3–4: hardened after the background security review of this work package.)
5. **Evidence format.**
   - An in-toto v1 Statement: the subject is the PR head commit; the predicate type is `https://adlc.pioneer/attestation/review-evidence/v0.1`; the predicate holds the verdicts and checks.
   - It is signed inside a DSSE envelope over canonical JSON. The signature covers PAE(type, payload).
   - The envelope is stored in `evidence_record` until the object store exists (ADR-0006).
   - Merge-group subjects and patch-id binding come with P3-WP3.
6. **Signing key.** `EnvelopeSigner` is an interface. The software Ed25519 implementation is for dev and test only and throws in production (OPEN-07); the KMS/HSM implementation replaces it.
7. **The signer (`apps/signer`)** runs on a dedicated node and never checks out or runs PR code.
   - **It reads:** the PR head (`getPullRequest`), the head's statuses, the verdicts and the model-call log.
   - **It posts:** `adlc/evidence` success, or failure with the first reason; every refusal is audited with all the reasons.
   - **Re-signing the same head** re-posts the status and creates no new record.
   - **Inputs:** reviewer sets come from `agents/reviewer-sets.yaml` (an author may not review itself); required checks are configuration (`adlc/verify` in Phase 0).
   - **No CLI yet:** it arrives with the real GitHub client (Q-04), so the signer cannot be pointed at a fake in a deployment.
8. **`SourceControl` additions** — `getPullRequest` and `setCommitStatus` — are used by CI and the signer only. No agent tool exposes them (hard rule 3).
9. **Jenkins** (`infra/jenkins/verify.Jenkinsfile`) is a skeleton. Verify runs PR code on build agents and posts `adlc/verify`; evidence runs on the `adlc-signer` node with no checkout. The pack verify entry point and the signer CLI are named placeholders.

## Consequences
- **Proven in-process:** dummy agent PR → `adlc/verify` → dummy reviewer (one proxied model call, one verdict) → signed DSSE evidence → `adlc/evidence`. Also proven: a later push invalidates the evidence until the new head is reviewed again, and request-changes blocks signing.
- **Still to come:** who dispatches the review run, and with which target (S6), is the pipeline in Phase 3. For AT-P0-01, P0-WP11 wires a minimal trigger.
- **Gateway-side usage:** the gateway now sees exact token usage. Moving budget accounting from agent-reported to gateway-measured usage is a Phase 1 change.
