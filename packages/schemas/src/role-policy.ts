import { z } from "zod";

/**
 * Per-role tool policy (SDD §11.2), `agents/<role>/policy.yaml`, enforced by the gateway (C4).
 * The schema cannot express platform-forbidden rights (hard rule 3): no Done transition, no Gate
 * issues, branches only under `task/` or `spec/`, and only agent-answerable Decision classes.
 * The gateway re-checks the same invariants in code (ADR-0010).
 */

const glob = z.string().regex(/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._*/{}-]+$/, "expected a repo-relative glob");

/** Decision classes an agent may answer; gate, risk and requirement Decisions are human-only. */
export const AGENT_ANSWERABLE_DECISION_CLASSES = ["clarification", "consult", "escalation"] as const;

export const FORBIDDEN_ISSUE_TYPES = ["Gate"] as const;
export const FORBIDDEN_TARGET_STATUSES = ["Done"] as const;

export const rolePolicySchema = z
  .strictObject({
    role: z.string().regex(/^[a-z][a-z0-9-]*$/),
    /** `<server>.<tool>` names this role may call; anything else is denied. */
    tools: z.array(z.string().regex(/^[a-z]+\.[a-z_]+$/)).min(1),
    jira: z
      .strictObject({
        createIssueTypes: z.array(z.string().min(1)).default([]),
        /** Transitions allowed on the run's own task issue only. */
        transitions: z.array(z.strictObject({ from: z.string().min(1), to: z.string().min(1) })).default([]),
      })
      .prefault({}),
    github: z
      .strictObject({
        /** Writable branches; `{taskKey}` is replaced by the run's leased task key. */
        branches: z.array(z.string().regex(/^(task|spec)\/[A-Za-z0-9{}._-]+$/, "agents may only write task/* or spec/* branches")).default([]),
        writePaths: z.array(glob).default([]),
        blockedPaths: z.array(glob).default([]),
      })
      .prefault({}),
    decisions: z.strictObject({ answerClasses: z.array(z.enum(AGENT_ANSWERABLE_DECISION_CLASSES)).default([]) }).prefault({}),
  })
  .superRefine((p, ctx) => {
    p.jira.createIssueTypes.forEach((t, i) => {
      if ((FORBIDDEN_ISSUE_TYPES as readonly string[]).includes(t)) {
        ctx.addIssue({ code: "custom", path: ["jira", "createIssueTypes", i], message: `agents may never create ${t} issues` });
      }
    });
    p.jira.transitions.forEach((t, i) => {
      if ((FORBIDDEN_TARGET_STATUSES as readonly string[]).includes(t.to)) {
        ctx.addIssue({ code: "custom", path: ["jira", "transitions", i, "to"], message: `only adlc-orchestrator may set ${t.to}` });
      }
    });
  });
export type RolePolicy = z.infer<typeof rolePolicySchema>;
