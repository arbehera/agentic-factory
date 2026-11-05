# Tasks: Auto Exposure

**Input**: Design documents from `/specs/002-pioneer-tokens/`

## Format: `[ID] [P?] [Story] [REQ-IDs] {comp:} {cx:} {flags} Description`

## Phase 1: Setup

- [ ] T001 [SWR-200] {comp:ExposureCtrl} {cx:S} Create the component skeleton and unit-test harness in src/ExposureCtrl/

## Phase 2: Foundational

- [ ] T002 [SYS-14,SWR-201] {comp:SensorIf} {cx:M} Publish the sensor interface contract in include/api/sensor.h
      depends: T001
      AC1: The contract compiles stand-alone and is listed in contracts/

## Phase 3: User Story 1 - Stable exposure (Priority: P1) 🎯 MVP

- [ ] T010 [P] [US1] [SWR-230] {comp:ExposureCtrl} {cx:S} Implement the luminance histogram in src/ExposureCtrl/hist.c
      depends: T002
      AC1: Histogram of the reference frame matches the golden histogram bit for bit
- [ ] T012 [P] [US1] [SWR-231] {cx:M} {comp:ExposureCtrl} Implement the exposure target table in src/ExposureCtrl/table.c
      depends: T002
      AC1: Table lookups return the documented target for all 16 scene classes

## Phase 4: User Story 2 - Fast convergence (Priority: P2)

- [ ] T014 [P] [US2] [SWR-233,SWR-234] {comp:ExposureCtrl} {cx:M} {hil} Implement AE step response in src/ExposureCtrl/ae.c
      depends: T010, T012
      AC1: AE converges within 8 frames after a ±2 EV step (HIL scenario Q2)
      AC2: No new blocking static-analysis findings; worst-case stack ≤ 1.5 KB
- [ ] T015 [US2] [CSR-7] {comp:ExposureCtrl} {cx:L} {security} {hil} Harden the exposure command parser against malformed frames

  Notes for reviewers are prose below the task block and are not part of the task.

## Notes

- [P] tasks = different files, no dependencies
