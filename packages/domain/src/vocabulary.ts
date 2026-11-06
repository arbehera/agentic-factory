/**
 * Closed vocabularies from spec.md §5 (domain model). Each list is the single source for the
 * Zod schemas in `@adlc/schemas` and the CHECK constraints in `@adlc/db`.
 */

export const PIPELINE_STEPS = [
  "S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12",
] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export const AGENT_RUN_KINDS = ["speckit-command", "task-pipeline", "review", "canary"] as const;
export type AgentRunKind = (typeof AGENT_RUN_KINDS)[number];

export const PACK_KINDS = ["process", "tech"] as const;
export type PackKind = (typeof PACK_KINDS)[number];

/** Lifecycle transitions: `packStatusMachine` in pack.ts (FR-PCK-003). */
export const PACK_STATUSES = ["Draft", "Qualified", "Restricted", "Retired"] as const;
export type PackStatus = (typeof PACK_STATUSES)[number];

export const COMPONENT_LOCK_STATES = ["active", "pending-merge"] as const;
export type ComponentLockState = (typeof COMPONENT_LOCK_STATES)[number];

export const STEP_STATUSES = ["running", "succeeded", "failed"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const BUDGET_SCOPES = ["task", "project", "day", "month"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const TASK_COMPLEXITIES = ["S", "M", "L"] as const;
export type TaskComplexity = (typeof TASK_COMPLEXITIES)[number];

export const MODEL_TIERS = ["A", "B"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Who performed an action (spec.md §5 AuditEvent.actor). */
export const ACTOR_KINDS = ["agent-run", "human", "service"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface Actor {
  kind: ActorKind;
  id: string;
}
