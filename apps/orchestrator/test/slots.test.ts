import { AgentRunRepository } from "@adlc/db";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { candidate, harness, skipIntegration, type Harness } from "./helpers.js";

describe.skipIf(skipIntegration)("FR-ORC-014 sandbox quota", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("FR-ORC-014 sandbox projects hold at most the sandbox quota; production uses the rest; ended runs free their slot", async () => {
    const t = await harness({ EXECUTOR_SLOTS: "3", SANDBOX_SLOTS: "1" });
    h = t;
    await t.db.pool.query("update project set environment = 'sandbox' where id = $1", [t.seed.projectId]);
    t.source.queue = [candidate(t, "SBX-1"), candidate(t, "SBX-2")];
    const first = await t.orch.dispatcher.tick();
    expect(first.claimed.map((c) => c.taskKey)).toEqual(["SBX-1"]);
    expect(first.skipped).toEqual([{ taskKey: "SBX-2", reason: "no free sandbox slot" }]);

    const { rows } = await t.db.pool.query<{ id: string }>("insert into project (name, jira_project_key, status) values ('prod', 'PROD', 'active') returning id");
    const prod = rows[0]?.id ?? "";
    t.source.queue = ["P-1", "P-2", "P-3"].map((k) => ({ ...candidate(t, k), projectId: prod }));
    const second = await t.orch.dispatcher.tick();
    expect(second.claimed.map((c) => c.taskKey)).toEqual(["P-1", "P-2"]);
    expect(second.skipped).toEqual([{ taskKey: "P-3", reason: "no free executor slot" }]);

    const runs = new AgentRunRepository(t.orch.db);
    expect(await runs.countActive()).toEqual({ total: 3, sandbox: 1 });
    const sandboxRun = first.claimed[0]?.runId ?? "";
    await runs.transition(sandboxRun, "stopped", { kind: "service", id: "adlc-orchestrator" }, "done", t.clock.now());
    expect(await runs.countActive()).toEqual({ total: 2, sandbox: 0 });
  });

  it("FR-ORC-014 the sandbox quota cannot exceed the total", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://h/d", EXECUTOR_SLOTS: "2", SANDBOX_SLOTS: "3" })).toThrow(/SANDBOX_SLOTS/);
    expect(loadConfig({ DATABASE_URL: "postgres://h/d" })).toMatchObject({ EXECUTOR_SLOTS: 8, SANDBOX_SLOTS: 2 });
  });
});
