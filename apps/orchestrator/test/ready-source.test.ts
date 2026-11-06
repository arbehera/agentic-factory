import { AgentDefinitionRepository, AgentRunRepository, LeaseRepository, ProjectRepository } from "@adlc/db";
import { LEASE_TTL_MS } from "@adlc/domain";
import { FakeExecutorBackend, FakeIssueTracker } from "@adlc/testing";
import { NestFactory } from "@nestjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/http/app.module.js";
import { JiraReadySource } from "../src/ready-source.js";
import { harness, skipIntegration, type Harness } from "./helpers.js";

describe.skipIf(skipIntegration)("P0-WP11 Phase 0 ready source (stand-in for FR-ORC-005)", () => {
  let h: Harness;
  let jira: FakeIssueTracker;
  let key: string;
  let source: JiraReadySource;

  beforeEach(async () => {
    h = await harness();
    jira = new FakeIssueTracker();
    const { rows } = await h.db.pool.query<{ k: string }>("select jira_project_key as k from project where id = $1", [h.seed.projectId]);
    key = rows[0]?.k ?? "";
    source = new JiraReadySource(jira, new ProjectRepository(h.orch.db), new AgentDefinitionRepository(h.orch.db), new LeaseRepository(h.orch.db), "dummy", h.clock);
  });
  afterEach(async () => {
    await h.close();
  });

  it("offers To Do and unleased In Progress tasks of active projects to the configured role, oldest first", async () => {
    jira.seed({ key: `${key}-1`, type: "Task", status: "To Do", summary: "a", description: "" });
    jira.seed({ key: `${key}-2`, type: "Task", status: "Done", summary: "b", description: "" });
    jira.seed({ key: `${key}-3`, type: "Task", status: "In Progress", summary: "c", description: "" });
    jira.seed({ key: `${key}-4`, type: "Task", status: "Blocked", summary: "d", description: "" });
    jira.seed({ key: "OTHER-1", type: "Task", status: "To Do", summary: "e", description: "" });
    const offered = await source.candidates(10);
    expect(offered.map((c) => c.taskKey)).toEqual([`${key}-1`, `${key}-3`]);
    expect(offered[0]).toEqual({ taskKey: `${key}-1`, projectId: h.seed.projectId, complexity: "S", agentDefinitionId: h.seed.agentDefinitionId, kind: "task-pipeline" });
    expect(jira.calls[0]).toBe(`search project = ${key} AND status in ("To Do", "In Progress") ORDER BY created ASC`);
    expect(await source.candidates(1)).toHaveLength(1);
  });

  it("skips a task while a run holds its lease, and offers it again once the lease has expired", async () => {
    jira.seed({ key: `${key}-5`, type: "Task", status: "In Progress", summary: "x", description: "" });
    const run = await new AgentRunRepository(h.orch.db).create({ agentDefinitionId: h.seed.agentDefinitionId, projectId: h.seed.projectId, kind: "task-pipeline", taskKey: `${key}-5` }, { kind: "service", id: "t" }, h.clock.now());
    await new LeaseRepository(h.orch.db).acquire({ taskKey: `${key}-5`, runId: run.id, deadlineAt: new Date(h.clock.now().getTime() + 3_600_000), now: h.clock.now() });
    expect(await source.candidates(10)).toEqual([]);
    h.clock.advance(LEASE_TTL_MS + 1);
    expect((await source.candidates(10)).map((c) => c.taskKey)).toEqual([`${key}-5`]);
  });

  it("offers nothing for a role with no registered definition, or for inactive projects", async () => {
    jira.seed({ key: `${key}-6`, type: "Task", status: "To Do", summary: "x", description: "" });
    const none = new JiraReadySource(jira, new ProjectRepository(h.orch.db), new AgentDefinitionRepository(h.orch.db), new LeaseRepository(h.orch.db), "no-such-role", h.clock);
    expect(await none.candidates(10)).toEqual([]);
    await h.db.pool.query("update project set status = 'paused'");
    expect(await source.candidates(10)).toEqual([]);
  });

  it("the orchestrator builds it from ADAPTERS + DISPATCH_ROLE; DISPATCH_ROLE without adapters is a configuration error", async () => {
    await expect(harness({ DISPATCH_ROLE: "dummy" })).rejects.toThrow(/DISPATCH_ROLE: needs ADAPTERS/);
  });
});

describe.skipIf(skipIntegration)("P0-WP11 internal live-log route (portal API -> executor host)", () => {
  const TOKEN = "internal-token-0123456789abcdef0123";
  const IMAGE = `registry.local/adlc/agent-runtime@sha256:${"c".repeat(64)}`;
  let h: Harness;
  let exec: FakeExecutorBackend;

  beforeEach(async () => {
    exec = new FakeExecutorBackend();
    h = await harness({ AGENT_IMAGE: IMAGE, AGENT_GATEWAY_URL: "http://gw:3001", AGENT_MEMORY_MB: "256", AGENT_SCRATCH_MB: "128" }, exec);
  });
  afterEach(async () => {
    await h.close();
  });

  async function serve(token: string | null) {
    const app = await NestFactory.create(AppModule.forRoot(h.orch, token), { logger: false });
    await app.listen(0);
    return { app, base: (await app.getUrl()).replace("[::1]", "localhost") };
  }

  it("streams the run's container log as NDJSON to a caller with the service token, and nothing to anyone else", async () => {
    h.source.queue = [{ taskKey: "PILOT-40", projectId: h.seed.projectId, complexity: "S", agentDefinitionId: h.seed.agentDefinitionId, kind: "task-pipeline" }];
    const [claim] = (await h.orch.dispatcher.tick()).claimed;
    await h.orch.worker?.drain();
    exec.byRun(claim?.runId ?? "")?.container.logs.push({ stream: "stdout", line: "hello" }, { stream: "stderr", line: "warn" });
    const { app, base } = await serve(TOKEN);
    try {
      const url = `${base}/internal/runs/${claim?.runId ?? ""}/logs`;
      const ok = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(ok.headers.get("content-type")).toContain("application/x-ndjson");
      expect((await ok.text()).trim().split("\n").map((l) => JSON.parse(l) as unknown)).toEqual([{ stream: "stdout", line: "hello" }, { stream: "stderr", line: "warn" }]);
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
      expect((await fetch(`${base}/internal/runs/not-a-uuid/logs`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(400);
      expect((await fetch(`${base}/internal/runs/00000000-0000-0000-0000-000000000000/logs`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("is off when no internal token is configured", async () => {
    const { app, base } = await serve(null);
    try {
      expect((await fetch(`${base}/internal/runs/00000000-0000-0000-0000-000000000000/logs`, { headers: { authorization: "Bearer x" } })).status).toBe(404);
    } finally {
      await app.close();
    }
  });
});
