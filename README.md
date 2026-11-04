# adlc-platform

The ADLC platform: role-based AI agents doing product-engineering work under human approval gates.

- What to build: [`spec.md`](spec.md). How to work in this repo: [`CLAUDE.md`](CLAUDE.md).
- Current phase: [`docs/phase-status.md`](docs/phase-status.md). Plans and reports: `docs/phase-reports/`. Decisions: `docs/adr/`.

## Getting started

Requires Node.js 22 LTS (`.nvmrc`) and pnpm 9 through corepack (`corepack enable pnpm`).

```bash
pnpm install
pnpm verify          # lint + typecheck + tests with coverage + core-neutrality check
```

The scripts in CLAUDE.md §3 that belong to later work packages (`db:migrate`, `dev:up`, `test:e2e`, `test:load`) are added by those work packages.
