import { LEASE_TTL_MS } from "@adlc/domain";
import { AgentRunRepository, AuditRepository, GatewaySessionRepository, InvalidSessionError, LeaseRepository } from "@adlc/db";
import { RUN_EXIT_CODES } from "@adlc/executor";
import { FakeExecutorBackend } from "@adlc/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Claim } from "../src/dispatcher.js";
import { candidate, harness, skipIntegration, type Harness } from "./helpers.js";

const IMAGE = `registry.local/adlc/agent-runtime@sha256:${"c".repeat(64)}`;
const ENV = { AGENT_IMAGE: IMAGE, AGENT_GATEWAY_URL: "http://adlc-gateway:3001", AGENT_MEMORY_MB: "256", AGENT_SCRATCH_MB: "128" };

describe.skipIf(skipIntegration)("P0-WP4 run launch and supervision", () => {
  let h: Harness;
  let exec: FakeExecutorBackend;
  let runs: AgentRunRepository;

  beforeEach(async () => {
    exec = new FakeExecutorBackend();
    h = await harness(ENV, exec);
    runs = new AgentRunRepository(h.orch.db);
    await h.db.pool.query(`update project set repos = '["org/product"]'::jsonb where id = $1`, [h.seed.projectId]);
  });
  afterEach(async () => {
    await h.close();
  });

  async function claimAndLaunch(taskKey = "PILOT-1"): Promise<Claim & { containerId: string }> {
    h.source.queue = [candidate(h, taskKey)];
    const [claim] = (await h.orch.dispatcher.tick()).claimed;
    if (!claim) throw new Error("nothing claimed");
    await h.orch.worker?.drain();
    const c = exec.byRun(claim.runId);
    if (!c) throw new Error("no container");
    return { ...claim, containerId: c.containerId };
  }

  it("FR-ORC-013 a claimed task gets one hardened container with a run-scoped gateway session and no other credential", async () => {
    const claim = await claimAndLaunch();
    const spec = exec.byRun(claim.runId)?.container.spec;
    expect(spec).toMatchObject({
      image: IMAGE,
      network: "adlc-agents",
      limits: { cpus: 1, memoryMb: 256, pidsLimit: 512, scratchMb: 128 },
      env: { ADLC_GATEWAY_URL: "http://adlc-gateway:3001", ADLC_RUN_ID: claim.runId, ADLC_TASK_KEY: "PILOT-1", ADLC_ROLE: "dummy", ADLC_REPO: "org/product" },
    });
    expect(Object.keys(spec?.env ?? {}).sort()).toEqual(["ADLC_GATEWAY_TOKEN", "ADLC_GATEWAY_URL", "ADLC_REPO", "ADLC_ROLE", "ADLC_RUN_ID", "ADLC_TASK_KEY"]);

    // The token is the run's gateway session, bound to the lease's fencing token.
    const session = await new GatewaySessionRepository(h.orch.db).resolve(spec?.env.ADLC_GATEWAY_TOKEN ?? "", h.clock.now());
    expect(session).toMatchObject({ runId: claim.runId, role: "dummy", taskKey: "PILOT-1", fencingToken: claim.fencingToken, repos: ["org/product"] });
    expect(await runs.get(claim.runId)).toMatchObject({ state: "running", containerId: claim.containerId });

    // The start job is idempotent: draining again starts nothing new.
    await h.orch.worker?.drain();
    expect(exec.containers.size).toBe(1);
  });

  it("FR-ORC-008 a run that exits 0 succeeds; its lease is released, session revoked and container removed", async () => {
    const claim = await claimAndLaunch();
    const token = exec.byRun(claim.runId)?.container.spec.env.ADLC_GATEWAY_TOKEN ?? "";
    expect(await h.orch.supervisor?.tick()).toEqual([]); // still running
    exec.exit(claim.containerId, RUN_EXIT_CODES.succeeded);
    expect(await h.orch.supervisor?.tick()).toEqual([{ runId: claim.runId, state: "succeeded", reason: "container exited 0" }]);
    expect(await new LeaseRepository(h.orch.db).get("PILOT-1")).toBeNull();
    await expect(new GatewaySessionRepository(h.orch.db).resolve(token, h.clock.now())).rejects.toBeInstanceOf(InvalidSessionError);
    expect(exec.containers.size).toBe(0);
    const actions = (await new AuditRepository(h.orch.db).list()).map((e) => e.action);
    expect(actions).toEqual(["run.create", "lease.acquire", "run.state", "run.state", "run.state", "lease.release"]);
  });

  it("FR-ORC-012 exit 3 (stopped on directive) ends the run as stopped", async () => {
    const claim = await claimAndLaunch();
    exec.exit(claim.containerId, RUN_EXIT_CODES.stoppedByDirective);
    expect(await h.orch.supervisor?.tick()).toMatchObject([{ state: "stopped" }]);
  });

  it("a failing container ends the run as failed (OOM is named) and is kept for diagnosis; a vanished one is lost", async () => {
    const a = await claimAndLaunch("PILOT-2");
    exec.exit(a.containerId, 137, { oomKilled: true });
    const b = await claimAndLaunch("PILOT-3");
    exec.vanish(b.containerId);
    const ended = await h.orch.supervisor?.tick();
    expect(ended).toEqual(
      expect.arrayContaining([
        { runId: a.runId, state: "failed", reason: "container exited 137 (out of memory)" },
        { runId: b.runId, state: "lost", reason: "container disappeared" },
      ]),
    );
    expect(exec.containers.has(a.containerId)).toBe(true);
    expect(await new LeaseRepository(h.orch.db).get("PILOT-2")).toBeNull(); // the task can be claimed again
  });

  it("a container that fails to start is cleaned up: no container, session revoked, lease released, run failed", async () => {
    exec.failNextCreate = new Error("daemon unavailable");
    h.source.queue = [candidate(h, "PILOT-4")];
    const [claim] = (await h.orch.dispatcher.tick()).claimed;
    await h.orch.worker?.drain();
    expect(exec.containers.size).toBe(0);
    expect(await runs.get(claim?.runId ?? "")).toMatchObject({ state: "stopped" });
    expect(await new LeaseRepository(h.orch.db).get("PILOT-4")).toBeNull();
    const { rows } = await h.db.pool.query<{ n: string }>("select count(*) as n from gateway_session where run_id = $1 and revoked_at is null", [claim?.runId]);
    expect(rows[0]?.n).toBe("0");
  });

  it("FR-ORC-008 a run whose lease expired before a worker picked it up is retired without a container", async () => {
    h.source.queue = [candidate(h, "PILOT-5")];
    const [claim] = (await h.orch.dispatcher.tick()).claimed;
    h.clock.advance(LEASE_TTL_MS + 1);
    await h.orch.worker?.drain();
    expect(exec.containers.size).toBe(0);
    expect(await runs.get(claim?.runId ?? "")).toMatchObject({ state: "stopped" });
  });

  it("an executor without an agent image is a configuration error", async () => {
    await expect(harness({}, new FakeExecutorBackend())).rejects.toThrow(/AGENT_IMAGE/);
  });
});
