import { defineMachine } from "./state-machine.js";

/**
 * AgentRun lifecycle (one container per run, hard rule 6). spec.md §5 names the `state` field
 * without listing values; this set is recorded in ADR-0004.
 *  - `lost`: the lease expired without a heartbeat (crash detection, SDD §8.4).
 *  - `stopped`: stopped by a control (kill switch, portal stop) after pushing WIP.
 */
export const AGENT_RUN_STATES = [
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "stopped",
  "lost",
] as const;
export type AgentRunState = (typeof AGENT_RUN_STATES)[number];

export const agentRunMachine = defineMachine<AgentRunState>("agent-run", {
  queued: ["starting", "stopped"],
  starting: ["running", "failed", "stopped", "lost"],
  running: ["succeeded", "failed", "stopped", "lost"],
  succeeded: [],
  failed: [],
  stopped: [],
  lost: [],
});
