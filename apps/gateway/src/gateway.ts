import { redactSecrets, type IssueTracker, type SecretProvider, type SourceControl } from "@adlc/adapters";
import { stateHash } from "@adlc/domain";
import {
  AuditRepository,
  DecisionRepository,
  GatewaySessionRepository,
  LeaseRepository,
  type Db,
  type DbExecutor,
  type GatewaySessionContext,
} from "@adlc/db";
import { toolId, type ToolContext, type ToolDef } from "@adlc/mcp-servers";
import type { RolePolicy } from "@adlc/schemas";
import type { HeartbeatReply, HeartbeatService } from "@adlc/control-plane";
import type { Logger } from "@adlc/telemetry";
import { ZodError } from "zod";

export interface Clock {
  now(): Date;
}

export class UnknownToolError extends Error {
  override name = "UnknownToolError";
}
export class ToolNotPermittedError extends Error {
  override name = "ToolNotPermittedError";
}
export class InvalidArgumentsError extends Error {
  override name = "InvalidArgumentsError";
}
export class GatewayConfigError extends Error {
  override name = "GatewayConfigError";
}

export interface GatewayDeps {
  db: Db;
  tools: readonly ToolDef[];
  policies: ReadonlyMap<string, RolePolicy>;
  /** Built with credentials from `secrets`; tools only ever receive these instances (hard rule 9). */
  adapters: { jira: IssueTracker; github: SourceControl };
  secrets: SecretProvider;
  /** Lease renewal, usage and stop directives (FR-ORC-008, 011, 012). */
  heartbeats: HeartbeatService;
  clock: Clock;
  logger: Logger;
}

/** JSON-safe copy of a tool result (dates → ISO strings, bigints → strings). */
function toJson(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as unknown;
}

/**
 * Tool gateway (C4, spec.md §7, SDD §11). Every call:
 *  1. authenticates the run's session token;
 *  2. checks that the role may call the tool, and validates arguments (CLAUDE.md §6);
 *  3. runs task-scoped writes inside the lease fence (hard rule 5);
 *  4. redacts any secret value from the result (hard rule 9);
 *  5. audits the call — allowed or denied — with arguments and result hashes (hard rule 11).
 */
export class Gateway {
  private readonly tools = new Map<string, ToolDef>();
  private readonly sessions: GatewaySessionRepository;
  private readonly leases: LeaseRepository;

  constructor(private readonly deps: GatewayDeps) {
    for (const t of deps.tools) this.tools.set(toolId(t), t);
    for (const p of deps.policies.values()) {
      const unknown = p.tools.filter((t) => !this.tools.has(t));
      if (unknown.length > 0) throw new GatewayConfigError(`policy ${p.role} names unknown tools: ${unknown.join(", ")}`);
    }
    this.sessions = new GatewaySessionRepository(deps.db);
    this.leases = new LeaseRepository(deps.db);
  }

  /** Resolves a bearer token; throws InvalidSessionError for anything not live. */
  authenticate(token: string): Promise<GatewaySessionContext> {
    return this.sessions.resolve(token, this.deps.clock.now());
  }

  /**
   * Agent heartbeat. The fencing token comes from the session, never from the request, so a run can
   * only renew its own lease. Stale or expired leases throw: the agent must stop.
   */
  async heartbeat(run: GatewaySessionContext, usage: { tokens: number; costUsd: number }): Promise<HeartbeatReply> {
    if (run.taskKey === null || run.fencingToken === null) throw new InvalidArgumentsError("this session holds no task lease");
    return this.deps.heartbeats.beat({ runId: run.runId, projectId: run.projectId, taskKey: run.taskKey, fencingToken: run.fencingToken, usage });
  }

  /** Tools of `server` this session's role may call (what the agent sees in tools/list). */
  listTools(run: GatewaySessionContext, server: string): ToolDef[] {
    const policy = this.deps.policies.get(run.role);
    return [...this.tools.values()].filter((t) => t.server === server && (policy?.tools.includes(toolId(t)) ?? false));
  }

  async call(run: GatewaySessionContext, server: string, name: string, rawArgs: unknown): Promise<unknown> {
    const id = `${server}.${name}`;
    const now = this.deps.clock.now();
    const audit = (db: DbExecutor, outcome: string, result: unknown) =>
      new AuditRepository(db).append({
        actor: { kind: "agent-run", id: run.runId },
        action: `tool.${id}`,
        target: run.taskKey ? `task:${run.taskKey}` : `project:${run.projectId}`,
        reason: outcome,
        beforeHash: stateHash(toJson(rawArgs) ?? null),
        afterHash: result === undefined ? null : stateHash(result),
        correlation: { projectId: run.projectId, runId: run.runId, ...(run.taskKey ? { taskKey: run.taskKey } : {}) },
      });

    try {
      const tool = this.tools.get(id);
      if (!tool) throw new UnknownToolError(`unknown tool ${id}`);
      const policy = this.deps.policies.get(run.role);
      if (!policy?.tools.includes(id)) throw new ToolNotPermittedError(`role ${run.role} may not call ${id}`);
      const parsed = tool.input.safeParse(rawArgs);
      if (!parsed.success) throw new InvalidArgumentsError(parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; "));
      const ctx: ToolContext = { run, policy, now };

      const invoke = async (db: DbExecutor) => {
        const raw = await tool.handle(ctx, parsed.data, { ...this.deps.adapters, decisions: new DecisionRepository(db) });
        const result = redactSecrets(toJson(raw), this.deps.secrets.knownValues());
        await audit(db, "allowed", result);
        return result;
      };
      if (tool.taskWrite && run.taskKey !== null && run.fencingToken !== null) {
        // The fence holds until the audit row commits; a stale token never writes (FR-ORC-008).
        return await this.leases.withFence({ taskKey: run.taskKey, fencingToken: run.fencingToken }, now, invoke);
      }
      return await invoke(this.deps.db);
    } catch (err) {
      const reason = err instanceof ZodError ? `invalid arguments: ${err.message}` : `${(err as Error).name}: ${(err as Error).message}`;
      await audit(this.deps.db, `denied: ${redactSecrets(reason, this.deps.secrets.knownValues())}`, undefined).catch((auditErr: unknown) => {
        this.deps.logger.error({ runId: run.runId, tool: id, err: (auditErr as Error).message }, "audit of failed tool call failed");
      });
      this.deps.logger.warn({ runId: run.runId, taskKey: run.taskKey, tool: id, err: (err as Error).name }, "tool call refused or failed");
      throw err;
    }
  }
}
