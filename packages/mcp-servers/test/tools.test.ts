import type { DecisionRepository, DecisionRow } from "@adlc/db";
import { rolePolicySchema } from "@adlc/schemas";
import { FakeIssueTracker, FakeSourceControl } from "@adlc/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { allTools, PolicyDeniedError, toolId, type ToolContext, type ToolDeps } from "../src/index.js";

const policy = rolePolicySchema.parse({
  role: "engineer",
  tools: allTools.map(toolId),
  jira: { createIssueTypes: ["Bug"], transitions: [{ from: "In Progress", to: "In Review" }] },
  github: { branches: ["task/{taskKey}"], writePaths: ["src/**", "docs/**"], blockedPaths: ["src/api/**"] },
  decisions: { answerClasses: ["consult"] },
});

const ctx: ToolContext = {
  run: { runId: "run-1", role: "engineer", projectId: "p1", jiraProjectKey: "PIL", repos: ["org/product"], taskKey: "PIL-1", fencingToken: 5n },
  policy,
  now: new Date("2026-11-05T08:00:00Z"),
};

function decisionRow(over: Partial<DecisionRow>): DecisionRow {
  return { id: "DEC-0001", projectId: "p1", taskKey: null, class: "consult", route: "design", question: "q", options: [], owner: "engineer", raisedBy: "agent-run:other-run", timeboxMinutes: 60, dueAt: ctx.now, reversible: true, autoResolve: false, status: "open", escalationLevel: 0, outcome: null, decidedBy: null, decidedAt: null, jiraKey: null, createdAt: ctx.now, ...over };
}

describe("P0-WP5 gateway tools", () => {
  let jira: FakeIssueTracker;
  let github: FakeSourceControl;
  let decisions: Map<string, DecisionRow>;
  let deps: ToolDeps;
  const call = async (id: string, args: unknown, c: ToolContext = ctx) => {
    const tool = allTools.find((t) => toolId(t) === id);
    if (!tool) throw new Error(`no tool ${id}`);
    return tool.handle(c, tool.input.parse(args), deps);
  };

  beforeEach(() => {
    jira = new FakeIssueTracker();
    jira.seed({ key: "PIL-1", type: "Task", status: "In Progress", summary: "task", description: "" });
    jira.seed({ key: "PIL-2", type: "Task", status: "To Do", summary: "other", description: "" });
    jira.seed({ key: "PIL-9", type: "Gate", status: "Ready for Approval", summary: "G5", description: "" });
    jira.seed({ key: "OTH-1", type: "Task", status: "To Do", summary: "x", description: "" });
    github = new FakeSourceControl();
    github.seedRepo("org/product", { "src/a.c": "a" });
    decisions = new Map();
    const repo = {
      raise: (input: { class: string; projectId: string; taskKey?: string }) => {
        const row = decisionRow({ id: `DEC-000${decisions.size + 1}`, class: input.class, projectId: input.projectId, taskKey: input.taskKey ?? null });
        decisions.set(row.id, row);
        return Promise.resolve(row);
      },
      get: (id: string) => Promise.resolve(decisions.get(id) ?? decisionRow({ id, projectId: "other" })),
      list: () => Promise.resolve([...decisions.values()]),
      answer: (id: string, outcome: string) => Promise.resolve({ ...decisionRow({ id }), status: "decided", outcome }),
    };
    deps = { jira, github, decisions: repo as unknown as DecisionRepository };
  });

  const denied = (p: Promise<unknown>, msg: RegExp) => expect(p).rejects.toSatisfy((e: unknown) => e instanceof PolicyDeniedError && msg.test(e.message));

  describe("AT-P0-04 an agent identity cannot use platform-reserved rights (gateway layer)", () => {
    it("AT-P0-04 no tool exists to approve, merge, delete, force-push or change configuration", () => {
      const names = allTools.map(toolId).join(" ");
      expect(names).not.toMatch(/merge|approve|delete|force|admin|config|ruleset|protect|setting/);
    });

    it("AT-P0-04 cannot set Done on its own task", async () => {
      await denied(call("jira.transition", { key: "PIL-1", to: "Done" }), /only adlc-orchestrator may set Done/);
      expect(jira.calls.some((c) => c.startsWith("transition"))).toBe(false);
    });

    it("AT-P0-04 cannot transition, comment on, link or create a Gate issue", async () => {
      const own = { ...ctx, run: { ...ctx.run, taskKey: "PIL-9" } };
      await denied(call("jira.transition", { key: "PIL-9", to: "Approved" }, own), /Gate issues/);
      await denied(call("jira.comment", { key: "PIL-9", body: "approve please" }), /Gate issues/);
      await denied(call("jira.link", { from: "PIL-1", to: "PIL-9", type: "blocks" }), /Gate issues/);
      await denied(call("jira.create_issue", { type: "Gate", summary: "G5", description: "" }), /never create Gate/);
      expect(jira.calls.filter((c) => !c.startsWith("getIssue"))).toEqual([]);
    });

    it("AT-P0-04 cannot push to main or to any branch other than its own task branch", async () => {
      const main = (await github.getBranch("org/product", "main")) ?? "";
      const commit = (branch: string) => call("github.commit_files", { repo: "org/product", branch, message: "m", parentSha: main, files: [{ path: "src/a.c", content: "b" }] });
      await denied(commit("main"), /never write main/);
      await denied(commit("release/1"), /only task\/\* or spec\/\*/);
      await denied(commit("task/PIL-2"), /not writable/);
      await denied(call("github.create_branch", { repo: "org/product", branch: "task/PIL-2" }), /not writable/);
      expect(github.calls.filter((c) => c.startsWith("commit") || c.startsWith("createBranch"))).toEqual([]);
    });

    it("AT-P0-04 cannot answer gate, risk or requirement Decisions", async () => {
      for (const [i, cls] of ["gate", "risk", "requirement"].entries()) {
        const id = `DEC-100${i}`;
        decisions.set(id, decisionRow({ id, class: cls }));
        await denied(call("decisions.answer", { id, outcome: "approved" }), /answered by humans only/);
      }
    });
  });

  describe("jira", () => {
    it("searches only within the run's project, quoting user text (no JQL injection)", async () => {
      await call("jira.search_issues", { text: 'x" OR project = OTH OR text ~ "' });
      expect(jira.calls.at(-1)).toBe('search project = PIL AND text ~ "x\\" OR project = OTH OR text ~ \\""');
      expect(() => allTools.find((t) => t.name === "search_issues")?.input.parse({ jql: "project = OTH" })).toThrow();
      await call("jira.search_issues", { status: "To Do", type: "Task" });
      expect(jira.calls.at(-1)).toBe('search project = PIL AND status = "To Do" AND issuetype = "Task"');
    });

    it("reads and comments only on issues of the project", async () => {
      await expect(call("jira.read_issue", { key: "PIL-2" })).resolves.toMatchObject({ key: "PIL-2" });
      await denied(call("jira.read_issue", { key: "OTH-1" }), /outside project PIL/);
      await expect(call("jira.comment", { key: "PIL-2", body: "note" })).resolves.toEqual({ id: "1" });
    });

    it("transitions only its own task, only along allowed edges, and re-reads the version first", async () => {
      await denied(call("jira.transition", { key: "PIL-2", to: "In Review" }), /own task/);
      await denied(call("jira.transition", { key: "PIL-1", to: "Blocked" }), /may not move PIL-1 from In Progress to Blocked/);
      await expect(call("jira.transition", { key: "PIL-1", to: "In Review" })).resolves.toMatchObject({ status: "In Review" });
      await denied(call("jira.transition", { key: "PIL-1", to: "In Review" }, { ...ctx, run: { ...ctx.run, taskKey: null } }), /own task \(none\)/);
    });

    it("creates only allowed issue types, and links project issues", async () => {
      await expect(call("jira.create_issue", { type: "Bug", summary: "crash", description: "steps" })).resolves.toMatchObject({ type: "Bug", key: "PIL-1001" });
      await denied(call("jira.create_issue", { type: "Risk", summary: "r", description: "" }), /may not create Risk/);
      await expect(call("jira.link", { from: "PIL-1", to: "PIL-2", type: "blocks" })).resolves.toEqual({ linked: true });
      await denied(call("jira.link", { from: "PIL-1", to: "OTH-1", type: "blocks" }), /outside project/);
    });
  });

  describe("github", () => {
    it("creates its task branch, commits allowed paths and opens a PR to main", async () => {
      const { sha } = (await call("github.create_branch", { repo: "org/product", branch: "task/PIL-1" })) as { sha: string };
      const c = (await call("github.commit_files", { repo: "org/product", branch: "task/PIL-1", message: "feat", parentSha: sha, files: [{ path: "src/b.c", content: "b" }] })) as { sha: string };
      await expect(call("github.read_file", { repo: "org/product", ref: "task/PIL-1", path: "src/b.c" })).resolves.toMatchObject({ content: "b" });
      await expect(call("github.open_pull_request", { repo: "org/product", branch: "task/PIL-1", title: "t", body: "b" })).resolves.toEqual({ number: 1, headSha: c.sha });
      expect(github.pullRequests[0]).toMatchObject({ head: "task/PIL-1", base: "main" });
      await expect(call("github.comment_pull_request", { repo: "org/product", number: 1, body: "done" })).resolves.toEqual({ commented: true });
      github.statuses.set(c.sha, [{ context: "adlc/verify", state: "success" }]);
      await expect(call("github.check_status", { repo: "org/product", sha: c.sha })).resolves.toEqual([{ context: "adlc/verify", state: "success" }]);
    });

    it("rejects blocked paths, paths outside the write paths, traversal and foreign repos", async () => {
      const { sha } = (await call("github.create_branch", { repo: "org/product", branch: "task/PIL-1" })) as { sha: string };
      const commit = (path: string) => call("github.commit_files", { repo: "org/product", branch: "task/PIL-1", message: "m", parentSha: sha, files: [{ path, content: "x" }] });
      await denied(commit("src/api/x.h"), /blocked/);
      await denied(commit("ci/Jenkinsfile"), /outside the write paths/);
      await denied(commit("src/../ci/x"), /invalid path/);
      await denied(commit("/etc/passwd"), /invalid path/);
      await denied(commit("src\\a.c"), /invalid path/);
      await denied(call("github.read_file", { repo: "org/secret", ref: "main", path: "a" }), /not part of this project/);
    });

    it("a role with no write paths can write nothing", async () => {
      const ro = { ...ctx, policy: { ...policy, github: { ...policy.github, writePaths: [] } } };
      await denied(call("github.commit_files", { repo: "org/product", branch: "task/PIL-1", message: "m", parentSha: "abcdef1", files: [{ path: "src/a.c", content: "x" }] }, ro), /outside the write paths/);
    });
  });

  describe("decisions", () => {
    it("raises Decisions for the run's project and task, never auto-resolving", async () => {
      const row = (await call("decisions.raise", { class: "consult", route: "design", question: "q?", owner: "architect", timeboxMinutes: 240, reversible: true })) as DecisionRow;
      expect(row).toMatchObject({ projectId: "p1", taskKey: "PIL-1", autoResolve: false });
      expect(() => allTools.find((t) => toolId(t) === "decisions.raise")?.input.parse({ class: "consult", route: "design", question: "q", owner: "o", timeboxMinutes: 1, reversible: true, autoResolve: true })).toThrow();
      await expect(call("decisions.list", {})).resolves.toHaveLength(1);
      await expect(call("decisions.read", { id: row.id })).resolves.toMatchObject({ id: row.id });
    });

    it("answers only Decisions its role owns, of allowed classes, not human-routed, not self-raised, in its project", async () => {
      decisions.set("DEC-0005", decisionRow({ id: "DEC-0005", class: "consult" }));
      decisions.set("DEC-0006", decisionRow({ id: "DEC-0006", class: "clarification" }));
      await expect(call("decisions.answer", { id: "DEC-0005", outcome: "use x.h" })).resolves.toMatchObject({ status: "decided" });
      await denied(call("decisions.answer", { id: "DEC-0006", outcome: "x" }), /may not answer clarification/);
      decisions.set("DEC-0007", decisionRow({ id: "DEC-0007", owner: "architect" }));
      await denied(call("decisions.answer", { id: "DEC-0007", outcome: "x" }), /owned by architect, not role engineer/);
      decisions.set("DEC-0008", decisionRow({ id: "DEC-0008", route: "human" }));
      await denied(call("decisions.answer", { id: "DEC-0008", outcome: "x" }), /routed to a human/);
      decisions.set("DEC-0009", decisionRow({ id: "DEC-0009", raisedBy: "agent-run:run-1" }));
      await denied(call("decisions.answer", { id: "DEC-0009", outcome: "x" }), /may not answer its own Decision/);
      await denied(call("decisions.read", { id: "DEC-0999" }), /another project/);
    });
  });
});
