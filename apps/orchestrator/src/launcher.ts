import { agentRunMachine, isLeaseLive, type AgentRunState } from "@adlc/domain";
import {
  AgentDefinitionRepository,
  AgentRunRepository,
  GatewaySessionRepository,
  LeaseRepository,
  ProjectRepository,
  type Db,
} from "@adlc/db";
import { GATEWAY_TOKEN_ENV, RUN_EXIT_CODES, type ExecutorBackend, type RunHandle, type RunLimits } from "@adlc/executor";
import type { Clock } from "@adlc/control-plane";
import type { Logger } from "@adlc/telemetry";
import { ORCHESTRATOR_ACTOR, retireRun } from "./runs.js";

export const START_RUN_JOB = "start-run";

export interface LaunchConfig {
  /** Digest-pinned agent image (one runtime image for every role in Phase 0). */
  image: string;
  /** Gateway URL as seen from the agent network. */
  gatewayUrl: string;
  /** Internal Docker network whose only reachable service is the gateway. */
  network: string;
  limits: RunLimits;
}

export type LaunchOutcome = "launched" | "skipped" | "stale" | "failed";

/**
 * Starts the container for a claimed run (worker side, FR-ORC-013). Re-checks that the run still
 * holds a live lease, issues the run's gateway session (bound to its fencing token, expiring at
 * the lease deadline) and creates the container from the hardened spec. Any failure cleans up:
 * container removed, session revoked, lease released, run ended.
 */
export class RunLauncher {
  private readonly runs: AgentRunRepository;
  private readonly leases: LeaseRepository;
  private readonly sessions: GatewaySessionRepository;
  private readonly definitions: AgentDefinitionRepository;
  private readonly projects: ProjectRepository;

  constructor(
    db: Db,
    private readonly executor: ExecutorBackend,
    private readonly config: LaunchConfig,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    this.runs = new AgentRunRepository(db);
    this.leases = new LeaseRepository(db);
    this.sessions = new GatewaySessionRepository(db);
    this.definitions = new AgentDefinitionRepository(db);
    this.projects = new ProjectRepository(db);
  }

  async launch(runId: string): Promise<LaunchOutcome> {
    const now = this.clock.now();
    const run = await this.runs.get(runId);
    if (!run || run.state !== "queued" || !run.taskKey) return "skipped"; // already launched or ended
    const lease = await this.leases.get(run.taskKey);
    if (!lease || lease.runId !== run.id || !isLeaseLive(lease, now)) {
      await retireRun(this.runs, run.id, "lease lost before the container started", now);
      return "stale";
    }
    const log = this.logger.child({ projectId: run.projectId, runId, taskKey: run.taskKey });
    const [definition, project] = await Promise.all([this.definitions.get(run.agentDefinitionId), this.projects.get(run.projectId)]);
    const token = await this.sessions.issue(
      { runId, role: definition.role, projectId: run.projectId, taskKey: run.taskKey, fencingToken: lease.fencingToken, expiresAt: lease.deadlineAt },
      now,
    );

    let handle: RunHandle | null = null;
    try {
      handle = await this.executor.create({
        runId,
        image: this.config.image,
        network: this.config.network,
        limits: this.config.limits,
        env: {
          ADLC_GATEWAY_URL: this.config.gatewayUrl,
          [GATEWAY_TOKEN_ENV]: token,
          ADLC_RUN_ID: runId,
          ADLC_TASK_KEY: run.taskKey,
          ADLC_ROLE: definition.role,
          ADLC_REPO: project.repos[0] ?? "",
          ADLC_MODEL: definition.modelId,
        },
      });
      await this.runs.transition(runId, "starting", ORCHESTRATOR_ACTOR, "container created", now, { containerId: handle.containerId });
      await this.executor.start(handle);
      await this.runs.transition(runId, "running", ORCHESTRATOR_ACTOR, "container started", this.clock.now());
      log.info({ containerId: handle.containerId }, "agent container started");
      return "launched";
    } catch (err) {
      log.error({ err: (err as Error).message }, "agent container failed to start");
      if (handle) await this.executor.delete(handle).catch(() => undefined);
      await this.sessions.revokeRun(runId, this.clock.now());
      await this.leases.release({ taskKey: run.taskKey, fencingToken: lease.fencingToken }, "container failed to start", this.clock.now()).catch(() => undefined);
      const current = (await this.runs.get(runId))?.state as AgentRunState | undefined;
      const to: AgentRunState = current && agentRunMachine.canTransition(current, "failed") ? "failed" : "stopped";
      if (current && agentRunMachine.canTransition(current, to)) {
        await this.runs.transition(runId, to, ORCHESTRATOR_ACTOR, `container failed to start: ${(err as Error).name}`, this.clock.now());
      }
      return "failed";
    }
  }
}

export interface SupervisedExit {
  runId: string;
  state: AgentRunState;
  reason: string;
}

/**
 * Supervisor (leader only). Ends runs whose container has exited or vanished: records the outcome
 * from the exit code (RUN_EXIT_CODES), revokes the gateway session, releases the execution lease
 * and removes the container. Failed containers are kept for diagnosis until logs are archived
 * (P0-WP10/WP11).
 */
export class Supervisor {
  private readonly runs: AgentRunRepository;
  private readonly leases: LeaseRepository;
  private readonly sessions: GatewaySessionRepository;

  constructor(
    db: Db,
    private readonly executor: ExecutorBackend,
    private readonly clock: Clock,
  ) {
    this.runs = new AgentRunRepository(db);
    this.leases = new LeaseRepository(db);
    this.sessions = new GatewaySessionRepository(db);
  }

  async tick(): Promise<SupervisedExit[]> {
    const ended: SupervisedExit[] = [];
    for (const run of await this.runs.listWithContainer()) {
      if (!run.containerId) continue;
      const handle = { runId: run.id, containerId: run.containerId };
      const status = await this.executor.status(handle);
      if (status.state === "running" || status.state === "created") continue;
      const now = this.clock.now();
      let to: AgentRunState;
      let reason: string;
      if (status.state === "missing") {
        to = agentRunMachine.canTransition(run.state as AgentRunState, "lost") ? "lost" : "failed";
        reason = "container disappeared";
      } else if (status.exitCode === RUN_EXIT_CODES.succeeded) {
        to = "succeeded";
        reason = "container exited 0";
      } else if (status.exitCode === RUN_EXIT_CODES.stoppedByDirective) {
        to = "stopped";
        reason = "stopped after step on directive";
      } else {
        to = "failed";
        reason = `container exited ${status.exitCode ?? "?"}${status.oomKilled ? " (out of memory)" : ""}`;
      }
      await this.runs.transition(run.id, to, ORCHESTRATOR_ACTOR, reason, now, { exitReason: reason });
      await this.sessions.revokeRun(run.id, now);
      const lease = run.taskKey ? await this.leases.get(run.taskKey) : null;
      if (lease && run.taskKey && lease.runId === run.id) {
        await this.leases.release({ taskKey: run.taskKey, fencingToken: lease.fencingToken }, `run ended: ${reason}`, now);
      }
      if (to === "succeeded" || to === "stopped") await this.executor.delete(handle);
      ended.push({ runId: run.id, state: to, reason });
    }
    return ended;
  }
}
