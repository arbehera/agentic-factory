---
description: "Task list template for feature implementation"
---

# Tasks: Report Export

**Input**: Design documents from `/specs/001-plain-speckit/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: The examples below include test tasks because the feature specification requests them.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [ ] T001 Create project structure per implementation plan
- [ ] T002 Initialize the service project with its dependencies
- [ ] T003 [P] Configure linting and formatting tools

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 Setup database schema and migrations framework in src/db/
- [ ] T005 [P] Implement request validation middleware in src/middleware/validate

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Export a report as CSV (Priority: P1) 🎯 MVP

**Goal**: A user can download any saved report as a CSV file

**Independent Test**: Request the export endpoint for a saved report and compare the CSV with the report rows

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T006 [P] [US1] Contract test for GET /reports/{id}/export in tests/contract/export.spec
- [ ] T007 [P] [US1] Integration test for the CSV export journey in tests/integration/export.spec

### Implementation for User Story 1

- [ ] T008 [US1] Implement the CSV serializer in src/export/csv
- [ ] T009 [US1] Implement GET /reports/{id}/export in src/api/export (depends on T008)

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - Schedule a recurring export (Priority: P2)

**Goal**: A user can schedule a daily export delivered by email

**Independent Test**: Create a schedule, advance the clock, and check that one email with the CSV was sent

### Implementation for User Story 2

- [ ] T010 [P] [US2] Create the ExportSchedule model in src/models/export-schedule
- [ ] T011 [US2] Implement the scheduler job in src/jobs/export-scheduler

---

## Phase 5: Polish & Cross-Cutting Concerns

- [ ] T012 [P] Documentation updates in docs/export.md
- [ ] T013 Run the quickstart.md validation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Models before services; services before endpoints

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "Contract test for GET /reports/{id}/export in tests/contract/export.spec"
- [ ] T999 [US1] A task-shaped line inside a code block is ignored
```

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test User Story 1 independently

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Commit after each task or logical group
