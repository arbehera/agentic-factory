import { AgentDefinitionRepository, createDb, ProjectRepository, runMigrations } from "@adlc/db";
import { freshDatabase, skipIntegration } from "@adlc/testing";
import { describe, expect, it } from "vitest";
import { applyDevSeed } from "../src/index.js";

describe.skipIf(skipIntegration)("P0-WP11 Compose dev seed", () => {
  it("registers one active project and the Phase 0 agent definitions; repeating it changes nothing", async () => {
    const t = await freshDatabase({ migrate: (pool) => runMigrations(createDb(pool)) });
    try {
      const first = await applyDevSeed(t.pool, { projectKey: "PILOT", repo: "org/product" });
      const again = await applyDevSeed(t.pool, { projectKey: "PILOT", repo: "org/product" });
      expect(again.projectId).toBe(first.projectId);
      const db = createDb(t.pool);
      expect(await new ProjectRepository(db).listActive()).toMatchObject([{ jiraProjectKey: "PILOT", repos: ["org/product"], environment: "production" }]);
      const defs = new AgentDefinitionRepository(db);
      expect(await defs.latestForRole("dummy")).toMatchObject({ name: "dummy", tier: "B", modelId: "none" });
      expect(await defs.latestForRole("dummy-reviewer")).toMatchObject({ name: "dummy-reviewer" });
      const { rows } = await t.pool.query<{ n: string }>("select count(*) as n from agent_definition");
      expect(rows[0]?.n).toBe("2");
    } finally {
      await t.close();
    }
  });
});
