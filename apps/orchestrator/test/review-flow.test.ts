import { AgentRunRepository, AuditRepository, EvidenceRepository, GatewaySessionRepository, ModelCallRepository } from "@adlc/db";
import { RUN_EXIT_CODES } from "@adlc/executor";
import { FakeExecutorBackend, FakeIssueTracker, FakeSourceControl } from "@adlc/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harness, skipIntegration, type Harness } from "./helpers.js";

const IMAGE = `registry.local/adlc/agent-runtime@sha256:${"c".repeat(64)}`;
const ENV = {
  AGENT_IMAGE: IMAGE,
  AGENT_GATEWAY_URL: "http://adlc-gateway:3001",
  AGENT_MEMORY_MB: "256",
  AGENT_SCRATCH_MB: "128",
  ADAPTERS: "dev-fakes",
  DISPATCH_ROLE: "dummy",
};
const REPO = "org/product";

describe.skipIf(skipIntegration)("AT-P0-01 review, evidence, approval and Done (orchestrator side, with fakes)", () => {
  let h: Harness;
  let exec: FakeExecutorBackend;
  let jira: FakeIssueTracker;
  let github: FakeSourceControl;
  let reviewerDefinitionId: string;

  beforeEach(async () => {
    exec = new FakeExecutorBackend();
    jira = new FakeIssueTracker();
    github = new FakeSourceControl();
    h = await harness(ENV, exec, jira, { scm: github, reviewerSets: { sets: { dummy: ["dummy-reviewer"] } } });
    await h.db.pool.query(`update project set jira_project_key = 'PILOT', repos = '["${REPO}"]'::jsonb where id = $1`, [h.seed.projectId]);
    const { rows } = await h.db.pool.query<{ id: string }>(
      "insert into agent_definition (name, version, role, tier, model_id, autonomy_level, owner_role, release, source_sha, content_hash) values ('dummy-reviewer', '0.0.1', 'dummy-reviewer', 'B', 'claude-test', 0, 'platform', 'dev', $1, 'x') returning id",
      ["0".repeat(40)],
    );
    reviewerDefinitionId = rows[0]?.id ?? "";
  });
  afterEach(async () => {
    await h.close();
  });

  /** The author's work, as the dummy agent leaves it: task branch, one commit, an open PR, task In Review. */
  async function authored(key: string): Promise<{ pr: number; head: string }> {
    const main = github.seedRepo(REPO, { "README.md": "product" });
    await github.createBranch(REPO, `task/${key}`, main);
    const { sha } = await github.commit(REPO, `task/${key}`, { files: [{ path: `docs/dummy/${key}.md`, content: "x" }], message: "m", parentSha: main });
    const pr = await github.openPullRequest(REPO, { head: `task/${key}`, base: "main", title: key, body: "" });
    jira.seed({ key, type: "Task", status: "In Review", summary: "t", description: "" });
    return { pr: pr.number, head: sha };
  }

  const flow = async () => {
    const f = h.orch.reviewFlow;
    if (!f) throw new Error("review flow not configured");
    return f.tick();
  };
  const jobs = async (kind: string) => (await h.db.pool.query<{ payload: Record<string, unknown> }>("select payload from job where kind = $1", [kind])).rows.map((r) => r.payload);

  it("AT-P0-01 verify -> one review run bound to the head -> verdict -> one signing request -> signed -> Awaiting Approval -> human merge -> Done", async () => {
    const { pr, head } = await authored("PILOT-1");
    expect(await flow()).toEqual({ reviews: 0, signs: 0, moved: [] }); // CI has not reported yet

    await github.setCommitStatus(REPO, head, { context: "adlc/verify", state: "success", description: "verify passed" });
    expect((await flow()).reviews).toBe(1);
    expect((await flow()).reviews).toBe(0); // one review per head, however often the flow runs

    // The worker starts the review run: no lease, a session that may judge only this PR head.
    await h.orch.worker?.drain();
    const failed = (await h.db.pool.query<{ e: string | null }>("select last_error as e from job where kind = 'start-review'")).rows[0]?.e;
    expect(failed ?? null).toBeNull();
    const review = [...exec.containers.values()][0]?.spec;
    expect(review?.env).toMatchObject({ ADLC_ROLE: "dummy-reviewer", ADLC_TASK_KEY: "PILOT-1", ADLC_REPO: REPO, ADLC_PR_NUMBER: String(pr), ADLC_HEAD_SHA: head, ADLC_MODEL: "claude-test" });
    const session = await new GatewaySessionRepository(h.orch.db).resolve(review?.env.ADLC_GATEWAY_TOKEN ?? "", h.clock.now());
    expect(session).toMatchObject({ role: "dummy-reviewer", taskKey: null, fencingToken: null, reviewTarget: { repo: REPO, prNumber: pr, headSha: head } });
    const reviewRunId = session.runId;
    expect(await new AgentRunRepository(h.orch.db).get(reviewRunId)).toMatchObject({ kind: "review", agentDefinitionId: reviewerDefinitionId, state: "running" });

    // The reviewer records its verdict through the gateway (P0-WP7); here directly.
    await new ModelCallRepository(h.orch.db).record({ id: "msg_1", runId: reviewRunId, model: "claude-test", inputTokens: 1, outputTokens: 1, requestHash: "r".repeat(64), responseHash: "s".repeat(64) }, h.clock.now());
    await new EvidenceRepository(h.orch.db).writeVerdict(
      { projectId: h.seed.projectId, repo: REPO, prNumber: pr, headSha: head, reviewerRole: "dummy-reviewer", reviewerRunId: reviewRunId, verdict: "approve", summary: "ok", modelCallId: "msg_1" },
      { kind: "agent-run", id: reviewRunId },
      h.clock.now(),
    );
    exec.exit(exec.byRun(reviewRunId)?.containerId ?? "", RUN_EXIT_CODES.succeeded);
    await h.orch.supervisor?.tick();
    expect(jira.issues.get("PILOT-1")?.status).toBe("In Review"); // a review run never moves the task

    expect((await flow()).signs).toBe(1);
    expect((await flow()).signs).toBe(0);
    expect(await jobs("sign-evidence")).toEqual([{ repo: REPO, prNumber: pr, headSha: head, authorRole: "dummy" }]);

    // The signer (its own service) posts adlc/evidence; then the task waits for the human (G5).
    await github.setCommitStatus(REPO, head, { context: "adlc/evidence", state: "success", description: "signed" });
    expect((await flow()).moved).toEqual(["PILOT-1:Awaiting Approval"]);
    expect(await flow()).toEqual({ reviews: 0, signs: 0, moved: [] }); // nothing happens until a human acts

    github.mergeAsHuman(REPO, pr, ["adlc/verify", "adlc/evidence"]);
    expect((await flow()).moved).toEqual(["PILOT-1:Done"]);
    const moves = (await new AuditRepository(h.orch.db).list()).filter((e) => e.action === "task.status").map((e) => `${e.actor.id}: ${e.reason}`);
    expect(moves).toEqual([
      `adlc-orchestrator: In Review -> Awaiting Approval: adlc/verify and adlc/evidence green on ${head}`,
      `adlc-orchestrator: Awaiting Approval -> Done: PR #${pr} merged at ${head}`,
    ]);
  });

  it("hard rule 2: without the human merge the task stays Awaiting Approval, however long it waits", async () => {
    const { head } = await authored("PILOT-2");
    await github.setCommitStatus(REPO, head, { context: "adlc/verify", state: "success", description: "" });
    await github.setCommitStatus(REPO, head, { context: "adlc/evidence", state: "success", description: "" });
    await flow();
    h.clock.advance(30 * 24 * 3_600_000);
    await flow();
    expect(jira.issues.get("PILOT-2")?.status).toBe("Awaiting Approval");
  });

  it("a push after review starts a new review for the new head; red CI or a missing PR does nothing", async () => {
    const { head } = await authored("PILOT-3");
    await github.setCommitStatus(REPO, head, { context: "adlc/verify", state: "success", description: "" });
    await flow();
    const newHead = github.pushAsHuman(REPO, "task/PILOT-3", { "x.md": "edited" });
    expect((await flow()).reviews).toBe(0); // the new head has no green CI yet
    await github.setCommitStatus(REPO, newHead, { context: "adlc/verify", state: "success", description: "" });
    expect((await flow()).reviews).toBe(1);
    expect((await jobs("start-review")).map((p) => p.headSha)).toEqual([head, newHead]);

    jira.seed({ key: "PILOT-4", type: "Task", status: "In Review", summary: "no PR yet", description: "" });
    expect(await flow()).toEqual({ reviews: 0, signs: 0, moved: [] });
  });

  it("a reviewer role with no registered definition is reported and nothing starts", async () => {
    await h.db.pool.query("delete from agent_definition where id = $1", [reviewerDefinitionId]);
    const { head } = await authored("PILOT-5");
    await github.setCommitStatus(REPO, head, { context: "adlc/verify", state: "success", description: "" });
    await flow();
    await h.orch.worker?.drain();
    expect(exec.containers.size).toBe(0);
  });
});
