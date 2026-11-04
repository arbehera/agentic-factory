# 0002 — Drizzle ORM and drizzle-kit for persistence
Status: Proposed (confirm at Phase 0 review)   Date: 2026-11-04   Requirements: P0-WP2, NFR-008

## Context
spec.md §4.1 lists "Drizzle ORM + drizzle-kit (REVIEW: or Prisma)". CLAUDE.md §3 names Drizzle.

## Options
1. Drizzle: SQL-first, explicit `SELECT … FOR UPDATE SKIP LOCKED` and advisory locks, no separate engine process.
2. Prisma: richer tooling, but locking clauses and advisory locks need raw SQL, and it adds a query-engine binary.

## Decision
Drizzle, because hard rule 8 (PostgreSQL-only queues and locks) depends on row-locking SQL that Drizzle expresses directly.

## Consequences
Migrations are generated with drizzle-kit and reviewed as SQL files in `packages/db`.
