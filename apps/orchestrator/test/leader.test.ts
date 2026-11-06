import "reflect-metadata";
import { ADVISORY_LOCKS } from "@adlc/db";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AppModule } from "../src/http/app.module.js";
import { LeaderElector } from "../src/leader-elector.js";
import { OrchestratorRuntime, type LeaderJob } from "../src/runtime.js";
import { harness, silentLogger, skipIntegration, waitFor, type Harness } from "./helpers.js";

describe.skipIf(skipIntegration)("FR-ORC-015 leader-elected dispatcher", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanup.splice(0).reverse()) await c();
  });

  async function setup(): Promise<{ h: Harness; electors: LeaderElector[] }> {
    const h = await harness();
    cleanup.push(() => h.close());
    const electors = [0, 1, 2].map(() => new LeaderElector(h.db.url, ADVISORY_LOCKS.dispatcherLeader, 100, silentLogger));
    cleanup.push(async () => {
      for (const e of electors) await e.stop();
    });
    return { h, electors };
  }

  it("FR-ORC-015 exactly one of several replicas becomes leader", async () => {
    const { electors } = await setup();
    for (let i = 0; i < 3; i++) await Promise.all(electors.map((e) => e.poll()));
    expect(electors.filter((e) => e.isLeader)).toHaveLength(1);
  });

  it("AT-P0-06 when the leader's database session dies, another replica takes over", async () => {
    const { h, electors } = await setup();
    for (const e of electors) e.start();
    await waitFor(() => electors.filter((e) => e.isLeader).length === 1);
    const old = electors.find((e) => e.isLeader);
    // Kill the leader's session from outside, as a crashed host or failed network would.
    await h.db.pool.query("select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'adlc-orchestrator-leader' and pid in (select pid from pg_locks where locktype = 'advisory' and objid = $1)", [ADVISORY_LOCKS.dispatcherLeader]);
    await waitFor(() => electors.some((e) => e.isLeader && e !== old));
    await waitFor(() => electors.filter((e) => e.isLeader).length === 1);
    expect(old?.isLeader).toBe(false);
  });

  it("FR-ORC-015 a stopped leader releases the lock at once", async () => {
    const { electors } = await setup();
    const [a, b] = electors as [LeaderElector, LeaderElector];
    await a.poll();
    await b.poll();
    expect([a.isLeader, b.isLeader]).toEqual([true, false]);
    await a.stop();
    await b.poll();
    expect(b.isLeader).toBe(true);
  });

  it("FR-ORC-015 leader-only jobs run only while leading, never overlap, and survive failures", async () => {
    const { h } = await setup();
    const elector = new LeaderElector(h.db.url, ADVISORY_LOCKS.dispatcherLeader, 100, silentLogger);
    let runsWhileFollower = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const job: LeaderJob = {
      name: "probe",
      intervalMs: 20,
      run: async () => {
        calls++;
        if (!elector.isLeader) runsWhileFollower++;
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 60));
        concurrent--;
        if (calls === 2) throw new Error("boom");
      },
    };
    const runtime = new OrchestratorRuntime(elector, [job], silentLogger);
    await runtime.runJob(job); // not leader yet: does nothing
    expect(calls).toBe(0);
    runtime.start();
    await waitFor(() => calls >= 4);
    await runtime.stop();
    const after = calls;
    await new Promise((r) => setTimeout(r, 150));
    expect({ runsWhileFollower, maxConcurrent, stoppedRunning: calls === after }).toEqual({ runsWhileFollower: 0, maxConcurrent: 1, stoppedRunning: true });
  });
});

describe.skipIf(skipIntegration)("NFR-009 HTTP shell", () => {
  it("NFR-009 serves /health and /ready, and the replica becomes leader", async () => {
    const h = await harness();
    const app = await NestFactory.create(AppModule.forRoot(h.orch), { logger: false });
    app.enableShutdownHooks();
    await app.listen(0);
    try {
      const base = await app.getUrl();
      expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: "ok" });
      await waitFor(async () => ((await (await fetch(`${base}/ready`)).json()) as { leader: boolean }).leader);
      vi.spyOn(h.orch.pool, "query").mockRejectedValueOnce(new Error("database down"));
      const r = await fetch(`${base}/ready`);
      expect(r.status).toBe(503);
    } finally {
      await app.close(); // shutdown hook stops the runtime and ends the pool
      await h.db.close();
    }
  });
});

describe("NFR-009 configuration", () => {
  it("applies defaults and rejects invalid values with the field name", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://u:p@h:5432/d" })).toMatchObject({ PORT: 3000, DISPATCH_INTERVAL_MS: 5000 });
    expect(() => loadConfig({ DATABASE_URL: "nope" })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "postgres://h/d", PORT: "-1" })).toThrow(/PORT/);
  });
});
