import { createHash } from "node:crypto";
import { BranchMovedError, type CheckStatus, type CommitStatusInput, type FileChange, type FileContent, type PullRequest, type SourceControl } from "@adlc/adapters";

interface Commit {
  sha: string;
  parent: string | null;
  files: Map<string, string>;
}

/**
 * In-memory SourceControl (CLAUDE.md §7): branches, commits, PRs and statuses. It does not
 * model GitHub rulesets — those are proven in the sandbox (AT-P0-04). `calls` records every
 * operation so tests can assert a denied request never reached GitHub.
 */
export class FakeSourceControl implements SourceControl {
  readonly calls: string[] = [];
  readonly pullRequests: { repo: string; number: number; head: string; base: string; title: string; body: string }[] = [];
  readonly prComments: { repo: string; number: number; body: string }[] = [];
  readonly statuses = new Map<string, CheckStatus[]>();
  private readonly commits = new Map<string, Commit>();
  private readonly branches = new Map<string, string>();

  /** Creates `repo` with a `main` branch holding `files`. */
  seedRepo(repo: string, files: Record<string, string>): string {
    const sha = this.store(null, new Map(Object.entries(files)));
    this.branches.set(`${repo}:main`, sha);
    return sha;
  }

  getFile(repo: string, ref: string, path: string): Promise<FileContent | null> {
    this.calls.push(`getFile ${repo} ${ref} ${path}`);
    const commit = this.commits.get(this.branches.get(`${repo}:${ref}`) ?? ref);
    const content = commit?.files.get(path);
    return Promise.resolve(commit && content !== undefined ? { path, content, sha: commit.sha } : null);
  }

  getBranch(repo: string, branch: string): Promise<string | null> {
    this.calls.push(`getBranch ${repo} ${branch}`);
    return Promise.resolve(this.branches.get(`${repo}:${branch}`) ?? null);
  }

  createBranch(repo: string, branch: string, fromRef: string): Promise<{ sha: string }> {
    this.calls.push(`createBranch ${repo} ${branch}`);
    const sha = this.branches.get(`${repo}:${fromRef}`) ?? (this.commits.has(fromRef) ? fromRef : undefined);
    if (!sha) return Promise.reject(new Error(`unknown ref ${fromRef}`));
    if (this.branches.has(`${repo}:${branch}`)) return Promise.reject(new Error(`branch ${branch} exists`));
    this.branches.set(`${repo}:${branch}`, sha);
    return Promise.resolve({ sha });
  }

  commit(repo: string, branch: string, change: { files: FileChange[]; message: string; parentSha: string }): Promise<{ sha: string }> {
    this.calls.push(`commit ${repo} ${branch}`);
    const head = this.branches.get(`${repo}:${branch}`);
    if (head !== change.parentSha) return Promise.reject(new BranchMovedError(`${branch} is at ${head ?? "nothing"}, not ${change.parentSha}`));
    const files = new Map(this.commits.get(head)?.files);
    for (const f of change.files) files.set(f.path, f.content);
    const sha = this.store(head, files);
    this.branches.set(`${repo}:${branch}`, sha);
    return Promise.resolve({ sha });
  }

  openPullRequest(repo: string, pr: { head: string; base: string; title: string; body: string }): Promise<{ number: number; headSha: string }> {
    this.calls.push(`openPullRequest ${repo} ${pr.head}`);
    const headSha = this.branches.get(`${repo}:${pr.head}`);
    if (!headSha) return Promise.reject(new Error(`unknown branch ${pr.head}`));
    const number = this.pullRequests.length + 1;
    this.pullRequests.push({ repo, number, ...pr });
    return Promise.resolve({ number, headSha });
  }

  commentOnPullRequest(repo: string, prNumber: number, body: string): Promise<void> {
    this.calls.push(`commentOnPullRequest ${repo} ${prNumber}`);
    if (!this.pullRequests.some((p) => p.repo === repo && p.number === prNumber)) return Promise.reject(new Error(`no PR ${prNumber}`));
    this.prComments.push({ repo, number: prNumber, body });
    return Promise.resolve();
  }

  checkStatuses(repo: string, sha: string): Promise<CheckStatus[]> {
    this.calls.push(`checkStatuses ${repo} ${sha}`);
    return Promise.resolve(this.statuses.get(sha) ?? []);
  }

  getPullRequest(repo: string, prNumber: number): Promise<PullRequest | null> {
    this.calls.push(`getPullRequest ${repo} ${prNumber}`);
    const pr = this.pullRequests.find((p) => p.repo === repo && p.number === prNumber);
    if (!pr) return Promise.resolve(null);
    return Promise.resolve({ number: pr.number, head: pr.head, base: pr.base, headSha: this.branches.get(`${repo}:${pr.head}`) ?? "" });
  }

  /** Status history per commit; the latest status per context wins, as on GitHub. */
  readonly postedStatuses: { repo: string; sha: string; status: CommitStatusInput }[] = [];

  setCommitStatus(repo: string, sha: string, status: CommitStatusInput): Promise<void> {
    this.calls.push(`setCommitStatus ${repo} ${sha} ${status.context}=${status.state}`);
    this.postedStatuses.push({ repo, sha, status });
    const current = (this.statuses.get(sha) ?? []).filter((s) => s.context !== status.context);
    this.statuses.set(sha, [...current, { context: status.context, state: status.state }]);
    return Promise.resolve();
  }

  /** Test control: push a commit to a branch as a human would (moves the PR head). */
  pushAsHuman(repo: string, branch: string, files: Record<string, string>): string {
    const head = this.branches.get(`${repo}:${branch}`) ?? null;
    const merged = new Map(head ? this.commits.get(head)?.files : undefined);
    for (const [k, v] of Object.entries(files)) merged.set(k, v);
    const sha = this.store(head, merged);
    this.branches.set(`${repo}:${branch}`, sha);
    return sha;
  }

  private store(parent: string | null, files: Map<string, string>): string {
    const sha = createHash("sha1").update(`${parent ?? ""}:${this.commits.size}:${JSON.stringify([...files])}`).digest("hex");
    this.commits.set(sha, { sha, parent, files });
    return sha;
  }
}
