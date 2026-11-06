import type { DispatchEnvironment } from "./pack.js";

/**
 * Executor slots (FR-ORC-014, SDD §17.3). The pilot has 8 concurrent run slots; sandbox projects
 * (agent and pack qualification, canaries) may hold at most 2 of them, so they can never starve
 * production work. Both numbers are configuration.
 */
export interface SlotPolicy {
  total: number;
  sandboxQuota: number;
}

export const PILOT_SLOT_POLICY: SlotPolicy = { total: 8, sandboxQuota: 2 };

export interface ActiveRuns {
  total: number;
  sandbox: number;
}

export function hasFreeSlot(policy: SlotPolicy, active: ActiveRuns, env: DispatchEnvironment): boolean {
  if (active.total >= policy.total) return false;
  return env !== "sandbox" || active.sandbox < policy.sandboxQuota;
}
