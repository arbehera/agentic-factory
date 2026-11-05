import {
  ADVISORY_LOCKS,
  AgentRunRepository,
  AuditRepository,
  BudgetLedgerRepository,
  ControlFlagRepository,
  JobQueue,
  createDb,
  createPool,
  LeaseRepository,
  ProjectRepository,
  type Db,
} from "@adlc/db";
import type { ExecutorBackend } from "@adlc/executor";
import type { Logger } from "@adlc/telemetry";
import type pg from "pg";
import { BudgetService, HeartbeatService, KillSwitch, type Clock } from "@adlc/control-plane";
import { ConfigError, type OrchestratorConfig } from "./config.js";
import { Dispatcher, type CandidateSource } from "./dispatcher.js";
import { LeaderElector } from "./leader-elector.js";
import { Reaper } from "./reaper.js";
import { RunLauncher, START_RUN_JOB, Supervisor } from "./launcher.js";
import { OrchestratorRuntime, type LeaderJob } from "./runtime.js";
import { Worker } from "./worker.js";

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
  queue: JobQueue;
  /** Present when an executor backend is configured on this replica. */
  launcher: RunLauncher | null;
  supervisor: Supervisor | null;
  worker: Worker | null;
  /** Starts leader election (and the leader jobs it brings) and this replica's worker. */
  start(): void;
  close(): Promise<void>;
}

/** Composition root: wires repositories and services. Deterministic — no LLM anywhere (hard rule 1). */
export function buildOrchestrator(
  config: OrchestratorConfig,
  deps: { clock: Clock; logger: Logger; candidates?: CandidateSource; executor?: ExecutorBackend },
): Orchestrator {
  const pool = createPool(config.DATABASE_URL);
  const db = createDb(pool);
  const leases = new LeaseRepository(db);
  const runs = new AgentRunRepository(db);
  const audit = new AuditRepository(db);
  const killSwitch = new KillSwitch(new ControlFlagRepository(db), deps.clock);
  const budgets = new BudgetService(new BudgetLedgerRepository(db));
  const slots = { total: config.EXECUTOR_SLOTS, sandboxQuota: config.SANDBOX_SLOTS };
  const queue = new JobQueue(db);
  const dispatcher = new Dispatcher(deps.candidates ?? noCandidates, leases, runs, budgets, killSwitch, new ProjectRepository(db), slots, queue, deps.clock);

  let launcher: RunLauncher | null = null;
  let supervisor: Supervisor | null = null;
  let worker: Worker | null = null;
  const executorJobs: LeaderJob[] = [];
  if (deps.executor) {
    if (!config.AGENT_IMAGE || !config.AGENT_GATEWAY_URL) throw new ConfigError("an executor needs AGENT_IMAGE and AGENT_GATEWAY_URL");
    const launch = new RunLauncher(
      db,
      deps.executor,
      {
        image: config.AGENT_IMAGE,
        gatewayUrl: config.AGENT_GATEWAY_URL,
        network: config.AGENT_NETWORK,
        limits: { cpus: config.AGENT_CPUS, memoryMb: config.AGENT_MEMORY_MB, pidsLimit: config.AGENT_PIDS, scratchMb: config.AGENT_SCRATCH_MB },
      },
      deps.clock,
      deps.logger,
    );
    const sup = new Supervisor(db, deps.executor, deps.clock);
    launcher = launch;
    supervisor = sup;
    worker = new Worker(queue, { [START_RUN_JOB]: (j) => launch.launch(String(j.payload.runId)) }, deps.clock, deps.logger, {
      pollMs: config.WORKER_POLL_MS,
      lockMs: 120_000,
      retryMs: 5_000,
    });
    executorJobs.push({ name: "supervise", intervalMs: config.SUPERVISE_INTERVAL_MS, run: () => sup.tick() });
  }
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
      ...executorJobs,
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
    queue,
    launcher,
    supervisor,
    worker,
    start: () => {
      runtime.start();
      worker?.start();
    },
    close: async () => {
      worker?.stop();
      await runtime.stop();
      await pool.end();
    },
  };
}
