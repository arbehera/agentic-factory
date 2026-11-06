import { FORBIDDEN_ISSUE_TYPES, FORBIDDEN_TARGET_STATUSES } from "@adlc/schemas";
import { z } from "zod";
import { assertOwnTask, assertProjectIssue } from "./policy.js";
import { defineTool, deny, type ToolDef } from "./tool.js";

/** `jira` MCP server (SDD §11.1) over the `adlc-agent` identity. No gate or Done operations exist. */

const issueKey = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
const isForbiddenType = (t: string) => (FORBIDDEN_ISSUE_TYPES as readonly string[]).includes(t);
const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export const jiraTools: ToolDef[] = [
  defineTool({
    server: "jira",
    name: "search_issues",
    description: "Search issues in this project by status, type or text.",
    input: z.strictObject({
      status: z.string().min(1).max(100).optional(),
      type: z.string().min(1).max(100).optional(),
      text: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    taskWrite: false,
    // Structured filters, never raw JQL: the query is always scoped to the run's project.
    handle: (ctx, a, d) => {
      const clauses = [`project = ${ctx.run.jiraProjectKey}`];
      if (a.status) clauses.push(`status = ${quote(a.status)}`);
      if (a.type) clauses.push(`issuetype = ${quote(a.type)}`);
      if (a.text) clauses.push(`text ~ ${quote(a.text)}`);
      return d.jira.search(clauses.join(" AND "), a.limit);
    },
  }),
  defineTool({
    server: "jira",
    name: "read_issue",
    description: "Read one issue of this project.",
    input: z.strictObject({ key: issueKey }),
    taskWrite: false,
    handle: (ctx, a, d) => {
      assertProjectIssue(ctx, a.key);
      return d.jira.getIssue(a.key);
    },
  }),
  defineTool({
    server: "jira",
    name: "create_issue",
    description: "Create an issue of a type your role may create (e.g. Bug, Risk).",
    input: z.strictObject({ type: z.string().min(1).max(50), summary: z.string().min(1).max(255), description: z.string().max(30_000) }),
    taskWrite: true,
    handle: (ctx, a, d) => {
      if (isForbiddenType(a.type)) deny(`agents may never create ${a.type} issues`);
      if (!ctx.policy.jira.createIssueTypes.includes(a.type)) deny(`role ${ctx.policy.role} may not create ${a.type} issues`);
      return d.jira.createIssue({ projectKey: ctx.run.jiraProjectKey, type: a.type, summary: a.summary, description: a.description });
    },
  }),
  defineTool({
    server: "jira",
    name: "comment",
    description: "Comment on an issue of this project.",
    input: z.strictObject({ key: issueKey, body: z.string().min(1).max(30_000) }),
    taskWrite: true,
    handle: async (ctx, a, d) => {
      assertProjectIssue(ctx, a.key);
      if (isForbiddenType((await d.jira.getIssue(a.key)).type)) deny("agents may not comment on Gate issues");
      return d.jira.addComment(a.key, a.body);
    },
  }),
  defineTool({
    server: "jira",
    name: "transition",
    description: "Move your own task to another status allowed for your role (never Done).",
    input: z.strictObject({ key: issueKey, to: z.string().min(1).max(100) }),
    taskWrite: true,
    handle: async (ctx, a, d) => {
      assertOwnTask(ctx, a.key);
      if ((FORBIDDEN_TARGET_STATUSES as readonly string[]).includes(a.to)) deny(`only adlc-orchestrator may set ${a.to}`);
      // Re-read before every write (hard rule 4); the version guards against a concurrent human edit.
      const issue = await d.jira.getIssue(a.key);
      if (isForbiddenType(issue.type)) deny("agents may never transition Gate issues");
      if (!ctx.policy.jira.transitions.some((t) => t.from === issue.status && t.to === a.to)) {
        deny(`role ${ctx.policy.role} may not move ${a.key} from ${issue.status} to ${a.to}`);
      }
      return d.jira.transition(a.key, a.to, issue.version);
    },
  }),
  defineTool({
    server: "jira",
    name: "link",
    description: "Link two issues of this project.",
    input: z.strictObject({ from: issueKey, to: issueKey, type: z.string().min(1).max(50) }),
    taskWrite: true,
    handle: async (ctx, a, d) => {
      assertProjectIssue(ctx, a.from);
      assertProjectIssue(ctx, a.to);
      const [from, to] = await Promise.all([d.jira.getIssue(a.from), d.jira.getIssue(a.to)]);
      if (isForbiddenType(from.type) || isForbiddenType(to.type)) deny("agents may not link Gate issues");
      await d.jira.link(a.from, a.to, a.type);
      return { linked: true };
    },
  }),
];
