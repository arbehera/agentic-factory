import { DecisionInvariantError } from "./errors.js";
import { defineMachine } from "./state-machine.js";

/** Decision classes and routes (spec.md §5, SDD §8.6). */
export const DECISION_CLASSES = ["clarification", "consult", "escalation", "risk", "gate"] as const;
export type DecisionClass = (typeof DECISION_CLASSES)[number];

export const DECISION_ROUTES = ["operational", "design", "human"] as const;
export type DecisionRoute = (typeof DECISION_ROUTES)[number];

export const DECISION_STATUSES = ["open", "escalated", "decided", "withdrawn"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/**
 * A timeout always escalates (hard rule 2, FR-DEC-002). This is a constant, not a field: no
 * Decision can be configured to default or auto-resolve on timeout. See ADR-0004.
 */
export const ON_TIMEOUT = "escalate" as const;

export const decisionMachine = defineMachine<DecisionStatus>("decision", {
  open: ["escalated", "decided", "withdrawn"],
  // Escalation may climb more than one level (agent → role owner → Program Lead).
  escalated: ["escalated", "decided", "withdrawn"],
  decided: [],
  withdrawn: [],
});

export interface DecisionFlags {
  class: DecisionClass;
  reversible: boolean;
  autoResolve: boolean;
}

/**
 * spec.md §5: gate Decisions are irreversible and never auto-resolve; only (lookup) consults may
 * auto-resolve (FR-DEC-001).
 */
export function decisionInvariantViolation(d: DecisionFlags): string | null {
  if (d.class === "gate" && (d.reversible || d.autoResolve)) {
    return "gate Decisions must have reversible=false and autoResolve=false";
  }
  if (d.autoResolve && d.class !== "consult") {
    return `only consult Decisions may auto-resolve, not ${d.class}`;
  }
  return null;
}

export function assertDecisionInvariants(d: DecisionFlags): void {
  const violation = decisionInvariantViolation(d);
  if (violation) throw new DecisionInvariantError(violation);
}
