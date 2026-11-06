import type { IssueTracker, SourceControl } from "@adlc/adapters";
import type { DecisionRepository, EvidenceRepository, GatewaySessionContext, ModelCallRepository } from "@adlc/db";
import type { RolePolicy } from "@adlc/schemas";
import type { z } from "zod";

/** Who is calling: the run behind the gateway session, with its role policy (SDD §11.2). */
export interface ToolContext {
  run: GatewaySessionContext;
  policy: RolePolicy;
  now: Date;
}

/**
 * What a tool may use. Adapters are built by the gateway with credentials the tool never sees
 * (hard rule 9). `decisions` is bound to the fenced transaction for task-scoped writes.
 */
export interface ToolDeps {
  jira: IssueTracker;
  github: SourceControl;
  decisions: DecisionRepository;
  evidence: EvidenceRepository;
  modelCalls: ModelCallRepository;
}

export interface ToolDef<A = unknown> {
  server: string;
  name: string;
  description: string;
  input: z.ZodType<A>;
  /** Task-scoped write: runs inside the lease fence when the session holds a task (hard rule 5). */
  taskWrite: boolean;
  handle(ctx: ToolContext, args: A, deps: ToolDeps): Promise<unknown>;
}

/** A request the policy does not allow. The message is safe to return to the agent. */
export class PolicyDeniedError extends Error {
  override name = "PolicyDeniedError";
}

export function deny(reason: string): never {
  throw new PolicyDeniedError(reason);
}

export const toolId = (t: Pick<ToolDef, "server" | "name">): string => `${t.server}.${t.name}`;

/** Helper that keeps the handler's argument type tied to its schema. */
export function defineTool<S extends z.ZodType>(def: Omit<ToolDef<z.output<S>>, "input"> & { input: S }): ToolDef {
  return def as unknown as ToolDef;
}
