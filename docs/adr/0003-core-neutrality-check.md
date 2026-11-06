# 0003 — Scope of the core-neutrality check
Status: Proposed (deny-list contents to be reviewed, plan Q-09)   Date: 2026-11-04   Requirements: FR-PCK-005, AT-P0-07

## Context
FR-PCK-005: CI fails if any file under `apps/` or `packages/` names a specific OS, platform, language toolchain or vendor tool. spec.md §4 also places the Docker executor, Jira/GitHub/Jenkins/Keycloak adapters and PostgreSQL in the core.

## Options
1. Deny everything vendor-named, including platform infrastructure. This conflicts with spec.md §4.2.
2. Deny product technology (target OS/RTOS, hardware, product toolchains, analysers, debug tools, pack IDs); allow platform infrastructure.

## Decision
Option 2. The terms live in `packages/config/neutrality-denylist.txt`, and the test exemptions in `neutrality-allowlist.txt` (test files and fixtures only). Matching is case-insensitive and whole-token. Build output, dependencies and binary files are skipped. Each finding is reported as `file:line:col`, and the check exits 1. A missing or empty deny-list exits 2, so the check can never pass by having no rules.

## Consequences
New pack technologies must add their terms to the deny-list in the same PR as the pack. Platform infrastructure names are accepted in the core because the spec puts them there.
