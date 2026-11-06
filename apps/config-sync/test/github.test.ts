import { readFile } from "node:fs/promises";
import { loadYamlContract } from "@adlc/pack-sdk";
import { githubRepoConfigSchema, type GithubRepoConfig } from "@adlc/schemas";
import { describe, expect, it } from "vitest";
import {
  GithubApiError,
  GithubConfigClient,
  PlanBlockedError,
  planGithub,
  renderCodeowners,
  renderGithubPlan,
  renderRulesets,
  REPOSITORY_ADMIN_ROLE_ID,
  type GithubActualState,
  type RulesetBody,
} from "../src/index.js";

const manifestPath = new URL("../../../infra/github/factory-sample.yaml", import.meta.url);
const load = async (): Promise<GithubRepoConfig> => loadYamlContract(githubRepoConfigSchema, await readFile(manifestPath, "utf8"), "factory-sample.yaml");
const org: GithubActualState = { ownerType: "Organization", empty: false, rulesets: [], codeowners: null };
const byName = (rs: RulesetBody[], name: string) => rs.find((r) => r.name === name);

describe("FR-GH-001 GitHub configuration-as-code: rulesets", () => {
  it("FR-GH-001 main: PR with code-owner approval of the latest push, stale approvals dismissed, required checks, merge queue of one, no bypass", async () => {
    const main = byName(renderRulesets(await load(), { ci: 42 }, { mergeQueue: true }), "adlc-main");
    expect(main?.bypass_actors).toEqual([]);
    expect(main?.conditions.ref_name.include).toEqual(["~DEFAULT_BRANCH"]);
    const rule = (t: string) => main?.rules.find((r) => r.type === t)?.parameters;
    expect(main?.rules.map((r) => r.type)).toEqual(["deletion", "non_fast_forward", "pull_request", "required_status_checks", "merge_queue"]);
    expect(rule("pull_request")).toMatchObject({ required_approving_review_count: 1, require_code_owner_review: true, dismiss_stale_reviews_on_push: true, require_last_push_approval: true });
    expect(rule("required_status_checks")?.required_status_checks).toEqual([
      { context: "adlc/verify", integration_id: 42 },
      { context: "adlc/evidence", integration_id: 42 },
    ]);
    expect(rule("merge_queue")).toMatchObject({ max_entries_to_merge: 1, max_entries_to_build: 1, merge_method: "MERGE" });
  });

  it("FR-GH-001 AT-P0-04 agent branches cannot be deleted or force-pushed; every other branch and tag is closed to non-admins", async () => {
    const rs = renderRulesets(await load(), { ci: 42 }, { mergeQueue: true });
    const agent = byName(rs, "adlc-agent-branches");
    expect(agent?.conditions.ref_name.include).toEqual(["refs/heads/task/*", "refs/heads/spec/*"]);
    expect(agent?.rules.map((r) => r.type)).toEqual(["deletion", "non_fast_forward"]);
    expect(agent?.bypass_actors).toEqual([]);
    const other = byName(rs, "adlc-other-branches");
    expect(other?.conditions.ref_name).toEqual({ include: ["~ALL"], exclude: ["~DEFAULT_BRANCH", "refs/heads/task/*", "refs/heads/spec/*", "refs/heads/gh-readonly-queue/*"] });
    expect(other?.rules.map((r) => r.type)).toEqual(["creation", "update", "deletion", "non_fast_forward"]);
    // Only the repository admin role may bypass; a GitHub App is never a repository role.
    expect(other?.bypass_actors).toEqual([{ actor_id: REPOSITORY_ADMIN_ROLE_ID, actor_type: "RepositoryRole", bypass_mode: "always" }]);
    expect(byName(rs, "adlc-tags")?.rules.map((r) => r.type)).toEqual(["creation", "update", "deletion"]);
  });

  it("FR-GH-001 CODEOWNERS is rendered from the manifest", async () => {
    expect(renderCodeowners(await load())).toMatch(/\n\* @arbehera\n$/);
  });
});

describe("FR-GH-001 GitHub configuration-as-code: plan", () => {
  it("FR-GH-001 an empty repository is bootstrapped with CODEOWNERS before any ruleset locks main", async () => {
    const plan = planGithub(await load(), { ...org, empty: true }, { ci: 42 });
    expect(plan.actions.map((a) => a.kind)).toEqual(["bootstrap-default-branch", "create-ruleset", "create-ruleset", "create-ruleset", "create-ruleset"]);
    expect(plan.blockers).toEqual([]);
    expect(plan.warnings).toEqual([
      "adlc/paths is required by FR-GH-001 but not posted until P3-WP3 (FR-GH-002); it is not required yet",
      "adlc/gate is required by FR-GH-001 but not posted until P1-WP2 (FR-GH-003), spec baseline PRs; it is not required yet",
    ]);
  });

  it("OPEN-14 a personal repository cannot have a merge queue: the plan is blocked, not silently weakened", async () => {
    const plan = planGithub(await load(), { ...org, ownerType: "User" }, { ci: 42 });
    expect(plan.blockers).toEqual([expect.stringMatching(/merge queues only on organization-owned repositories \(OPEN-14\)/)]);
    expect(renderGithubPlan(plan)).toContain("BLOCKER:");
  });

  it("FR-GH-001 without the CI App ID the plan is blocked (checks would accept any identity)", async () => {
    expect(planGithub(await load(), org, { ci: null }).blockers).toEqual([expect.stringContaining("ADLC_CI_APP_ID")]);
  });

  it("FR-GH-001 matching rulesets are unchanged (order-insensitive); drift is an update; unmanaged rulesets are left alone; stale managed ones go", async () => {
    const config = await load();
    const desired = renderRulesets(config, { ci: 42 }, { mergeQueue: true });
    const [main, agent, other, tags] = desired as [RulesetBody, RulesetBody, RulesetBody, RulesetBody];
    const actual: GithubActualState = {
      ...org,
      codeowners: renderCodeowners(config),
      rulesets: [
        { ...main, id: 1, rules: [...main.rules].reverse() },
        { ...agent, id: 2, rules: [{ type: "deletion" }] },
        { ...other, id: 3 },
        { ...tags, id: 4, bypass_actors: [] },
        { ...tags, id: 5, name: "adlc-legacy" },
        { ...tags, id: 6, name: "team-policy" },
      ],
    };
    const plan = planGithub(config, actual, { ci: 42 });
    expect(plan.unchanged).toEqual(["adlc-main", "adlc-other-branches"]);
    expect(plan.actions).toEqual([
      { kind: "update-ruleset", id: 2, body: agent, changed: ["rules"] },
      { kind: "update-ruleset", id: 4, body: tags, changed: ["bypass_actors"] },
      { kind: "delete-ruleset", id: 5, name: "adlc-legacy" },
    ]);
    expect(plan.unmanaged).toEqual(["team-policy"]);
    expect(plan.manual).toEqual([]);
    expect(planGithub(config, { ...actual, codeowners: "* @someone\n" }, { ci: 42 }).manual).toEqual([expect.stringContaining("open a PR")]);
  });
});

describe("FR-GH-001 GitHub configuration client", () => {
  function fakeGithub(routes: Record<string, { status: number; body?: unknown }>) {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const fetchImpl = (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const path = url.pathname.replace("/repos/org/repo", "") + url.search;
      const method = init.method ?? "GET";
      calls.push({ method, path, body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined });
      const r = routes[`${method} ${path}`] ?? { status: 404, body: { message: "Not Found" } };
      return Promise.resolve(new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status }));
    };
    return { client: new GithubConfigClient("org/repo", "t0ken", fetchImpl), calls };
  }

  it("reads owner type, emptiness, managed rulesets and CODEOWNERS", async () => {
    const { client, calls } = fakeGithub({
      "GET ": { status: 200, body: { owner: { type: "Organization" } } },
      "GET /commits?per_page=1": { status: 200, body: [] },
      "GET /rulesets?includes_parents=false&per_page=100": { status: 200, body: [{ id: 7 }] },
      "GET /rulesets/7": { status: 200, body: { id: 7, name: "adlc-tags", target: "tag", enforcement: "active", node_id: "x", bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }], conditions: { ref_name: { include: ["~ALL"] } }, rules: [{ type: "deletion" }] } },
      "GET /contents/.github/CODEOWNERS": { status: 200, body: { content: Buffer.from("* @a\n").toString("base64") } },
    });
    expect(await client.readState()).toEqual({
      ownerType: "Organization",
      empty: false,
      rulesets: [{ id: 7, name: "adlc-tags", target: "tag", enforcement: "active", bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }], conditions: { ref_name: { include: ["~ALL"], exclude: [] } }, rules: [{ type: "deletion" }] }],
      codeowners: "* @a\n",
    });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("an empty repository answers 409 on commits; other errors are typed", async () => {
    const { client } = fakeGithub({ "GET ": { status: 200, body: { owner: { type: "User" } } }, "GET /commits?per_page=1": { status: 409, body: { message: "Git Repository is empty." } }, "GET /rulesets?includes_parents=false&per_page=100": { status: 200, body: [] } });
    expect(await client.readState()).toMatchObject({ ownerType: "User", empty: true, codeowners: null });
    const { client: denied } = fakeGithub({ "GET ": { status: 403, body: { message: "Resource not accessible" } } });
    await expect(denied.readState()).rejects.toEqual(expect.objectContaining({ name: "GithubApiError", status: 403 }));
    expect(new GithubApiError("x", 500).status).toBe(500);
  });

  it("FR-GH-001 apply runs bootstrap first, then rulesets; a blocked plan changes nothing", async () => {
    const config = await load();
    const plan = planGithub(config, { ...org, empty: true }, { ci: 42 });
    const { client, calls } = fakeGithub({ "PUT /contents/.github/CODEOWNERS": { status: 201, body: {} }, "POST /rulesets": { status: 201, body: {} } });
    expect(await client.apply(plan)).toEqual(["created main", "created ruleset adlc-main", "created ruleset adlc-agent-branches", "created ruleset adlc-other-branches", "created ruleset adlc-tags"]);
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/contents/.github/CODEOWNERS", body: { branch: "main" } });

    const blocked = fakeGithub({});
    await expect(blocked.client.apply(planGithub(config, { ...org, ownerType: "User" }, { ci: 42 }))).rejects.toBeInstanceOf(PlanBlockedError);
    expect(blocked.calls).toEqual([]);
  });

  it("FR-GH-001 apply updates and deletes managed rulesets by id", async () => {
    const config = await load();
    const tags = renderRulesets(config, { ci: 42 }, { mergeQueue: true })[3] as RulesetBody;
    const { client, calls } = fakeGithub({ "PUT /rulesets/4": { status: 200, body: {} }, "DELETE /rulesets/5": { status: 204 } });
    const done = await client.apply({ repo: "org/repo", actions: [{ kind: "update-ruleset", id: 4, body: tags, changed: ["rules"] }, { kind: "delete-ruleset", id: 5, name: "adlc-legacy" }], unchanged: [], unmanaged: [], manual: [], blockers: [], warnings: [] });
    expect(done).toEqual(["updated ruleset adlc-tags", "deleted ruleset adlc-legacy"]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /rulesets/4", "DELETE /rulesets/5"]);
  });
});
