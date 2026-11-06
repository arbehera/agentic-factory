# Spec Kit 1.2.6 importer fixtures — PROVISIONAL

> **PROVISIONAL (plan Q-08):** these files were written by hand in the documented 1.2.6 `tasks.md` format. They are **not** real `/speckit.tasks` output. Before the Phase 0 report, they must be replaced or supplemented with output captured from `specify` 1.2.6 (FR-IMP-002).

Each directory is one fixture:

- `tasks.md`: the input. The directory name is the feature, so the specRef path is `specs/<dir>/tasks.md`.
- `tasks.import.expected.json`: the reviewed golden output, produced at commit SHA `0000000`.

The contract test (`apps/importer/test/contract.test.ts`) discovers every directory automatically, so adding real output only needs a new directory.
