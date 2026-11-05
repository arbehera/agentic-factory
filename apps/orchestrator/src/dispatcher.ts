import { hasFreeSlot, leaseDeadline, type AgentRunKind, type SlotPolicy, type TaskComplexity } from "@adlc/domain";
import { LeaseHeldError, type AgentRunRepository, type LeaseRepository, type ProjectRepository } from "@adlc/db";
import type { BudgetService, Clock, KillSwitch } from "@adlc/control-plane";
import { ORCHESTRATOR_ACTOR, retireRun } from "./runs.js";

/** A task that is ready to claim. The ready frontier (FR-ORC-005) supplies these in Phase 2. */
export interface ClaimCandidate {
  taskKey: string;
  projectId: string;
  complexity: TaskComplexity;
  agentDefinitionId: string;
  kind: AgentRunKind;
  componentPack?: string;
}

export interface CandidateSource {
  candidates(limit: number): Promise<ClaimCandidate[]>;
}

export interface Claim {
  taskKey: string;
  runId: string;
  fencingToken: bigint;
}

export interface DispatchResult {
  paused: "kill-switch" | null;
  claimed: Claim[];
  skipped: { taskKey: string; reason: string }[];
}

/**
 * Dispatcher skeleton (leader only, FR-ORC-015). Each tick: stop if the kill switch is engaged
 * (FR-ORC-012); skip projects whose daily budget is exhausted (FR-ORC-011) or with no free executor
 * slot (FR-ORC-014, sandbox quota); otherwise create a
 * run and take the task lease with a fresh fencing token (FR-ORC-008). Starting the container is
 * the executor's job (P0-WP4).
 */
export class Dispatcher {
  constructor(
    private readonly source: CandidateSource,
    private readonly leases: LeaseRepository,
    private readonly runs: AgentRunRepository,
    private readonly budgets: BudgetService,
    private readonly killSwitch: KillSwitch,
    private readonly projects: ProjectRepository,
    private readonly slots: SlotPolicy,
    private readonly clock: Clock,
    private readonly batchSize = 10,
  ) {}

  async tick(): Promise<DispatchResult> {
    if (await this.killSwitch.isEngaged()) return { paused: "kill-switch", claimed: [], skipped: [] };
    const result: DispatchResult = { paused: null, claimed: [], skipped: [] };
    for (const c of await this.source.candidates(this.batchSize)) {
      const now = this.clock.now();
      if (!(await this.budgets.canClaim(c.projectId, now))) {
        result.skipped.push({ taskKey: c.taskKey, reason: "project daily budget exhausted" });
        continue;
      }
      const env = await this.projects.environment(c.projectId);
      if (!hasFreeSlot(this.slots, await this.runs.countActive(), env)) {
        result.skipped.push({ taskKey: c.taskKey, reason: env === "sandbox" ? "no free sandbox slot" : "no free executor slot" });
        continue;
      }
      const run = await this.runs.create(
        { agentDefinitionId: c.agentDefinitionId, projectId: c.projectId, kind: c.kind, taskKey: c.taskKey, ...(c.componentPack ? { componentPack: c.componentPack } : {}) },
        ORCHESTRATOR_ACTOR,
        now,
      );
      try {
        const { lease, displaced } = await this.leases.acquire({ taskKey: c.taskKey, runId: run.id, deadlineAt: leaseDeadline(now, c.complexity), now });
        if (displaced) await retireRun(this.runs, displaced.runId, "lease expired before reaping; task re-claimed", now);
        result.claimed.push({ taskKey: c.taskKey, runId: run.id, fencingToken: lease.fencingToken });
      } catch (err) {
        if (!(err instanceof LeaseHeldError)) throw err;
        await this.runs.transition(run.id, "stopped", ORCHESTRATOR_ACTOR, "task already leased", now);
        result.skipped.push({ taskKey: c.taskKey, reason: "task already leased" });
      }
    }
    return result;
  }
}
