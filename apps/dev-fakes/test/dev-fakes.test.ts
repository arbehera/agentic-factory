import type { AddressInfo } from "node:net";
import {
  AdapterUnavailableError,
  BranchMovedError,
  createAdapters,
  DevFakesError,
  IssueConflictError,
  IssueNotFoundError,
  type IssueTracker,
  type SourceControl,
} from "@adlc/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakesServer, type FakesState } from "../src/index.js";

const TOKEN = "dev-fakes-test-token-0001";
let base = "";
let issues: IssueTracker;
let scm: SourceControl;
const fakes = createFakesServer({ token: TOKEN });

const admin = async (op: string, args: unknown[]) => {
  const res = await fetch(`${base}/admin/${op}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ args }) });
  return { status: res.status, body: (await res.json()) as { result?: unknown; error?: { name: string } } };
};

beforeAll(async () => {
  await new Promise<void>((resolve) => fakes.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(fakes.server.address() as AddressInfo).port}`;
  ({ issues, scm } = createAdapters({ ADAPTERS: "dev-fakes", FAKES_URL: `${base}/`, FAKES_TOKEN: TOKEN }));
});
afterAll(() => {
  fakes.server.close();
});

describe("P0-WP11 dev-fakes: one fake Jira and GitHub shared by every service", () => {
  it("runs IssueTracker calls over HTTP and keeps the port's typed errors", async () => {
    await admin("seedIssue", [{ key: "PILOT-1", type: "Task", status: "To Do", summary: "s", description: "d" }]);
    const issue = await issues.getIssue("PILOT-1");
    expect(issue).toMatchObject({ key: "PILOT-1", status: "To Do" });
    expect((await issues.search("project = PILOT", 10)).map((i) => i.key)).toEqual(["PILOT-1"]);
    await expect(issues.getIssue("PILOT-9")).rejects.toBeInstanceOf(IssueNotFoundError);

    // FR-JIRA-002: a human edit between read and write makes the write fail; the human wins.
    expect((await admin("humanEdit", ["PILOT-1", { summary: "edited by a human" }])).status).toBe(200);
    await expect(issues.transition("PILOT-1", "In Progress", issue.version)).rejects.toBeInstanceOf(IssueConflictError);
    const fresh = await issues.getIssue("PILOT-1");
    expect((await issues.transition("PILOT-1", "In Progress", fresh.version)).status).toBe("In Progress");

    const created = await issues.createIssue({ projectKey: "PILOT", type: "Task", summary: "x", description: "y", externalId: "f/T001" });
    expect((await issues.createIssue({ projectKey: "PILOT", type: "Task", summary: "x", description: "y", externalId: "f/T001" })).key).toBe(created.key);
    expect(await issues.addComment("PILOT-1", "hello")).toEqual({ id: "1" });
    await issues.link("PILOT-1", created.key, "Blocks");
  });

  it("runs SourceControl calls over HTTP; a moved branch is a BranchMovedError", async () => {
    const main = String((await admin("seedRepo", ["org/repo", { "README.md": "hi" }])).body.result);
    const { sha } = await scm.createBranch("org/repo", "task/PILOT-1", "main");
    expect(sha).toBe(main);
    expect(await scm.getBranch("org/repo", "task/PILOT-1")).toBe(main);
    expect(await scm.getFile("org/repo", "main", "README.md")).toMatchObject({ content: "hi" });
    const c = await scm.commit("org/repo", "task/PILOT-1", { files: [{ path: "a.md", content: "a" }], message: "m", parentSha: main });
    await expect(scm.commit("org/repo", "task/PILOT-1", { files: [], message: "m", parentSha: main })).rejects.toBeInstanceOf(BranchMovedError);
    const pr = await scm.openPullRequest("org/repo", { head: "task/PILOT-1", base: "main", title: "t", body: "b" });
    expect(pr).toEqual({ number: 1, headSha: c.sha });
    await scm.commentOnPullRequest("org/repo", 1, "c");
    await scm.setCommitStatus("org/repo", c.sha, { context: "adlc/verify", state: "success", description: "ok" });
    expect(await scm.checkStatuses("org/repo", c.sha)).toEqual([{ context: "adlc/verify", state: "success" }]);
    expect(await scm.getPullRequest("org/repo", 1)).toMatchObject({ head: "task/PILOT-1", headSha: c.sha });

    // A human push moves the head; admin/state shows everything for assertions.
    const pushed = String((await admin("pushAsHuman", ["org/repo", "task/PILOT-1", { "b.md": "b" }])).body.result);
    expect(await scm.getBranch("org/repo", "task/PILOT-1")).toBe(pushed);
    const state = (await (await fetch(`${base}/admin/state`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { result: FakesState };
    expect(state.result.pullRequests).toHaveLength(1);
    expect(state.result.statuses.map((s) => s.status.context)).toEqual(["adlc/verify"]);
  });

  it("AT-P0-01 a human merge goes through only with adlc/verify and adlc/evidence green on the head", async () => {
    await admin("seedRepo", ["org/merge", { "README.md": "hi" }]);
    const { sha } = await scm.createBranch("org/merge", "task/PILOT-2", "main");
    const c = await scm.commit("org/merge", "task/PILOT-2", { files: [{ path: "x.md", content: "x" }], message: "m", parentSha: sha });
    const pr = await scm.openPullRequest("org/merge", { head: "task/PILOT-2", base: "main", title: "t", body: "b" });
    expect(await scm.findPullRequest("org/merge", "task/PILOT-2")).toMatchObject({ number: pr.number, merged: false });
    expect(await scm.findPullRequest("org/merge", "task/none")).toBeNull();

    await scm.setCommitStatus("org/merge", c.sha, { context: "adlc/verify", state: "success", description: "ok" });
    const refused = await admin("mergeAsHuman", ["org/merge", pr.number]);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("adlc/evidence");

    await scm.setCommitStatus("org/merge", c.sha, { context: "adlc/evidence", state: "success", description: "signed" });
    expect((await admin("mergeAsHuman", ["org/merge", pr.number])).body.result).toBe(c.sha);
    expect(await scm.getPullRequest("org/merge", pr.number)).toMatchObject({ merged: true });
    expect(await scm.getBranch("org/merge", "main")).toBe(c.sha);
    expect((await admin("mergeAsHuman", ["org/merge", pr.number])).status).toBe(409); // already merged
    expect((await admin("mergeAsHuman", ["org/merge", 99])).status).toBe(409);
  });

  it("serves only port methods and admin operations, and only with the token", async () => {
    const res = await fetch(`${base}/github/mergePullRequest`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}" });
    expect(res.status).toBe(400); // no merge on the port, so none over HTTP (hard rule 3)
    expect((await fetch(`${base}/jira/getIssue`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${base}/jira/getIssue`, { method: "POST", headers: { authorization: "Bearer wrong-token-of-same-size" }, body: "{}" })).status).toBe(401);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await admin("nothing", [])).body.error?.name).toBe("BadRequest");
    const notJson = await fetch(`${base}/jira/getIssue`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{" });
    expect(notJson.status).toBe(400);
    const notArray = await fetch(`${base}/jira/getIssue`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: '{"args":1}' });
    expect(notArray.status).toBe(400);
    await expect(createAdapters({ ADAPTERS: "dev-fakes", FAKES_URL: base, FAKES_TOKEN: "wrong" }).issues.getIssue("PILOT-1")).rejects.toBeInstanceOf(DevFakesError);
  });

  it("refuses to build adapters that are missing, unknown, or not yet available (Q-04)", () => {
    expect(() => createAdapters({})).toThrow(AdapterUnavailableError);
    expect(() => createAdapters({ ADAPTERS: "dev-fakes" })).toThrow(/FAKES_URL/);
    expect(() => createAdapters({ ADAPTERS: "jira-github" })).toThrow(/Q-04/);
  });
});

describe("P0-WP11 fake Jira search", () => {
  it("applies the JQL status clause, so older non-matching issues cannot hide newer matching ones", async () => {
    const { FakeIssueTracker } = await import("@adlc/testing/fakes");
    const jira = new FakeIssueTracker();
    for (let i = 1; i <= 5; i++) jira.seed({ key: `OLD-${i}`, type: "Task", status: "Done", summary: "", description: "" });
    jira.seed({ key: "OLD-6", type: "Task", status: "To Do", summary: "", description: "" });
    jira.seed({ key: "OLD-7", type: "Task", status: "In Progress", summary: "", description: "" });
    expect((await jira.search('project = OLD AND status in ("To Do", "In Progress") ORDER BY created ASC', 2)).map((i) => i.key)).toEqual(["OLD-6", "OLD-7"]);
    expect((await jira.search('project = OLD AND status = "Done"', 10)).map((i) => i.key)).toHaveLength(5);
    expect(await jira.search("project = OLD", 3)).toHaveLength(3);
  });
});
