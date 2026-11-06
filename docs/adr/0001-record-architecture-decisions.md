# 0001 — Record architecture decisions
Status: Accepted   Date: 2026-11-04   Requirements: P0-WP1

## Context
CLAUDE.md §6 requires every decision not already made in `spec.md` to be recorded.

## Options
1. ADRs in `docs/adr/`, one file per decision.
2. Decisions inside phase reports.

## Decision
Option 1. Files are named `NNNN-kebab-title.md` from `0000-template.md` (context, options, decision, consequences). An ADR is never edited after acceptance; a new ADR supersedes it. Phase reports list the ADRs created in the phase.

## Consequences
Decisions are reviewable in the same PR as the code they shape.
