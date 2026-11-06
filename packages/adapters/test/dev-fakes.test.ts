import { describe, expect, it } from "vitest";
import { BranchMovedError, createAdapters, DevFakesError, IssueConflictError } from "../src/index.js";

/** A fetch stub that records the request and replies with `reply`. */
function stub(reply: { status: number; body: unknown }) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const impl = ((url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status }));
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const settings = { ADAPTERS: "dev-fakes", FAKES_URL: "http://fakes:4000/", FAKES_TOKEN: "t0k3n" };

describe("P0-WP11 dev-fakes clients", () => {
  it("send every port call as POST <area>/<method> with the args and the bearer token", async () => {
    const s = stub({ status: 200, body: { result: null } });
    const { issues, scm } = createAdapters(settings, s.impl);
    await issues.getIssue("K-1");
    await issues.search("project = K", 5);
    await issues.createIssue({ projectKey: "K", type: "Task", summary: "s", description: "d" });
    await issues.addComment("K-1", "b");
    await issues.transition("K-1", "Done", "3");
    await issues.link("K-1", "K-2", "Blocks");
    await scm.getFile("r", "main", "p");
    await scm.getBranch("r", "b");
    await scm.createBranch("r", "b", "main");
    await scm.commit("r", "b", { files: [], message: "m", parentSha: "x" });
    await scm.openPullRequest("r", { head: "b", base: "main", title: "t", body: "y" });
    await scm.commentOnPullRequest("r", 1, "c");
    await scm.checkStatuses("r", "x");
    await scm.getPullRequest("r", 1);
    await scm.setCommitStatus("r", "x", { context: "adlc/verify", state: "success", description: "d" });
    expect(s.seen.map((c) => c.url.replace("http://fakes:4000/", ""))).toEqual([
      "jira/getIssue", "jira/search", "jira/createIssue", "jira/addComment", "jira/transition", "jira/link",
      "github/getFile", "github/getBranch", "github/createBranch", "github/commit", "github/openPullRequest",
      "github/commentOnPullRequest", "github/checkStatuses", "github/getPullRequest", "github/setCommitStatus",
    ]);
    expect(JSON.parse(typeof s.seen[4]?.init?.body === "string" ? s.seen[4].init.body : "null")).toEqual({ args: ["K-1", "Done", "3"] });
    expect(new Headers(s.seen[0]?.init?.headers).get("authorization")).toBe("Bearer t0k3n");
  });

  it("rebuild the port's typed errors; anything else is a DevFakesError", async () => {
    const conflict = createAdapters(settings, stub({ status: 409, body: { error: { name: "IssueConflictError", message: "changed" } } }).impl);
    await expect(conflict.issues.transition("K-1", "Done", "1")).rejects.toBeInstanceOf(IssueConflictError);
    const moved = createAdapters(settings, stub({ status: 409, body: { error: { name: "BranchMovedError", message: "moved" } } }).impl);
    await expect(moved.scm.commit("r", "b", { files: [], message: "m", parentSha: "x" })).rejects.toBeInstanceOf(BranchMovedError);
    const other = createAdapters(settings, stub({ status: 500, body: { error: { name: "TypeError", message: "boom" } } }).impl);
    await expect(other.issues.getIssue("K-1")).rejects.toThrow(new DevFakesError("boom"));
    const garbage = createAdapters(settings, stub({ status: 502, body: "<html>bad gateway</html>" }).impl);
    await expect(garbage.issues.getIssue("K-1")).rejects.toThrow("dev-fakes jira/getIssue failed with HTTP 502");
  });
});
