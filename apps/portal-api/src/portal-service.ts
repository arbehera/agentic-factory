import { KillSwitch, type Clock } from "@adlc/control-plane";
import type { Actor } from "@adlc/domain";
import { AgentRunRepository, AuditRepository, ControlFlagRepository, LeaseRepository, NotificationRepository, type Db } from "@adlc/db";
import type { LogLine } from "@adlc/executor/contract";
import { ForbiddenError, PortalAuth, type Principal, type PortalRole } from "./auth.js";

/** Live logs of a run's container; provided where the executor runs (P0-WP11 decides topology). */
export interface RunLogSource {
  follow(runId: string, containerId: string): AsyncIterable<LogLine>;
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
}
export class InvalidRequestError extends Error {
  override name = "InvalidRequestError";
}

const READ: readonly PortalRole[] = ["viewer", "operator", "role-owner", "pack-owner", "lead", "platform-admin", "auditor"];
const OPERATE: readonly PortalRole[] = ["operator", "role-owner", "lead", "platform-admin"];
/** SDD §16.2: the global kill switch is for the platform admin and the Program Lead. */
const KILL_SWITCH: readonly PortalRole[] = ["platform-admin", "lead"];

const human = (p: Principal): Actor => ({ kind: "human", id: p.id });

function reasonOf(body: unknown): string {
  const r = (body as { reason?: unknown } | null)?.reason;
  if (typeof r !== "string" || r.trim().length < 3 || r.length > 2000) throw new InvalidRequestError("a reason (3–2000 characters) is required for every control");
  return r.trim();
}

/**
 * Agent Operations Portal backend (C9, FR-POR-001 partial, FR-POR-002 kill switch). Reads come
 * from the orchestrator's store; every control checks the user's role, needs a reason and is
 * audited with the human as the actor. There is deliberately no way to approve a gate, merge,
 * or edit packs or configuration here (FR-POR-004).
 */
export class PortalService {
  private readonly runs: AgentRunRepository;
  private readonly audit: AuditRepository;
  private readonly leases: LeaseRepository;
  private readonly notifications: NotificationRepository;
  private readonly killSwitch: KillSwitch;

  constructor(
    db: Db,
    private readonly logs: RunLogSource | null,
    private readonly clock: Clock,
  ) {
    this.runs = new AgentRunRepository(db);
    this.audit = new AuditRepository(db);
    this.leases = new LeaseRepository(db);
    this.notifications = new NotificationRepository(db);
    this.killSwitch = new KillSwitch(new ControlFlagRepository(db), clock);
  }

  async fleet(p: Principal) {
    PortalAuth.require(p, READ);
    const now = this.clock.now();
    const rows = await this.runs.listForFleet(new Date(now.getTime() - 24 * 3_600_000));
    return rows.map((r) => ({ ...r, heartbeatAgeSeconds: r.heartbeatAt ? Math.round((now.getTime() - r.heartbeatAt.getTime()) / 1000) : null }));
  }

  async runDetail(p: Principal, runId: string) {
    PortalAuth.require(p, READ);
    const run = await this.runs.get(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);
    const lease = run.taskKey ? await this.leases.get(run.taskKey) : null;
    return {
      run,
      steps: await this.runs.steps(runId),
      lease: lease && lease.runId === runId ? { expiresAt: lease.expiresAt, deadlineAt: lease.deadlineAt, fencingToken: lease.fencingToken.toString() } : null,
      timeline: (await this.audit.forRun(runId)).map((e) => ({ seq: e.seq, ts: e.ts, actor: e.actor, action: e.action, reason: e.reason })),
    };
  }

  /** Live log stream (operators and above; logs can contain task detail). */
  async liveLogs(p: Principal, runId: string): Promise<AsyncIterable<LogLine>> {
    PortalAuth.require(p, OPERATE);
    const run = await this.runs.get(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);
    if (!run.containerId) throw new NotFoundError(`run ${runId} has no container yet`);
    if (!this.logs) throw new NotFoundError("live logs are not available on this portal instance");
    return this.logs.follow(runId, run.containerId);
  }

  async inbox(p: Principal) {
    PortalAuth.require(p, READ);
    if (!p.email) return [];
    return this.notifications.inbox(p.email);
  }

  /** Recipients acknowledge their own items; operators may acknowledge any. */
  async acknowledge(p: Principal, notificationId: string) {
    PortalAuth.require(p, READ);
    const n = await this.notifications.get(notificationId).catch(() => null);
    if (!n) throw new NotFoundError(`notification ${notificationId} not found`);
    const addressed = p.email !== null && n.recipients.includes(p.email);
    if (!addressed && !p.roles.some((r) => OPERATE.includes(r))) throw new ForbiddenError("only a recipient or an operator may acknowledge this item");
    return this.notifications.acknowledge(notificationId, human(p), this.clock.now());
  }

  async killSwitchState(p: Principal): Promise<{ engaged: boolean }> {
    PortalAuth.require(p, READ);
    return { engaged: await this.killSwitch.isEngaged() };
  }

  async engageKillSwitch(p: Principal, body: unknown): Promise<{ engaged: true }> {
    PortalAuth.require(p, KILL_SWITCH);
    await this.killSwitch.engage(human(p), reasonOf(body));
    return { engaged: true };
  }

  async releaseKillSwitch(p: Principal, body: unknown): Promise<{ engaged: false }> {
    PortalAuth.require(p, KILL_SWITCH);
    await this.killSwitch.release(human(p), reasonOf(body));
    return { engaged: false };
  }
}
