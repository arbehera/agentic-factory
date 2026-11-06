# 0007 — Grammar of the Pioneer tasks.md and importer strictness
Status: Proposed (confirm at Phase 0 review)   Date: 2026-11-05   Requirements: FR-IMP-001, FR-IMP-002, AT-P0-08

## Context
FR-IMP-001 gives the token shapes (`- [ ] T### [P] [US#]`, `[REQ-IDs] {comp:} {cx:} {flags}`, `depends:`, `ACn:`) and the one example in SDD §3.1.2. It does not say how strict the importer is, what counts as a task line, or how continuation lines end.

## Decision
1. **Task lines.** Every checkbox list item (`- [ ]`, `- [x]`, `- []`, …) outside a fenced code block must be a well-formed task. A list item that starts with `T###` but has no checkbox is also an error. Other list items, such as Spec Kit's `- [P] tasks = …` note and `- **[P]**:` bullets, are prose. Fenced blocks are skipped, because Spec Kit quotes task text in "Parallel Example" sections.
2. **Token order.**
   - Bracket tokens come in a fixed order: `[P]`, then `[US#]`, then `[REQ-IDs]`, each at most once.
   - Brace tokens come after all brackets, in any order: `{comp:Name}` at most once, `{cx:S|M|L}` at most once, and any number of flags `{lower-kebab}`.
   - The rest of the line is the title, which may contain brackets.
3. **Requirement IDs** are requirement-level global IDs (`STK|SYS|HWR|CSR|SWR-n`). Spec Kit's per-feature `FR-###` IDs are rejected, because Pioneer replaces them (SDD §3.1.2).
4. **Strict syntax, lenient presence.** Malformed, unknown or duplicate tokens, XL complexity, and checked boxes are errors. A *missing* `[REQ]`, `{comp:}` or `{cx:}` gives `[]` or `null`, because the DoR Stage A checks (FR-DOR-001, Phase 2) decide readiness and raise Decisions. If the parser rejected missing tokens too, those DoR checks could never run.
5. **Continuation lines.** `depends:` (at most one, non-empty, known task IDs, not the task itself) and `AC1:`…`ACn:` (numbered consecutively, non-empty) must follow their task directly, indented. A blank line or an unindented line ends the task block. Any other indented line inside a block is an error.
6. **Errors.** All issues are collected and reported as `path:line: message`, sorted by line. The CLI exits 1 for format errors and 2 for usage or source errors.
7. **Output.** The §6 shape, plus `userStory` and `parallel`, because FR-IMP-003 creates a Story per user story. Output is deterministic (stable key order, 2-space JSON, trailing newline), so re-runs are byte-identical. It is re-validated against `tasksImportFileSchema`; its JSON Schema is exported at `packages/schemas/json-schema/tasks.import.schema.json`.
8. **Not checked by the importer.** Dependency cycles, critical path and contract existence are the Phase 2 dependency and DoR checks.

## Consequences
The fixtures in `test/fixtures/speckit-1.2.6/` are provisional (plan Q-08). Real `specify` 1.2.6 output may show constructs this grammar rejects. Any such change must come with a new fixture and an update to this ADR.
