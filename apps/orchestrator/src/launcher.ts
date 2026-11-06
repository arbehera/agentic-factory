import type { IssueTracker } from "@adlc/adapters";
import { agentRunMachine, isLeaseLive, NOTIFICATION_EVENTS, type AgentRunState } from "@adlc/domain";
import {
  AgentDefinitionRepository,
  AgentRunRepository,
  AuditRepository,
  GatewaySessionRepository,
  LeaseRepository,
  NotificationRepository,
  ProjectRepository,
  type AgentRunRow,
  type Db,
} from "@adlc/db";
import { GATEWAY_TOKEN_ENV, RUN_EXIT_CODES, type ExecutorBackend, type RunHandle, type RunLimits } from "@adlc/executor";
import type { Clock } from "@adlc/control-plane";
import type { Logger } from "@adlc/telemetry";
import { z } from "zod";
import { ORCHESTRATOR_ACTOR, retireRun } from "./runs.js";
import { JiraTaskStatus } from "./task-status.js";

export const START_RUN_JOB = "start-run";
/** A review run's gateway session lifetime: enough for one review, then it lapses on its own. */
export const REVIEW_SESSION_MS = 30 * 60_000;

const startReviewPayloadSchema = z.object({
  projectId: z.uuid(),
  taskKey: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  prNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  role: z.string().regex(/^[a-z][a-z0-9-]*$/),
});

export interface LaunchConfig {
  /** Digest-pinned agent image (one runtime image for every role in Phase 0). */
  image: string;
  /** Gateway URL as seen from the agent network. */
  gatewayUrl: string;
  /** Internal Docker network whose only reachable service is the gateway. */
  network: string;
  limits: RunLimits;
  /** Optional run tuning; each set value becomes one fixed ADLC_* variable, nothing else. */
  tuning?: { heartbeatMs?: number | undefined; dummyWorkMs?: number | undefined };
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
  private readonly tasks: JiraTaskStatus | null;

  constructor(
    db: Db,
    private readonly executor: ExecutorBackend,
    private readonly config: LaunchConfig,
    private readonly clock: Clock,
    private readonly logger: Logger,
    /** The adlc-orchestrator Jira identity; without it task statuses are not moved. */
    issues?: IssueTracker,
  ) {
    this.runs = new AgentRunRepository(db);
    this.leases = new LeaseRepository(db);
    this.sessions = new GatewaySessionRepository(db);
    this.definitions = new AgentDefinitionRepository(db);
    this.projects = new ProjectRepository(db);
    this.tasks = issues ? new JiraTaskStatus(issues, new AuditRepository(db)) : null;
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
    if (this.tasks) {
      // Claim in Jira (S0-S2): To Do -> In Progress; a resumed task is already In Progress. Any
      // other status means a human moved the task since it was offered, and the human wins.
      const claim = await this.tasks.move(run.taskKey, "In Progress", `claimed by run ${run.id}`, { projectId: run.projectId, runId });
      if (claim.status !== "In Progress") {
        await this.leases.release({ taskKey: run.taskKey, fencingToken: lease.fencingToken }, `task is ${claim.status} in Jira`, now);
        await retireRun(this.runs, run.id, `task is ${claim.status} in Jira`, now);
        return "stale";
      }
    }
    const [definition, project] = await Promise.all([this.definitions.get(run.agentDefinitionId), this.projects.get(run.projectId)]);
    const token = await this.sessions.issue(
      { runId, role: definition.role, projectId: run.projectId, taskKey: run.taskKey, fencingToken: lease.fencingToken, expiresAt: lease.deadlineAt },
      now,
    );
    const taskKey = run.taskKey;
    return this.startContainer({ runId, projectId: run.projectId, taskKey, role: definition.role, modelId: definition.modelId, repo: project.repos[0] ?? "", token }, {}, () =>
      this.leases.release({ taskKey, fencingToken: lease.fencingToken }, "container failed to start", this.clock.now()).then(() => undefined),
    );
  }

  /**
   * Starts a review run (minimal trigger, ReviewFlow). It holds no task lease, because the author's
   * run did the work. Its gateway session may record a verdict only on this PR head (FR-EVD-002), and
   * it expires on its own.
   */
  async launchReview(payload: unknown): Promise<LaunchOutcome> {
    const p = startReviewPayloadSchema.parse(payload);
    const now = this.clock.now();
    const definition = await this.definitions.latestForRole(p.role);
    if (!definition) {
      this.logger.error({ role: p.role, taskKey: p.taskKey }, "no agent definition registered for the reviewer role");
      return "skipped";
    }
    const run = await this.runs.create({ agentDefinitionId: definition.id, projectId: p.projectId, kind: "review", taskKey: p.taskKey }, ORCHESTRATOR_ACTOR, now);
    const token = await this.sessions.issue(
      {
        runId: run.id,
        role: definition.role,
        projectId: p.projectId,
        taskKey: null,
        fencingToken: null,
        expiresAt: new Date(now.getTime() + REVIEW_SESSION_MS),
        reviewTarget: { repo: p.repo, prNumber: p.prNumber, headSha: p.headSha },
      },
      now,
    );
    return this.startContainer(
      { runId: run.id, projectId: p.projectId, taskKey: p.taskKey, role: definition.role, modelId: definition.modelId, repo: p.repo, token },
      { ADLC_PR_NUMBER: String(p.prNumber), ADLC_HEAD_SHA: p.headSha },
      () => Promise.resolve(),
    );
  }

  /** Creates and starts the hardened container; on any failure cleans up and ends the run. */
  private async startContainer(
    r: { runId: string; projectId: string; taskKey: string; role: string; modelId: string; repo: string; token: string },
    extraEnv: Record<string, string>,
    releaseLease: () => Promise<void>,
  ): Promise<LaunchOutcome> {
    const log = this.logger.child({ projectId: r.projectId, runId: r.runId, taskKey: r.taskKey });
    let handle: RunHandle | null = null;
    try {
      handle = await this.executor.create({
        runId: r.runId,
        image: this.config.image,
        network: this.config.network,
        limits: this.config.limits,
        env: {
          ADLC_GATEWAY_URL: this.config.gatewayUrl,
          [GATEWAY_TOKEN_ENV]: r.token,
          ADLC_RUN_ID: r.runId,
          ADLC_TASK_KEY: r.taskKey,
          ADLC_ROLE: r.role,
          ADLC_REPO: r.repo,
          ADLC_MODEL: r.modelId,
          ...(this.config.tuning?.heartbeatMs === undefined ? {} : { ADLC_HEARTBEAT_MS: String(this.config.tuning.heartbeatMs) }),
          ...(this.config.tuning?.dummyWorkMs === undefined ? {} : { ADLC_DUMMY_WORK_MS: String(this.config.tuning.dummyWorkMs) }),
          ...extraEnv,
        },
      });
      await this.runs.transition(r.runId, "starting", ORCHESTRATOR_ACTOR, "container created", this.clock.now(), { containerId: handle.containerId });
      await this.executor.start(handle);
      await this.runs.transition(r.runId, "running", ORCHESTRATOR_ACTOR, "container started", this.clock.now());
      log.info({ containerId: handle.containerId }, "agent container started");
      return "launched";
    } catch (err) {
      log.error({ err: (err as Error).message }, "agent container failed to start");
      if (handle) await this.executor.delete(handle).catch(() => undefined);
      await this.sessions.revokeRun(r.runId, this.clock.now());
      await releaseLease().catch(() => undefined);
      const current = (await this.runs.get(r.runId))?.state as AgentRunState | undefined;
      const to: AgentRunState = current && agentRunMachine.canTransition(current, "failed") ? "failed" : "stopped";
      if (current && agentRunMachine.canTransition(current, to)) {
        await this.runs.transition(r.runId, to, ORCHESTRATOR_ACTOR, `container failed to start: ${(err as Error).name}`, this.clock.now());
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
 * (P0-WP11). A failed or lost run escalates to a human (AT-P0-02): the Jira task goes to Needs Human
 * and the role owner group is notified (FR-NOT-001).
 */
export class Supervisor {
  private readonly runs: AgentRunRepository;
  private readonly leases: LeaseRepository;
  private readonly sessions: GatewaySessionRepository;
  private readonly definitions: AgentDefinitionRepository;
  private readonly notifications: NotificationRepository;
  private readonly tasks: JiraTaskStatus | null;

  constructor(
    db: Db,
    private readonly executor: ExecutorBackend,
    private readonly clock: Clock,
    private readonly logger: Logger,
    /** The adlc-orchestrator Jira identity; without it task statuses are not moved. */
    issues?: IssueTracker,
  ) {
    this.runs = new AgentRunRepository(db);
    this.leases = new LeaseRepository(db);
    this.sessions = new GatewaySessionRepository(db);
    this.definitions = new AgentDefinitionRepository(db);
    this.notifications = new NotificationRepository(db);
    this.tasks = issues ? new JiraTaskStatus(issues, new AuditRepository(db)) : null;
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
      else await this.escalateToHuman(run, to, reason, now);
      if (to === "succeeded" && run.kind === "task-pipeline") await this.handOverForReview(run);
      ended.push({ runId: run.id, state: to, reason });
    }
    return ended;
  }

  /** The run's pull request is open: the task waits for review (S4 -> In Review). */
  private async handOverForReview(run: AgentRunRow): Promise<void> {
    if (!this.tasks || !run.taskKey) return;
    try {
      await this.tasks.move(run.taskKey, "In Review", `run ${run.id} succeeded`, { projectId: run.projectId, runId: run.id });
    } catch (err) {
      this.logger.warn({ taskKey: run.taskKey, err: (err as Error).message }, "could not move the task to In Review");
    }
  }

  private async escalateToHuman(run: AgentRunRow, state: AgentRunState, reason: string, now: Date): Promise<void> {
    const role = (await this.definitions.get(run.agentDefinitionId)).role;
    const subject = run.taskKey ?? `run ${run.id}`;
    await this.notifications.raise(
      {
        projectId: run.projectId,
        event: "run.needs-human",
        severity: NOTIFICATION_EVENTS["run.needs-human"].severity,
        audience: `role:${role}`,
        title: `${subject} needs a human: the ${role} run ${state}`,
        body: `Run ${run.id} (${role}) for ${subject} ended ${state}: ${reason}.`,
        link: `/runs/${run.id}`,
        // Repeated failures of the same task merge until someone acknowledges.
        dedupeKey: `run.needs-human:${run.taskKey ?? run.id}`,
      },
      now,
    );
    if (!this.tasks || !run.taskKey) return;
    try {
      await this.tasks.move(run.taskKey, "Needs Human", `run ${run.id} ${state}`, { projectId: run.projectId, runId: run.id });
    } catch (err) {
      this.logger.warn({ taskKey: run.taskKey, err: (err as Error).message }, "could not move the task to Needs Human; the notification was raised");
    }
  }
}
