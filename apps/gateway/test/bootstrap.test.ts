import path from "node:path";
import type { AddressInfo } from "node:net";
import { leaseDeadline } from "@adlc/domain";
import { AgentRunRepository, createDb, GatewaySessionRepository, LeaseRepository, runMigrations } from "@adlc/db";
import { createFakesServer, freshDatabase, seedProjectAndDefinition } from "@adlc/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGateway, GatewayStartupError, loadGatewayConfig } from "../src/index.js";
import { repoRoot, silentLogger, skipIntegration, TestClock } from "./helpers.js";

const FAKES_TOKEN = "gateway-bootstrap-test-01";

describe("P0-WP11 gateway configuration", () => {
  it("needs a database and an explicit adapter choice; defaults the rest", () => {
    expect(() => loadGatewayConfig({})).toThrow(GatewayStartupError);
    expect(() => loadGatewayConfig({ DATABASE_URL: "postgres://x@db/adlc" })).toThrow(/ADAPTERS/);
    expect(loadGatewayConfig({ DATABASE_URL: "postgres://x@db/adlc", ADAPTERS: "dev-fakes", SOMETHING_ELSE: "ignored" })).toEqual({
      DATABASE_URL: "postgres://x@db/adlc",
      ADAPTERS: "dev-fakes",
      PORT: 3001,
      LOG_LEVEL: "info",
      AGENTS_DIR: "agents",
      MODEL_API_KEY_SECRET: "claude-api-key",
      MODEL_MAX_TOKENS_CAP: 8192,
    });
  });
});

describe.skipIf(skipIntegration)("P0-WP11 gateway composition root", () => {
  const fakes = createFakesServer({ token: FAKES_TOKEN });
  let fakesUrl = "";
  beforeAll(async () => {
    await new Promise<void>((r) => fakes.server.listen(0, "127.0.0.1", r));
    fakesUrl = `http://127.0.0.1:${(fakes.server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    fakes.server.close();
  });

  it("loads agents/*/policy.yaml and serves an agent's tool call from the shared dev-fakes Jira", async () => {
    const t = await freshDatabase({ migrate: (pool) => runMigrations(createDb(pool)) });
    const clock = new TestClock(new Date("2026-11-05T08:00:00.000Z"));
    const { gateway, models, pool } = await buildGateway(
      loadGatewayConfig({ DATABASE_URL: t.url, ADAPTERS: "dev-fakes", FAKES_URL: fakesUrl, FAKES_TOKEN, AGENTS_DIR: path.join(repoRoot, "agents") }),
      { clock, logger: silentLogger },
    );
    try {
      expect(models).toBeNull(); // no upstream configured
      const db = createDb(t.pool);
      const seed = await seedProjectAndDefinition(t.pool);
      await t.pool.query("update project set jira_project_key = 'PILOT', repos = '[\"org/product\"]'::jsonb where id = $1", [seed.projectId]);
      const run = await new AgentRunRepository(db).create({ agentDefinitionId: seed.agentDefinitionId, projectId: seed.projectId, kind: "task-pipeline", taskKey: "PILOT-7" }, { kind: "service", id: "adlc-orchestrator" }, clock.now());
      const { lease } = await new LeaseRepository(db).acquire({ taskKey: "PILOT-7", runId: run.id, deadlineAt: leaseDeadline(clock.now(), "S"), now: clock.now() });
      const token = await new GatewaySessionRepository(db).issue({ runId: run.id, role: "dummy", projectId: seed.projectId, taskKey: "PILOT-7", fencingToken: lease.fencingToken, expiresAt: leaseDeadline(clock.now(), "S") }, clock.now());
      fakes.issues.seed({ key: "PILOT-7", type: "Task", status: "In Progress", summary: "from the shared fake", description: "" });

      const session = await gateway.authenticate(token);
      expect(await gateway.call(session, "jira", "read_issue", { key: "PILOT-7" })).toMatchObject({ key: "PILOT-7", summary: "from the shared fake" });
      expect(fakes.issues.calls).toContain("getIssue PILOT-7");
    } finally {
      await pool.end();
      await t.close();
    }
  });

  it("builds the model proxy when an upstream is configured; refuses the real adapters until Q-04", async () => {
    const base = { DATABASE_URL: "postgres://u@127.0.0.1:1/none", FAKES_URL: fakesUrl, FAKES_TOKEN, AGENTS_DIR: path.join(repoRoot, "agents") };
    const built = await buildGateway(loadGatewayConfig({ ...base, ADAPTERS: "dev-fakes", MODEL_UPSTREAM_URL: "http://fake-claude:9000/" }), { clock: new TestClock(new Date()), logger: silentLogger });
    expect(built.models).not.toBeNull();
    await built.pool.end();
    await expect(buildGateway(loadGatewayConfig({ ...base, ADAPTERS: "jira-github" }), { clock: new TestClock(new Date()), logger: silentLogger })).rejects.toThrow(/Q-04/);
  });
});
