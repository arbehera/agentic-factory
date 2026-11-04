import { InvalidTransitionError } from "./errors.js";
import { defineMachine } from "./state-machine.js";
import type { Actor } from "./vocabulary.js";

/**
 * Jira task statuses (SDD §8.2): Draft → Needs Clarification ⇄ To Do → In Progress → In Review
 * → Awaiting Approval → Done, with side states Blocked and Needs Human. Jira holds the status
 * (hard rule 4); this table is what the orchestrator is allowed to request. See ADR-0004.
 */
export const TASK_STATUSES = [
  "Draft",
  "Needs Clarification",
  "To Do",
  "In Progress",
  "In Review",
  "Awaiting Approval",
  "Done",
  "Blocked",
  "Needs Human",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const taskStatusMachine = defineMachine<TaskStatus>("task-status", {
  Draft: ["Needs Clarification", "To Do"],
  "Needs Clarification": ["To Do"],
  // Claim (S0–S2) or DoR failure at claim time (FR-DOR-002).
  "To Do": ["In Progress", "Needs Clarification"],
  // Lease expiry returns the task to To Do (SDD §8.4); new dependency parks it (Blocked).
  "In Progress": ["In Review", "To Do", "Blocked", "Needs Human"],
  // Changes requested return to S4 (In Progress); S10 moves to Awaiting Approval.
  "In Review": ["In Progress", "Awaiting Approval", "To Do", "Blocked", "Needs Human"],
  // Merge sets Done; G5 rejection or merge-queue failure returns to To Do (SDD §8.4).
  "Awaiting Approval": ["Done", "To Do"],
  Done: [],
  Blocked: ["To Do"],
  "Needs Human": ["To Do"],
});

/** The only identity allowed to set Done (SDD §8.2, §10.1; FR-JIRA-001). */
export const DONE_ACTOR_ID = "adlc-orchestrator";

/**
 * Checks a status change including the actor rule: Done is set only by the merge event through
 * the `adlc-orchestrator` service identity — never by an agent run or a human through ADLC.
 */
export function assertTaskTransition(from: TaskStatus, to: TaskStatus, actor: Actor): void {
  taskStatusMachine.assertTransition(from, to);
  if (to === "Done" && !(actor.kind === "service" && actor.id === DONE_ACTOR_ID)) {
    throw new InvalidTransitionError("task-status", from, to, `Done is reserved for ${DONE_ACTOR_ID}`);
  }
}
