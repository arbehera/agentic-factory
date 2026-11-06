import { leaseDeadline, LEASE_TTL_MS } from "@adlc/domain";
import { AgentRunRepository, AuditRepository, InvalidSessionError, LeaseRepository, StaleFencingTokenError } from "@adlc/db";
import { allTools, PolicyDeniedError } from "@adlc/mcp-servers";
import { ConfigValidationError } from "@adlc/pack-sdk";
import { rolePolicySchema } from "@adlc/schemas";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gateway, GatewayConfigError, InvalidArgumentsError, ToolNotPermittedError, UnknownToolError } from "../src/gateway.js";
import { loadRolePolicies } from "../src/policies.js";
import { enginePolicy, gatewayHarness, repoRoot, SECRET, silentLogger, skipIntegration, type GatewayHarness } from "./helpers.js";

describe.skipIf(skipIntegration)("P0-WP5 gateway pipeline", () => {
  let h: GatewayHarness;
  beforeEach(async () => {
    h = await gatewayHarness();
  });
  afterEach(async () => {
    await h.close();
  });
  const session = () => h.gateway.authenticate(h.token);
  const audits = async () => (await new AuditRepository(h.db).list()).filter((e) => e.action.startsWith("tool."));

  it("NFR-001 authenticates per-run sessions; unknown or expired tokens are refused", async () => {
    expect(await session()).toMatchObject({ runId: h.runId, role: "engineer", taskKey: "PILOT-1", jiraProjectKey: "PILOT", repos: ["org/product"] });
    await expect(h.gateway.authenticate("forged")).rejects.toBeInstanceOf(InvalidSessionError);
    h.clock.current = new Date(h.clock.current.getTime() + 3_600_000);
    await expect(session()).rejects.toBeInstanceOf(InvalidSessionError);
  });

  it("allows a permitted call and audits it with argument and result hashes", async () => {
    const run = await session();
    await expect(h.gateway.call(run, "jira", "read_issue", { key: "PILOT-1" })).resolves.toMatchObject({ key: "PILOT-1", status: "In Progress" });
    const [e] = await audits();
    expect(e).toMatchObject({ actor: { kind: "agent-run", id: h.runId }, action: "tool.jira.read_issue", target: "task:PILOT-1", reason: "allowed" });
    expect(e?.beforeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(e?.afterHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hard rule 11: refuses unknown tools, tools outside the role policy and invalid arguments — and audits each refusal", async () => {
    const run = await session();
    await expect(h.gateway.call(run, "github", "merge_pull_request", { number: 1 })).rejects.toBeInstanceOf(UnknownToolError);
    await expect(h.gateway.call(run, "jira", "create_issue", { type: "Bug", summary: "s", description: "" })).rejects.toBeInstanceOf(ToolNotPermittedError);
    await expect(h.gateway.call(run, "jira", "read_issue", { key: "not a key" })).rejects.toBeInstanceOf(InvalidArgumentsError);
    await expect(h.gateway.call(run, "jira", "transition", { key: "PILOT-1", to: "Done" })).rejects.toBeInstanceOf(PolicyDeniedError);
    const reasons = (await audits()).map((e) => [e.action, e.reason.split(":")[0]]);
    expect(reasons).toEqual([
      ["tool.github.merge_pull_request", "denied"],
      ["tool.jira.create_issue", "denied"],
      ["tool.jira.read_issue", "denied"],
      ["tool.jira.transition", "denied"],
    ]);
    expect(h.jira.calls.filter((c) => c.startsWith("transition") || c.startsWith("createIssue"))).toEqual([]);
  });

  it("AT-P0-03 / hard rule 5: after the lease moves to a new run, the old session can no longer write", async () => {
    const run = await session();
    expect(await h.gateway.call(run, "jira", "comment", { key: "PILOT-1", body: "starting" })).toEqual({ id: "1" });
    // The run goes silent; a new run takes the task with a newer fencing token.
    h.clock.current = new Date(h.clock.current.getTime() + LEASE_TTL_MS + 1);
    const def = await h.t.pool.query<{ id: string }>("select agent_definition_id as id from agent_run limit 1");
    const next = await new AgentRunRepository(h.db).create({ agentDefinitionId: def.rows[0]?.id ?? "", projectId: h.projectId, kind: "task-pipeline", taskKey: "PILOT-1" }, { kind: "service", id: "adlc-orchestrator" }, h.clock.now());
    await new LeaseRepository(h.db).acquire({ taskKey: "PILOT-1", runId: next.id, deadlineAt: leaseDeadline(h.clock.now(), "S"), now: h.clock.now() });

    const writesBefore = h.jira.comments.length;
    await expect(h.gateway.call(run, "jira", "comment", { key: "PILOT-1", body: "stale write" })).rejects.toBeInstanceOf(StaleFencingTokenError);
    expect(h.jira.comments.length).toBe(writesBefore); // never reached Jira
    await expect(h.gateway.call(run, "jira", "read_issue", { key: "PILOT-1" })).resolves.toMatchObject({ key: "PILOT-1" }); // reads are not fenced
  });

  it("hard rule 9: secret values never appear in tool results or audit reasons", async () => {
    h.jira.humanEdit("PILOT-1", { description: `token is ${SECRET}` });
    const run = await session();
    const issue = (await h.gateway.call(run, "jira", "read_issue", { key: "PILOT-1" })) as { description: string };
    expect(issue.description).toBe("token is [redacted]");
    h.jira.issues.delete("PILOT-1");
    await expect(h.gateway.call(run, "jira", "comment", { key: "PILOT-1", body: SECRET })).rejects.toThrow();
    for (const e of await audits()) expect(e.reason).not.toContain(SECRET);
  });

  it("FR-DEC-001 decisions.raise is fenced, recorded against the run and audited", async () => {
    const run = await session();
    const d = (await h.gateway.call(run, "decisions", "raise", { class: "consult", route: "design", question: "Which header?", owner: "architect", timeboxMinutes: 240, reversible: true })) as { id: string; raisedBy: string; dueAt: string };
    expect(d).toMatchObject({ id: "DEC-0001", raisedBy: `agent-run:${h.runId}`, dueAt: "2026-11-05T12:00:00.000Z" });
    expect((await new AuditRepository(h.db).list()).map((e) => e.action)).toEqual(expect.arrayContaining(["decision.raise", "tool.decisions.raise"]));
  });

  it("refuses to start with a policy that names a tool that does not exist", () => {
    const bad = rolePolicySchema.parse({ role: "x", tools: ["github.merge_pull_request"] });
    expect(() => new Gateway({ db: h.db, tools: allTools, policies: new Map([["x", bad]]), adapters: { jira: h.jira, github: h.github }, secrets: { get: () => Promise.resolve(""), knownValues: () => [] }, heartbeats: undefined as never, clock: h.clock, logger: silentLogger })).toThrow(GatewayConfigError);
  });

  it("lists only the tools the role may call", async () => {
    const run = await session();
    expect(h.gateway.listTools(run, "github").map((t) => t.name).sort()).toEqual(["commit_files", "create_branch"]);
    expect(h.gateway.listTools({ ...run, role: "nobody" }, "jira")).toEqual([]);
  });
});

describe("P0-WP5 role policies on disk", () => {
  it("loads agents/*/policy.yaml; the dummy role writes only its task branch and docs/dummy/", async () => {
    const policies = await loadRolePolicies(path.join(repoRoot, "agents"));
    expect(policies.get("dummy")?.github).toEqual({ branches: ["task/{taskKey}"], writePaths: ["docs/dummy/**"], blockedPaths: [] });
    expect(enginePolicy.role).toBe("engineer");
  });

  it("rejects a policy whose role does not match its directory, and skips roles without a policy", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "adlc-agents-"));
    try {
      await mkdir(path.join(dir, "no-policy"));
      await mkdir(path.join(dir, "qa"));
      await writeFile(path.join(dir, "qa", "policy.yaml"), "role: engineer\ntools: [jira.read_issue]\n");
      await expect(loadRolePolicies(dir)).rejects.toBeInstanceOf(ConfigValidationError);
      await writeFile(path.join(dir, "qa", "policy.yaml"), "role: qa\ntools: [jira.read_issue]\n");
      expect([...(await loadRolePolicies(dir)).keys()]).toEqual(["qa"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
