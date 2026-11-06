import { agentRunMachine, type Actor, type AgentRunState } from "@adlc/domain";
import type { AgentRunRepository } from "@adlc/db";

export const ORCHESTRATOR_ACTOR: Actor = { kind: "service", id: "adlc-orchestrator" };

/**
 * Ends a run whose lease is gone: `lost` when it may have been executing, `stopped` when it never
 * started. Already-terminal runs are left unchanged. Returns the state applied, or null.
 */
export async function retireRun(runs: AgentRunRepository, runId: string, reason: string, now: Date): Promise<AgentRunState | null> {
  const run = await runs.get(runId);
  if (!run || runs.isTerminal(run)) return null;
  const from = run.state as AgentRunState;
  const to: AgentRunState = agentRunMachine.canTransition(from, "lost") ? "lost" : "stopped";
  await runs.transition(runId, to, ORCHESTRATOR_ACTOR, reason, now);
  return to;
}
