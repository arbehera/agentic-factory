import { IssueConflictError, IssueNotFoundError, type Issue, type IssueTracker, type NewIssue } from "@adlc/adapters";

/**
 * In-memory IssueTracker (CLAUDE.md §7). It stores issues and enforces optimistic versions;
 * it does not model Jira workflow permissions — those are proven in the sandbox (AT-P0-04).
 * `calls` records every operation so tests can assert a denied request never reached Jira.
 */
export class FakeIssueTracker implements IssueTracker {
  readonly issues = new Map<string, Issue>();
  readonly comments: { key: string; body: string }[] = [];
  readonly links: { from: string; to: string; type: string }[] = [];
  readonly calls: string[] = [];
  private seq = 0;
  private version = 0;

  seed(issue: Omit<Issue, "version">): Issue {
    const full = { ...issue, version: String(++this.version) };
    this.issues.set(issue.key, full);
    return full;
  }

  /** Simulates a human editing the issue (bumps its changelog version). */
  humanEdit(key: string, patch: Partial<Omit<Issue, "key" | "version">>): void {
    const issue = this.must(key);
    this.issues.set(key, { ...issue, ...patch, version: String(++this.version) });
  }

  getIssue(key: string): Promise<Issue> {
    this.calls.push(`getIssue ${key}`);
    return Promise.resolve(this.must(key));
  }

  search(jql: string, limit: number): Promise<Issue[]> {
    this.calls.push(`search ${jql}`);
    // The subset of JQL the platform uses: `project = X`, `status = "S"`, `status in ("S", ...)`;
    // results in creation order. Filtering statuses here matters: without it, old issues fill the
    // result window and newer matching ones are never returned (found by the AT-P0-06 drill).
    const project = /project = ([A-Z][A-Z0-9]*)/.exec(jql)?.[1];
    const one = /status = "([^"]+)"/.exec(jql)?.[1];
    const many = /status in \(([^)]*)\)/.exec(jql)?.[1];
    const statuses = one ? [one] : many ? [...many.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "") : null;
    return Promise.resolve(
      [...this.issues.values()].filter((i) => (!project || i.key.startsWith(`${project}-`)) && (!statuses || statuses.includes(i.status))).slice(0, limit),
    );
  }

  createIssue(input: NewIssue): Promise<Issue> {
    this.calls.push(`createIssue ${input.type}`);
    if (input.externalId) {
      const existing = [...this.issues.values()].find((i) => i.description.includes(`externalId:${input.externalId}`));
      if (existing) return Promise.resolve(existing);
    }
    const key = `${input.projectKey}-${String(++this.seq + 1000)}`;
    return Promise.resolve(
      this.seed({ key, type: input.type, status: "To Do", summary: input.summary, description: input.externalId ? `${input.description}\nexternalId:${input.externalId}` : input.description }),
    );
  }

  addComment(key: string, body: string): Promise<{ id: string }> {
    this.calls.push(`addComment ${key}`);
    this.must(key);
    this.comments.push({ key, body });
    return Promise.resolve({ id: String(this.comments.length) });
  }

  transition(key: string, toStatus: string, expectedVersion: string): Promise<Issue> {
    this.calls.push(`transition ${key} ${toStatus}`);
    const issue = this.must(key);
    if (issue.version !== expectedVersion) return Promise.reject(new IssueConflictError(`${key} changed (version ${issue.version} != ${expectedVersion})`));
    const updated = { ...issue, status: toStatus, version: String(++this.version) };
    this.issues.set(key, updated);
    return Promise.resolve(updated);
  }

  link(fromKey: string, toKey: string, type: string): Promise<void> {
    this.calls.push(`link ${fromKey} ${toKey}`);
    this.must(fromKey);
    this.must(toKey);
    this.links.push({ from: fromKey, to: toKey, type });
    return Promise.resolve();
  }

  private must(key: string): Issue {
    const issue = this.issues.get(key);
    if (!issue) throw new IssueNotFoundError(`${key} not found`);
    return issue;
  }
}
