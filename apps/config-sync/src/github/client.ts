import { CODEOWNERS_PATH, normalizeRuleset, type GithubAction, type GithubActualState, type GithubPlan } from "./plan.js";

export class GithubApiError extends Error {
  override name = "GithubApiError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class PlanBlockedError extends Error {
  override name = "PlanBlockedError";
}

/**
 * GitHub REST client for configuration-as-code, used by a human operator with an admin token
 * (never by an agent, the gateway or the portal: hard rule 3). Reads are safe to repeat; `apply`
 * runs only a reviewed plan with no blockers.
 */
export class GithubConfigClient {
  private readonly owner: string;
  private readonly name: string;

  constructor(
    private readonly repo: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly api = "https://api.github.com",
  ) {
    const [owner, name] = repo.split("/");
    if (!owner || !name) throw new Error(`invalid repository ${repo}`);
    this.owner = owner;
    this.name = name;
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.fetchImpl(`${this.api}/repos/${this.owner}/${this.name}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : null;
    return { status: res.status, json };
  }

  private async ok(method: string, path: string, body?: unknown): Promise<unknown> {
    const r = await this.call(method, path, body);
    if (r.status >= 300) throw new GithubApiError(`${method} ${path}: HTTP ${r.status} ${(r.json as { message?: string } | null)?.message ?? ""}`.trim(), r.status);
    return r.json;
  }

  async readState(): Promise<GithubActualState> {
    const repo = (await this.ok("GET", "")) as { owner: { type: "User" | "Organization" } };
    // An empty repository answers 409 on its commit list.
    const commits = await this.call("GET", "/commits?per_page=1");
    if (commits.status >= 300 && commits.status !== 409) throw new GithubApiError(`GET /commits: HTTP ${commits.status}`, commits.status);
    const empty = commits.status === 409;
    const list = (await this.ok("GET", "/rulesets?includes_parents=false&per_page=100")) as { id: number }[];
    const rulesets = [];
    for (const r of list) rulesets.push(normalizeRuleset((await this.ok("GET", `/rulesets/${r.id}`)) as Record<string, unknown>));
    let codeowners: string | null = null;
    if (!empty) {
      const c = await this.call("GET", `/contents/${CODEOWNERS_PATH}`);
      if (c.status === 200) codeowners = Buffer.from((c.json as { content: string }).content, "base64").toString("utf8");
      else if (c.status !== 404) throw new GithubApiError(`GET contents: HTTP ${c.status}`, c.status);
    }
    return { ownerType: repo.owner.type, empty, rulesets, codeowners };
  }

  /** Applies a plan in order: bootstrap first (before main is locked), then rulesets. */
  async apply(plan: GithubPlan): Promise<string[]> {
    if (plan.blockers.length > 0) throw new PlanBlockedError(`plan has blockers; resolve them in the manifest first:\n- ${plan.blockers.join("\n- ")}`);
    const done: string[] = [];
    for (const a of plan.actions) done.push(await this.applyOne(a));
    return done;
  }

  private async applyOne(a: GithubAction): Promise<string> {
    switch (a.kind) {
      case "bootstrap-default-branch":
        for (const f of a.files) {
          await this.ok("PUT", `/contents/${f.path}`, { message: `chore: add ${f.path} (config-sync, FR-GH-001)`, content: Buffer.from(f.content, "utf8").toString("base64"), branch: a.branch });
        }
        return `created ${a.branch}`;
      case "create-ruleset":
        await this.ok("POST", "/rulesets", a.body);
        return `created ruleset ${a.body.name}`;
      case "update-ruleset":
        await this.ok("PUT", `/rulesets/${a.id}`, a.body);
        return `updated ruleset ${a.body.name}`;
      case "delete-ruleset":
        await this.ok("DELETE", `/rulesets/${a.id}`);
        return `deleted ruleset ${a.name}`;
    }
  }
}
