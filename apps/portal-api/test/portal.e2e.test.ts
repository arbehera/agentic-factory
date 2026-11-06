import "reflect-metadata";
import { ManualClock } from "@adlc/control-plane";
import type { Actor } from "@adlc/domain";
import { AgentRunRepository, AuditRepository, createDb, NotificationRepository, runMigrations, stepRecord, type Db } from "@adlc/db";
import { FakeExecutorBackend, freshDatabase, seedProjectAndDefinition, skipIntegration, type TestDatabase } from "@adlc/testing";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PortalAuth, PortalController, PortalModule, PortalService, type RunLogSource } from "../src/index.js";

const ISSUER = "http://keycloak.test/realms/adlc";
const AUDIENCE = "adlc-portal";
const svc: Actor = { kind: "service", id: "adlc-orchestrator" };

describe.skipIf(skipIntegration)("FR-POR-001/002/004 Agent Operations Portal API", () => {
  let t: TestDatabase;
  let db: Db;
  let app: INestApplication;
  let base: string;
  let clock: ManualClock;
  let exec: FakeExecutorBackend;
  let sign: (claims: Record<string, unknown>, opts?: { audience?: string; expiresIn?: string }) => Promise<string>;
  let runId: string;
  let notificationId: string;
  let failMidStream = false;

  beforeAll(async () => {
    t = await freshDatabase({ migrate: (pool) => runMigrations(createDb(pool)) });
    db = createDb(t.pool);
    clock = new ManualClock(new Date("2026-11-05T08:00:00.000Z"));
    const seed = await seedProjectAndDefinition(t.pool);
    const runs = new AgentRunRepository(db);
    const run = await runs.create({ agentDefinitionId: seed.agentDefinitionId, projectId: seed.projectId, kind: "task-pipeline", taskKey: "PILOT-1" }, svc, clock.now());
    runId = run.id;
    exec = new FakeExecutorBackend();
    const handle = await exec.create({ runId, image: `a@sha256:${"e".repeat(64)}`, env: {}, limits: { cpus: 1, memoryMb: 64, pidsLimit: 16, scratchMb: 16 }, network: "adlc-agents" });
    exec.containers.get(handle.containerId)?.logs.push({ stream: "stdout", line: '{"msg":"step done","step":"read-task"}' }, { stream: "stderr", line: "warning" });
    await runs.transition(runId, "starting", svc, "container created", clock.now(), { containerId: handle.containerId });
    await runs.transition(runId, "running", svc, "started", clock.now());
    await db.insert(stepRecord).values({ runId, step: "S4", status: "running", startedAt: clock.now() });
    clock.advance(90_000);
    notificationId = (
      await new NotificationRepository(db).raise({ event: "run.needs-human", severity: "high", audience: "role:dummy", title: "PILOT-1 needs a human", body: "b", link: `/runs/${runId}`, dedupeKey: "k" }, clock.now())
    ).row.id;
    await new NotificationRepository(db).route(notificationId, ["onduty@example.invalid"], new Date(clock.now().getTime() + 3_600_000), clock.now());

    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    sign = (claims, opts = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(ISSUER)
        .setAudience(opts.audience ?? AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(opts.expiresIn ?? "5m")
        .sign(privateKey);
    const logs: RunLogSource = {
      follow: async function* (rid, containerId) {
        yield* exec.logs({ runId: rid, containerId });
        if (failMidStream) throw new Error("executor host went away");
      },
    };
    const auth = new PortalAuth({ issuer: ISSUER, audience: AUDIENCE, keys: createLocalJWKSet({ keys: [jwk] }) });
    app = await NestFactory.create(PortalModule.forRoot(new PortalService(db, logs, clock), auth), { logger: false });
    await app.listen(0);
    base = (await app.getUrl()).replace("[::1]", "localhost");
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  const as = async (roles: string[], extra: Record<string, unknown> = {}) => sign({ sub: "u-1", preferred_username: extra.username ?? "user.one", email: extra.email ?? null, realm_access: { roles } });
  const call = async (path: string, token: string | null, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers as Record<string, string> | undefined) } });

  it("FR-POR-003 rejects missing, forged, foreign-audience and expired tokens", async () => {
    expect((await call("/api/runs", null)).status).toBe(401);
    expect((await call("/api/runs", "not-a-jwt")).status).toBe(401);
    expect((await call("/api/runs", await sign({ sub: "x", realm_access: { roles: ["viewer"] } }, { audience: "other-app" }))).status).toBe(401);
    expect((await call("/api/runs", await sign({ sub: "x", realm_access: { roles: ["viewer"] } }, { expiresIn: "-1m" }))).status).toBe(401);
    expect((await call("/api/runs", await as([]))).status).toBe(403); // authenticated but no portal role
  });

  it("FR-POR-001 fleet view: every active run with role, version, task, state and heartbeat age", async () => {
    const res = await call("/api/runs", await as(["viewer"]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([expect.objectContaining({ id: runId, role: "dummy", agentVersion: "0.0.1", taskKey: "PILOT-1", state: "running", heartbeatAgeSeconds: 90 })]);
  });

  it("FR-POR-001 run detail: steps, lease and the audited timeline", async () => {
    const detail = (await (await call(`/api/runs/${runId}`, await as(["viewer"]))).json()) as { steps: unknown[]; timeline: { action: string }[] };
    expect(detail.steps).toEqual([expect.objectContaining({ step: "S4", status: "running" })]);
    expect(detail.timeline.map((e) => e.action)).toEqual(["run.create", "run.state", "run.state"]);
    expect((await call("/api/runs/00000000-0000-0000-0000-000000000000", await as(["viewer"]))).status).toBe(404);
  });

  it("a log source that fails mid-stream ends the response cleanly after the lines already sent", async () => {
    failMidStream = true;
    try {
      const res = await call(`/api/runs/${runId}/logs`, await as(["operator"]));
      expect(res.status).toBe(200);
      expect((await res.text()).trim().split("\n")).toHaveLength(2);
    } finally {
      failMidStream = false;
    }
  });

  it("FR-POR-001 live logs stream as NDJSON to operators; viewers may not read them", async () => {
    expect((await call(`/api/runs/${runId}/logs`, await as(["viewer"]))).status).toBe(403);
    const res = await call(`/api/runs/${runId}/logs`, await as(["operator"]));
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as unknown);
    expect(lines).toEqual([{ stream: "stdout", line: '{"msg":"step done","step":"read-task"}' }, { stream: "stderr", line: "warning" }]);
  });

  it("FR-POR-002 kill switch: platform admin or lead only, with a reason, audited with the human as actor", async () => {
    const body = JSON.stringify({ reason: "incident drill" });
    expect((await call("/api/kill-switch/engage", await as(["operator"]), { method: "POST", body })).status).toBe(403);
    expect((await call("/api/kill-switch/engage", await as(["lead"]), { method: "POST", body: JSON.stringify({ reason: " " }) })).status).toBe(400);
    expect((await call("/api/kill-switch/engage", await as(["lead"], { username: "program.lead" }), { method: "POST", body })).status).toBe(200);
    expect(await (await call("/api/kill-switch", await as(["viewer"]))).json()).toEqual({ engaged: true });
    expect((await call("/api/kill-switch/release", await as(["platform-admin"], { username: "admin.one" }), { method: "POST", body: JSON.stringify({ reason: "drill over" }) })).status).toBe(200);
    const events = (await new AuditRepository(db).list()).filter((e) => e.action === "control.flag");
    expect(events.map((e) => [e.actor, e.reason])).toEqual([
      [{ kind: "human", id: "program.lead" }, "engaged: incident drill"],
      [{ kind: "human", id: "admin.one" }, "released: drill over"],
    ]);
  });

  it("FR-NOT-001 inbox shows the user's items; recipients or operators acknowledge", async () => {
    const onDuty = await as(["viewer"], { email: "onduty@example.invalid", username: "on.duty" });
    expect(((await (await call("/api/inbox", onDuty)).json()) as { id: string }[]).map((n) => n.id)).toEqual([notificationId]);
    expect(await (await call("/api/inbox", await as(["viewer"], { email: "someone@example.invalid" }))).json()).toEqual([]);
    expect((await call(`/api/inbox/${notificationId}/ack`, await as(["viewer"], { email: "someone@example.invalid" }), { method: "POST" })).status).toBe(403);
    const ack = await call(`/api/inbox/${notificationId}/ack`, onDuty, { method: "POST" });
    expect(await ack.json()).toMatchObject({ ackBy: "human:on.duty" });
    expect((await call("/api/inbox/00000000-0000-0000-0000-000000000000/ack", await as(["operator"]), { method: "POST" })).status).toBe(404);
  });

  it("FR-POR-004 the portal has no route to approve gates, merge, or edit packs or configuration", () => {
    const proto = PortalController.prototype as unknown as Record<string, unknown>;
    const routes = Object.getOwnPropertyNames(proto)
      .filter((m) => m !== "constructor" && typeof proto[m] === "function")
      .map((m) => Reflect.getMetadata("path", proto[m] as object) as string | undefined)
      .filter((p): p is string => typeof p === "string");
    expect(routes.sort()).toEqual(["health", "inbox", "inbox/:id/ack", "kill-switch", "kill-switch/engage", "kill-switch/release", "runs", "runs/:id", "runs/:id/logs"]);
    expect(routes.join(" ")).not.toMatch(/approve|merge|gate|pack|config|policy/);
  });
});
