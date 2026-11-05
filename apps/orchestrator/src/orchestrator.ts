import {
  ADVISORY_LOCKS,
  AgentRunRepository,
  AuditRepository,
  BudgetLedgerRepository,
  ControlFlagRepository,
  createDb,
  createPool,
  LeaseRepository,
  ProjectRepository,
  type Db,
} from "@adlc/db";
import type { Logger } from "@adlc/telemetry";
import type pg from "pg";
import { BudgetService, HeartbeatService, KillSwitch, type Clock } from "@adlc/control-plane";
import type { OrchestratorConfig } from "./config.js";
import { Dispatcher, type CandidateSource } from "./dispatcher.js";
import { LeaderElector } from "./leader-elector.js";
import { Reaper } from "./reaper.js";
import { OrchestratorRuntime } from "./runtime.js";

/** Until the Jira-backed ready frontier exists (FR-ORC-005, Phase 2) nothing is offered. */
export const noCandidates: CandidateSource = { candidates: () => Promise.resolve([]) };

export interface Orchestrator {
  pool: pg.Pool;
  db: Db;
  elector: LeaderElector;
  runtime: OrchestratorRuntime;
  killSwitch: KillSwitch;
  heartbeats: HeartbeatService;
  dispatcher: Dispatcher;
  reaper: Reaper;
  close(): Promise<void>;
}

/** Composition root: wires repositories and services. Deterministic — no LLM anywhere (hard rule 1). */
export function buildOrchestrator(
  config: OrchestratorConfig,
  deps: { clock: Clock; logger: Logger; candidates?: CandidateSource },
): Orchestrator {
  const pool = createPool(config.DATABASE_URL);
  const db = createDb(pool);
  const leases = new LeaseRepository(db);
  const runs = new AgentRunRepository(db);
  const audit = new AuditRepository(db);
  const killSwitch = new KillSwitch(new ControlFlagRepository(db), deps.clock);
  const budgets = new BudgetService(new BudgetLedgerRepository(db));
  const slots = { total: config.EXECUTOR_SLOTS, sandboxQuota: config.SANDBOX_SLOTS };
  const dispatcher = new Dispatcher(deps.candidates ?? noCandidates, leases, runs, budgets, killSwitch, new ProjectRepository(db), slots, deps.clock);
  const reaper = new Reaper(leases, runs, deps.clock);
  const elector = new LeaderElector(config.DATABASE_URL, ADVISORY_LOCKS.dispatcherLeader, config.LEADER_POLL_MS, deps.logger);
  const log = deps.logger;
  const runtime = new OrchestratorRuntime(
    elector,
    [
      {
        name: "dispatch",
        intervalMs: config.DISPATCH_INTERVAL_MS,
        run: async () => {
          const r = await dispatcher.tick();
          if (r.claimed.length > 0 || r.paused) log.info({ claimed: r.claimed.length, skipped: r.skipped.length, paused: r.paused }, "dispatch tick");
        },
      },
      {
        name: "reap",
        intervalMs: config.REAP_INTERVAL_MS,
        run: async () => {
          for (const r of await reaper.tick()) log.warn({ taskKey: r.taskKey, runId: r.runId, reason: r.reason }, "lease reaped");
        },
      },
      { name: "audit-partitions", intervalMs: config.MAINTENANCE_INTERVAL_MS, run: () => audit.ensurePartitions(deps.clock.now()) },
    ],
    deps.logger,
  );
  return {
    pool,
    db,
    elector,
    runtime,
    killSwitch,
    heartbeats: new HeartbeatService(leases, killSwitch, deps.clock),
    dispatcher,
    reaper,
    close: async () => {
      await runtime.stop();
      await pool.end();
    },
  };
}
