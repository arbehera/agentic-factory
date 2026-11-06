import { createDb, runMigrations } from "@adlc/db";
import type { IssueTracker, ObjectStore, SourceControl } from "@adlc/adapters";
import type { ReviewerSets } from "@adlc/schemas";
import type { ExecutorBackend } from "@adlc/executor";
import { createLogger, type Logger } from "@adlc/telemetry";
import { freshDatabase, seedProjectAndDefinition, type TestDatabase } from "@adlc/testing";
import { ManualClock } from "@adlc/control-plane";
import { loadConfig } from "../src/config.js";
import type { CandidateSource, ClaimCandidate } from "../src/dispatcher.js";
import { buildOrchestrator, type Orchestrator } from "../src/orchestrator.js";

export { skipIntegration } from "@adlc/testing";

export const silentLogger: Logger = createLogger("orchestrator-test", { level: "silent" });
export const T0 = new Date("2026-11-05T08:00:00.000Z");

/** A candidate source the test controls: whatever is in `queue` is offered on every tick. */
export class QueueSource implements CandidateSource {
  queue: ClaimCandidate[] = [];
  candidates(limit: number): Promise<ClaimCandidate[]> {
    return Promise.resolve(this.queue.slice(0, limit));
  }
}

export interface Harness {
  db: TestDatabase;
  orch: Orchestrator;
  clock: ManualClock;
  source: QueueSource;
  seed: { projectId: string; agentDefinitionId: string };
  close(): Promise<void>;
}

export async function harness(
  env: Record<string, string> = {},
  executor?: ExecutorBackend,
  issues?: IssueTracker,
  extra: { scm?: SourceControl; reviewerSets?: ReviewerSets; objectStore?: ObjectStore } = {},
): Promise<Harness> {
  const db = await freshDatabase({ migrate: (pool) => runMigrations(createDb(pool)) });
  const clock = new ManualClock(T0);
  const source = new QueueSource();
  const orch = buildOrchestrator(loadConfig({ DATABASE_URL: db.url, LEADER_POLL_MS: "100", ...env }), { clock, logger: silentLogger, candidates: source, ...(executor ? { executor } : {}), ...(issues ? { issues } : {}), ...extra });
  const seed = await seedProjectAndDefinition(db.pool);
  return {
    db,
    orch,
    clock,
    source,
    seed,
    close: async () => {
      await orch.close();
      await db.close();
    },
  };
}

export const candidate = (h: Harness, taskKey: string, complexity: ClaimCandidate["complexity"] = "S"): ClaimCandidate => ({
  taskKey,
  projectId: h.seed.projectId,
  complexity,
  agentDefinitionId: h.seed.agentDefinitionId,
  kind: "task-pipeline",
});

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition not met in time");
}
