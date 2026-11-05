# ind880-c — reference technology pack (Draft)

This is the first technology pack (SDD Appendix F). In Phase 0 it contains only:

- `pack.yaml`: the manifest. It is validated by `@adlc/pack-sdk` and by a test in `packages/pack-sdk`.
- `Dockerfile`: the toolchain image skeleton. It has no SDK and no compiler (OPEN-04, OPEN-15), and it refuses to build from a base image that is not pinned by digest.

The files the manifest refers to are added later:

| Path | Work package | Open item |
|---|---|---|
| `adapters/build.ts`, `adapters/analysis.ts` | P3-WP7 | OPEN-03 (analysis is a stub until a licensed MISRA analyser is chosen) |
| `adapters/test-target.ts` | P4-WP1 | OPEN-05 (simulated in dev/sandbox) |
| `adapters/release.ts` | P4-WP3 | OPEN-07 |
| `fragments/*`, `skills/*` | P1-WP1, P3-WP7 | OPEN-04 (no SDK material in agent context) |
| `evals/*` | P3-WP5 | OPEN-10 |

Pack Owner: to be named (OPEN-20). The pack stays Draft, which means sandbox use only, until it is qualified (FR-PCK-003).
