import { InvalidTransitionError } from "./errors.js";
import { defineMachine } from "./state-machine.js";
import type { Actor } from "./vocabulary.js";

/** Gate IDs (spec.md §5). */
export const GATE_IDS = ["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G-CR", "G2Δ", "G3Δ", "G4Δ"] as const;
export type GateId = (typeof GATE_IDS)[number];

/** Gates that need two distinct approvers (spec.md §5: "Two-key for G1–G4"). */
export const TWO_KEY_GATES: readonly GateId[] = ["G1", "G2", "G3", "G4"];

/** Gate workflow (SDD §10.1): Open → Ready for Approval → Approved / Rejected. */
export const GATE_STATUSES = ["Open", "Ready for Approval", "Approved", "Rejected"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

export const gateMachine = defineMachine<GateStatus>("gate", {
  Open: ["Ready for Approval"],
  "Ready for Approval": ["Approved", "Rejected"],
  Approved: [],
  Rejected: [],
});

export function requiredApprovals(gate: GateId): number {
  return TWO_KEY_GATES.includes(gate) ? 2 : 1;
}

/**
 * Applies a gate verdict mirrored from Jira (hard rule 2). Only human actors can resolve a gate,
 * and two-key gates need two distinct humans. No timeout or default path exists.
 */
export function assertGateResolution(
  gate: GateId,
  from: GateStatus,
  to: GateStatus,
  approvers: readonly Actor[],
): void {
  gateMachine.assertTransition(from, to);
  if (to !== "Approved" && to !== "Rejected") return;
  if (approvers.length === 0 || approvers.some((a) => a.kind !== "human")) {
    throw new InvalidTransitionError("gate", from, to, "only humans resolve gates");
  }
  if (to === "Approved" && new Set(approvers.map((a) => a.id)).size < requiredApprovals(gate)) {
    throw new InvalidTransitionError("gate", from, to, `${gate} needs ${requiredApprovals(gate)} distinct approvers`);
  }
}
