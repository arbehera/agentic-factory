# 0005 — Audit event storage: hash chain, partitions, append-only
Status: Proposed   Date: 2026-11-04   Requirements: hard rule 11, NFR-001, NFR-006

## Context
NFR-006 asks for a time-partitioned audit table with a daily hash-chained WORM export. drizzle-kit cannot declare partitioned tables.

## Decision
- **Hash chain.** `hash = sha256(canonical JSON of {seq, ts, prevHash, actor, action, target, reason, beforeHash, afterHash, correlation})`, computed in `@adlc/domain`. The first event links to the all-zero genesis hash.
- **Serialised appends.** Each append holds the transaction advisory lock `ADVISORY_LOCKS.auditChain`, so concurrent writers produce one linear chain. Sequence gaps (from rolled-back appends) are allowed; links are what get verified.
- **Partitions.** `audit_event` is `PARTITION BY RANGE (ts)` with monthly partitions created by `adlc_ensure_audit_partition(date)`. Partition bounds are UTC midnights. A DEFAULT partition means an insert never fails for lack of a partition. A maintenance job (P0-WP3) creates each next month's partition in advance.
- **Append-only.** Triggers reject UPDATE, DELETE and TRUNCATE. A superuser who bypasses the triggers is still caught by chain verification, as an integration test shows.
- **Hand-written migration.** The table is created in `migrations/0001_audit_event.sql`. `src/audit-table.ts` is only the query-builder view of it and is excluded from drizzle-kit.

## Consequences
- **Tail deletion.** The chain alone cannot detect events deleted from the tail. The daily export records the last `{seq, hash}` as an anchor, and verification starts from that anchor. The export target waits on the object-store decision (plan Q-05).
- **DB roles.** Production must also revoke UPDATE, DELETE and TRUNCATE from application roles. This lands in P0-WP11.
