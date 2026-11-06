# 0015 — Write-once (WORM) export of the audit chain and signed evidence
Status: Proposed (confirm at Phase 0 review)   Date: 2026-11-06   Requirements: NFR-006, FR-EVD-001, FR-EVD-002, hard rule 11

## Context
**What PostgreSQL already does.** The audit chain (ADR-0005) and the evidence store (ADR-0012) are append-only:
- triggers refuse UPDATE, DELETE and TRUNCATE;
- since P0-WP11, services connect as `adlc_app`, which may not even try.

**What it cannot do.** A database superuser or owner can still:
- disable the triggers and rewrite rows;
- delete events from the tail, which the hash chain alone cannot detect (ADR-0005);
- restore an older backup.

NFR-006 asks for a daily, hash-chained WORM export. ADR-0006 chose SeaweedFS and left one question open: whether its S3 Object Lock really holds.

**Measured on SeaweedFS 3.97** (P0-WP11, probes against the Compose stack):

| Request | Result |
|---|---|
| Delete a locked version (any identity, with or without the bypass header) | 403 |
| Shorten a locked version's retention | 403 |
| Overwrite a key, `If-None-Match: *` included | Accepted: adds a *new version*; the locked one stays |
| Plain DELETE | Accepted: adds a *delete marker*; the locked version stays |
| Delete the bucket, as an **admin** identity | **Accepted, locked objects and all** |
| Delete the bucket, as a non-admin identity | 403 |
| Change the bucket's *default* retention, as the exporter (Write) | Accepted |
| Read with an identity that has only Read/List | 403 (only Write or Admin identities can read the bucket) |
| `ListObjectsV2` on a versioned bucket | Returns wrong keys (the prefix doubled); `ListObjectVersions` is correct |

## Options
1. **Rely on Object Lock alone.** Rejected: an overwrite or delete marker hides the original from a plain GET, and an admin can delete the bucket.
2. **Sign each segment with a KMS key.** This would also defeat a total-control attacker. It waits on OPEN-07 (KMS/HSM), so it is noted for later.
3. **Lock plus a verifier that trusts nothing it reads** (chosen).

## Decision
1. **Segments.**
   - The leader job `audit-export` seals every audit event after the last export into `audit/segment-<n>.json`. It runs daily (`AUDIT_EXPORT_EVERY_MS`).
   - A segment records its anchor (the previous segment's last `{seq, hash}`) and its own last point, so the segments form one chain from genesis.
   - The export reads under the chain's advisory lock, so no in-flight append can land below the cut.
   - It refuses to seal a chain that does not verify: a broken database chain is investigated, never sealed.
2. **Evidence.**
   - For each `evidence.sign` event in the segment, the full evidence record (DSSE envelope included) is written to `evidence/<owner>/<repo>/<pr>/<head>.json` **before** the segment, so a segment never refers to evidence that isn't there yet.
   - The event's `afterHash` is the envelope's hash, which ties the envelope to the chain with no extra bookkeeping.
3. **The bookmark lives in the store.**
   - The next segment starts where the newest stored segment ends. A database administrator therefore cannot move the export's bookmark.
   - Each export also appends an `audit.export` event (target `object:<key>`, `afterHash` = the sealed point), so the database remembers what the store must hold.
4. **Every object is locked.** Each object is written with an explicit `COMPLIANCE` retention, `AUDIT_EXPORT_RETENTION_DAYS`. This does not depend on the bucket default, which the exporter could change.
5. **The verifier** (`verifyAuditExport`, `pnpm audit:verify`) reads every version of every object. It:
   - reports extra versions (`object-rewritten`) and delete markers (`object-deleted`);
   - verifies the **oldest** version of each object;
   - checks the segment chain and that every evidence envelope matches its event;
   - checks that the database's events up to the last exported seq are exactly the exported ones, recomputing each row's hash from its content (`database-diverges`: missing, changed or extra);
   - checks that every recorded `audit.export` is still in the store (`export-missing`), which catches a deleted bucket;
   - checks that the database's later events chain on from the export (`database-chain-broken`).
6. **Identities and credentials (Compose).**
   - SeaweedFS runs with no anonymous access.
   - `adlc-admin` creates the locked bucket in the one-shot `objectstore-init` service; no running service holds that secret.
   - `adlc-exporter` (Read/Write/List on `adlc-audit` only) is used by the orchestrators.
   - The verifier also uses `adlc-exporter`, because SeaweedFS refuses read-only identities (see Context). Any write the verifier made would itself show up as an extra version.
7. **No SDK.** The S3 client is SigV4 over `fetch` (`@adlc/adapters`), checked against AWS's published test vectors. Keys are listed through `ListObjectVersions`.

## Consequences
- **Detected.** Rewriting or deleting audit rows, deleting the tail, overwriting or deleting exported objects, and deleting the whole bucket.
- **Detected and recoverable.** In each of those cases, the original locked versions are still readable, except after a bucket deletion.
- **Not detected.** An attacker who deletes the bucket **and** re-forges the entire database chain from genesis. Closing this needs signed segments, or a copy outside the attacker's control. That is option 2, after OPEN-07.
- **SeaweedFS gaps, reported in the phase report:**
  - overwrites and deletes are not refused, only made visible;
  - an admin can delete a locked bucket;
  - there is no read-only identity.

  The production store must be re-measured against this list.
- **Open decision.** The retention period is Pioneer's ISMS decision. `AUDIT_EXPORT_RETENTION_DAYS` has no default; the dev stack uses 1 day.
- **Dev store after a tamper drill.** It stays flagged until `pnpm dev:down --volumes`: locked versions cannot be removed, which is the point.
