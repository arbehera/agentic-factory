import { DECISION_CLASSES, DECISION_ROUTES, DECISION_STATUSES } from "@adlc/domain";
import { AGENT_ANSWERABLE_DECISION_CLASSES, decisionInputSchema } from "@adlc/schemas";
import { z } from "zod";
import { defineTool, deny, type ToolContext, type ToolDef } from "./tool.js";

/**
 * `decisions` MCP server (SDD §11.1). Agents may raise Decisions and answer only the classes
 * their role allows; gate, risk and requirement Decisions are human-only (hard rule 2), and an
 * agent can never mark its own Decision as auto-resolving.
 */

const decisionId = z.string().regex(/^DEC-\d{4,}$/);

function sameProject(ctx: ToolContext, projectId: string): void {
  if (projectId !== ctx.run.projectId) deny("Decision belongs to another project");
}

export const decisionTools: ToolDef[] = [
  defineTool({
    server: "decisions",
    name: "raise",
    description: "Raise a Decision (question, consult, escalation or risk) for a human or agent owner.",
    input: z.strictObject({
      class: z.enum(DECISION_CLASSES),
      route: z.enum(DECISION_ROUTES),
      question: z.string().min(1).max(8000),
      options: z.array(z.string().min(1).max(2000)).max(20).default([]),
      owner: z.string().min(1).max(200),
      timeboxMinutes: z.number().int().positive().max(60 * 24 * 30),
      reversible: z.boolean(),
    }),
    taskWrite: true,
    handle: (ctx, a, d) => {
      const input = decisionInputSchema.parse({
        ...a,
        autoResolve: false,
        projectId: ctx.run.projectId,
        ...(ctx.run.taskKey ? { taskKey: ctx.run.taskKey } : {}),
      });
      return d.decisions.raise(input, { kind: "agent-run", id: ctx.run.runId }, ctx.now);
    },
  }),
  defineTool({
    server: "decisions",
    name: "read",
    description: "Read a Decision of this project.",
    input: z.strictObject({ id: decisionId }),
    taskWrite: false,
    handle: async (ctx, a, d) => {
      const row = await d.decisions.get(a.id);
      sameProject(ctx, row.projectId);
      return row;
    },
  }),
  defineTool({
    server: "decisions",
    name: "list",
    description: "List recent Decisions of this project, optionally by status.",
    input: z.strictObject({ status: z.enum(DECISION_STATUSES).optional() }),
    taskWrite: false,
    handle: (ctx, a, d) => d.decisions.list(ctx.run.projectId, a.status),
  }),
  defineTool({
    server: "decisions",
    name: "answer",
    description: "Answer a Decision your role owns (never gate, risk or requirement Decisions).",
    input: z.strictObject({ id: decisionId, outcome: z.string().min(1).max(8000) }),
    taskWrite: true,
    handle: async (ctx, a, d) => {
      const row = await d.decisions.get(a.id);
      sameProject(ctx, row.projectId);
      if (!(AGENT_ANSWERABLE_DECISION_CLASSES as readonly string[]).includes(row.class)) deny(`${row.class} Decisions are answered by humans only`);
      if (row.route === "human") deny(`${row.id} is routed to a human`);
      if (row.owner !== ctx.policy.role) deny(`${row.id} is owned by ${row.owner}, not role ${ctx.policy.role}`);
      if (row.raisedBy === `agent-run:${ctx.run.runId}`) deny("a run may not answer its own Decision");
      if (!(ctx.policy.decisions.answerClasses as readonly string[]).includes(row.class)) deny(`role ${ctx.policy.role} may not answer ${row.class} Decisions`);
      return d.decisions.answer(a.id, a.outcome, { kind: "agent-run", id: ctx.run.runId }, ctx.now);
    },
  }),
];
