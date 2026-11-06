import { InvalidIdError } from "./errors.js";

/** Decision IDs: `DEC-nnnn` (spec.md §5), at least four digits, allocated from a DB sequence. */
export const DECISION_ID_RE = /^DEC-\d{4,}$/;

export function formatDecisionId(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new InvalidIdError(`decision number must be a positive integer: ${n}`);
  return `DEC-${String(n).padStart(4, "0")}`;
}

export function isDecisionId(s: string): boolean {
  return DECISION_ID_RE.test(s);
}

/** Spec Kit task IDs: `T###` (FR-IMP-001). */
export const SPEC_TASK_ID_RE = /^T\d{3,}$/;

/** Spec feature directories: `NNN-slug` (spec.md §6, `specs/NNN-*`). */
export const FEATURE_RE = /^\d{3}-[a-z0-9][a-z0-9-]*$/;

/** Jira External ID used for idempotent creation: `<feature>/<T###>` (FR-IMP-003). */
export function externalTaskId(feature: string, taskId: string): string {
  if (!FEATURE_RE.test(feature)) throw new InvalidIdError(`invalid feature: ${feature}`);
  if (!SPEC_TASK_ID_RE.test(taskId)) throw new InvalidIdError(`invalid task id: ${taskId}`);
  return `${feature}/${taskId}`;
}

/** Requirement-level global IDs a task may reference (SDD §9.2): `STK-n`, `SYS-n`, `HWR-n`, `CSR-n`, `SWR-n`. */
export const REQUIREMENT_ID_PREFIXES = ["STK", "SYS", "HWR", "CSR", "SWR"] as const;
export const REQUIREMENT_ID_RE = new RegExp(String.raw`^(${REQUIREMENT_ID_PREFIXES.join("|")})-\d+$`);
