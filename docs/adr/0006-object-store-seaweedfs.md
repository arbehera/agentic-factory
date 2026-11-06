# 0006 — Object store: SeaweedFS
Status: Accepted (human decision, plan Q-05, 2026-11-05)   Date: 2026-11-05   Requirements: NFR-006

## Context
NFR-006 needs object storage for transcripts and logs (retention per ISMS) and for the daily hash-chained WORM audit export. spec.md suggested MinIO, which is AGPL-3.0, a non-permissive licence (CLAUDE.md §10).

## Options
1. MinIO (AGPL-3.0). Needs Legal acceptance.
2. SeaweedFS (Apache-2.0). S3-compatible, permissive licence.
3. An existing Pioneer store. None is known.

## Decision
SeaweedFS, run as a separate service in Compose (P0-WP11). Platform code talks to it only through an `ObjectStore` interface over the S3 API, so a later move to another S3-compatible store is a configuration change.

## Consequences
- **WORM.** Verified in P0-WP11: SeaweedFS 3.97 Object Lock keeps locked versions, but does not refuse overwrites, delete markers or an admin's bucket deletion. The export compensates with a verifier and the database's record of each export (ADR-0015).
- **Spec text.** spec.md §9 NFR-006 still reads "e.g. MinIO" and should be updated at the Phase 0 review.
