import { agentRunMachine, stateHash, type Actor, type AgentRunKind, type AgentRunState } from "@adlc/domain";
import { eq } from "drizzle-orm";
import { AuditRepository } from "./audit-repository.js";
import type { DbExecutor } from "./client.js";
import { agentRun } from "./schema.js";

export type AgentRunRow = typeof agentRun.$inferSelect;

export class AgentRunNotFoundError extends Error {
  override name = "AgentRunNotFoundError";
}

const TERMINAL = new Set<AgentRunState>(agentRunMachine.terminal);
const runHash = (r: AgentRunRow) => stateHash({ id: r.id, state: r.state, step: r.step, containerId: r.containerId });

/** AgentRun lifecycle (spec.md §5) with audited, machine-checked transitions. */
export class AgentRunRepository {
  constructor(private readonly db: DbExecutor) {}

  async create(
    input: { agentDefinitionId: string; projectId: string; kind: AgentRunKind; taskKey?: string; componentPack?: string },
    actor: Actor,
    now: Date,
  ): Promise<AgentRunRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(agentRun).values({ ...input, state: "queued", createdAt: now }).returning();
      if (!row) throw new Error("insert returned no row");
      await new AuditRepository(tx).append({
        actor,
        action: "run.create",
        target: `run:${row.id}`,
        reason: `${input.kind} run queued${input.taskKey ? ` for ${input.taskKey}` : ""}`,
        beforeHash: null,
        afterHash: runHash(row),
        correlation: { projectId: input.projectId, runId: row.id, taskKey: input.taskKey },
      });
      return row;
    });
  }

  async transition(
    runId: string,
    to: AgentRunState,
    actor: Actor,
    reason: string,
    now: Date,
    patch: { containerId?: string; exitReason?: string } = {},
  ): Promise<AgentRunRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(agentRun).where(eq(agentRun.id, runId)).for("update");
      if (!row) throw new AgentRunNotFoundError(`run ${runId} not found`);
      agentRunMachine.assertTransition(row.state as AgentRunState, to);
      const [updated] = await tx
        .update(agentRun)
        .set({
          state: to,
          ...patch,
          ...(to === "running" ? { startedAt: now, heartbeatAt: now } : {}),
          ...(TERMINAL.has(to) ? { endedAt: now, exitReason: patch.exitReason ?? reason } : {}),
        })
        .where(eq(agentRun.id, runId))
        .returning();
      if (!updated) throw new Error("update returned no row");
      await new AuditRepository(tx).append({
        actor,
        action: "run.state",
        target: `run:${runId}`,
        reason: `${row.state} -> ${to}: ${reason}`,
        beforeHash: runHash(row),
        afterHash: runHash(updated),
        correlation: { projectId: row.projectId, runId, taskKey: row.taskKey ?? undefined },
      });
      return updated;
    });
  }

  async heartbeat(runId: string, now: Date): Promise<void> {
    await this.db.update(agentRun).set({ heartbeatAt: now }).where(eq(agentRun.id, runId));
  }

  async get(runId: string): Promise<AgentRunRow | null> {
    const [row] = await this.db.select().from(agentRun).where(eq(agentRun.id, runId));
    return row ?? null;
  }

  isTerminal(row: AgentRunRow): boolean {
    return TERMINAL.has(row.state as AgentRunState);
  }
}
