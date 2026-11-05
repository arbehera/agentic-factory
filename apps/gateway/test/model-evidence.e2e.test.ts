import "reflect-metadata";
import { EnvSecretProvider } from "@adlc/adapters";
import { AgentRunRepository, EvidenceRepository, GatewaySessionRepository, ModelCallRepository } from "@adlc/db";
import { rolePolicySchema } from "@adlc/schemas";
import { FakeClaudeApi } from "@adlc/testing";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayModule } from "../src/http/app.module.js";
import { ModelProxy } from "../src/model-proxy.js";
import { enginePolicy, gatewayHarness, silentLogger, skipIntegration, type GatewayHarness } from "./helpers.js";

const API_KEY = "sk-test-claude-key-0123456789";
const reviewerPolicy = rolePolicySchema.parse({ role: "dummy-reviewer", tools: ["github.read_file", "evidence.write_verdict"] });

describe.skipIf(skipIntegration)("FR-EVD-001/002 model proxy and evidence server", () => {
  let h: GatewayHarness;
  let claude: FakeClaudeApi;
  let app: INestApplication;
  let base: string;
  let reviewerToken: string;
  let reviewerRunId: string;
  let otherRunToken: string;

  beforeAll(async () => {
    h = await gatewayHarness([enginePolicy, reviewerPolicy]);
    claude = new FakeClaudeApi();
    const upstreamUrl = await claude.start();
    const secrets = new EnvSecretProvider({ ADLC_SECRET_CLAUDE_API_KEY: API_KEY });
    const proxy = new ModelProxy({ upstreamUrl, apiKeySecret: "claude-api-key", maxTokensCap: 4096 }, secrets, new ModelCallRepository(h.db), h.clock, silentLogger);
    app = await NestFactory.create(GatewayModule.forRoot(h.gateway, proxy), { logger: false });
    await app.listen(0);
    base = (await app.getUrl()).replace("[::1]", "localhost");

    const def = await h.t.pool.query<{ id: string }>("select agent_definition_id as id from agent_run limit 1");
    const sessions = new GatewaySessionRepository(h.db);
    const mkRun = async () =>
      (await new AgentRunRepository(h.db).create({ agentDefinitionId: def.rows[0]?.id ?? "", projectId: h.projectId, kind: "review" }, { kind: "service", id: "adlc-orchestrator" }, h.clock.now())).id;
    reviewerRunId = await mkRun();
    const expiresAt = new Date(h.clock.now().getTime() + 3_600_000);
    const reviewTarget = { repo: "org/product", prNumber: 1, headSha: "a".repeat(40) };
    reviewerToken = await sessions.issue({ runId: reviewerRunId, role: "dummy-reviewer", projectId: h.projectId, taskKey: null, fencingToken: null, expiresAt, reviewTarget }, h.clock.now());
    otherRunToken = await sessions.issue({ runId: await mkRun(), role: "dummy-reviewer", projectId: h.projectId, taskKey: null, fencingToken: null, expiresAt, reviewTarget: { ...reviewTarget, prNumber: 2 } }, h.clock.now());
  });
  afterAll(async () => {
    await app.close();
    await claude.stop();
    await h.close();
  });

  const model = (token: string, body: unknown) =>
    fetch(`${base}/model/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const ask = { model: "claude-test", max_tokens: 64, messages: [{ role: "user", content: "Review this change." }] };

  it("hard rule 9: the gateway injects the API key; the agent sends only its session token and never sees the key", async () => {
    const res = await model(reviewerToken, ask);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(API_KEY);
    expect(JSON.parse(text)).toMatchObject({ id: "msg_fake_0001", content: [{ text: "LGTM" }] });
    const upstream = claude.requests.at(-1);
    expect(upstream?.headers["x-api-key"]).toBe(API_KEY);
    expect(upstream?.headers.authorization).toBeUndefined(); // the session token is not forwarded
  });

  it("FR-EVD-002 every proxied call is logged against the calling run", async () => {
    expect(await new ModelCallRepository(h.db).getMany(["msg_fake_0001"])).toMatchObject([{ runId: reviewerRunId, model: "claude-test", inputTokens: 12, outputTokens: 3 }]);
  });

  it("refuses streaming, oversized requests and bad sessions; upstream errors pass through without being logged", async () => {
    expect((await model(reviewerToken, { ...ask, stream: true })).status).toBe(400);
    expect((await model(reviewerToken, { ...ask, max_tokens: 100_000 })).status).toBe(400);
    expect((await model(reviewerToken, { model: "m" })).status).toBe(400);
    expect((await model("forged", ask)).status).toBe(401);
    claude.failNext = 529;
    const overloaded = await model(reviewerToken, ask);
    expect(overloaded.status).toBe(529);
    expect(await new ModelCallRepository(h.db).getMany(["msg_fake_0002"])).toEqual([]);
  });

  it("FR-EVD-001 a reviewer records a verdict citing its own model call; the role comes from its policy", async () => {
    const r = await h.gateway.call(await h.gateway.authenticate(reviewerToken), "evidence", "write_verdict", {
      repo: "org/product",
      prNumber: 1,
      headSha: "a".repeat(40),
      verdict: "approve",
      summary: "fine",
      modelCallId: "msg_fake_0001",
    });
    expect(r).toMatchObject({ reviewerRole: "dummy-reviewer", reviewerRunId, modelCallId: "msg_fake_0001" });
    expect(await new EvidenceRepository(h.db).verdictsFor("org/product", 1)).toHaveLength(1);
  });

  it("FR-EVD-001 refuses another run's model call, a second verdict on the same head, and non-reviewer roles", async () => {
    const args = { repo: "org/product", prNumber: 1, headSha: "a".repeat(40), verdict: "approve", summary: "x", modelCallId: "msg_fake_0001" };
    await expect(h.gateway.call(await h.gateway.authenticate(otherRunToken), "evidence", "write_verdict", { ...args, prNumber: 2 })).rejects.toThrow(/model call this run made/);
    await expect(h.gateway.call(await h.gateway.authenticate(reviewerToken), "evidence", "write_verdict", args)).rejects.toThrow(/already recorded a verdict/);
    await expect(h.gateway.call(await h.gateway.authenticate(h.token), "evidence", "write_verdict", args)).rejects.toThrow(/may not call evidence.write_verdict/);
  });

  it("FR-EVD-001 a review session records a verdict only on its bound PR head, and a model call backs one verdict", async () => {
    const reviewer = await h.gateway.authenticate(reviewerToken);
    expect(reviewer.reviewTarget).toEqual({ repo: "org/product", prNumber: 1, headSha: "a".repeat(40) });
    const args = { repo: "org/product", prNumber: 1, headSha: "a".repeat(40), verdict: "approve", summary: "x", modelCallId: "msg_fake_0001" };
    await expect(h.gateway.call(reviewer, "evidence", "write_verdict", { ...args, prNumber: 3 })).rejects.toThrow(/may only record a verdict on org\/product#1@/);
    await expect(h.gateway.call(reviewer, "evidence", "write_verdict", { ...args, headSha: "b".repeat(40) })).rejects.toThrow(/may only record a verdict on/);
    // A second review run bound to another head cannot reuse its own call twice either.
    const other = await h.gateway.authenticate(otherRunToken);
    const res = await fetch(`${base}/model/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${otherRunToken}` }, body: JSON.stringify(ask) });
    const { id } = (await res.json()) as { id: string };
    await expect(h.gateway.call(other, "evidence", "write_verdict", { ...args, prNumber: 2, modelCallId: id })).resolves.toMatchObject({ modelCallId: id });
    await expect(h.gateway.call(other, "evidence", "write_verdict", { ...args, prNumber: 2, modelCallId: id, verdict: "request-changes" })).rejects.toThrow(/already recorded a verdict/);
    // A session that is not a review session cannot write verdicts even with the tool allowed.
    await expect(h.gateway.call({ ...reviewer, reviewTarget: null }, "evidence", "write_verdict", args)).rejects.toThrow(/not a review session/);
  });
});
