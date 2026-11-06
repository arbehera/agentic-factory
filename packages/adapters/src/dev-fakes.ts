import { IssueConflictError, IssueNotFoundError, type Issue, type IssueTracker, type NewIssue } from "./issue-tracker.js";
import { BranchMovedError, type CheckStatus, type CommitStatusInput, type FileChange, type FileContent, type PullRequest, type SourceControl } from "./source-control.js";

/**
 * HTTP clients for the dev-fakes service (`apps/dev-fakes`), used by the Compose stack and the
 * end-to-end tests so every service shares one fake Jira and one fake GitHub. They implement the
 * same ports as the real clients; the typed port errors survive the round trip because the
 * service returns the error name and the client rebuilds it.
 *
 * Never a production adapter: `createAdapters` only builds them when `ADAPTERS=dev-fakes` is
 * set explicitly.
 */

export class DevFakesError extends Error {
  override name = "DevFakesError";
}

const PORT_ERRORS: Record<string, new (message: string) => Error> = {
  IssueConflictError,
  IssueNotFoundError,
  BranchMovedError,
};

export class DevFakesClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<T>(path: string, args: unknown[]): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ args }),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { name?: unknown; message?: unknown } } | null;
    if (res.ok && body && "result" in body) return body.result as T;
    const name = typeof body?.error?.name === "string" ? body.error.name : "";
    const message = typeof body?.error?.message === "string" ? body.error.message : `dev-fakes ${path} failed with HTTP ${res.status}`;
    const Known = PORT_ERRORS[name];
    throw Known ? new Known(message) : new DevFakesError(message);
  }
}

export class DevFakesIssueTracker implements IssueTracker {
  constructor(private readonly client: DevFakesClient) {}
  getIssue(key: string): Promise<Issue> {
    return this.client.call("jira/getIssue", [key]);
  }
  search(jql: string, limit: number): Promise<Issue[]> {
    return this.client.call("jira/search", [jql, limit]);
  }
  createIssue(input: NewIssue): Promise<Issue> {
    return this.client.call("jira/createIssue", [input]);
  }
  addComment(key: string, body: string): Promise<{ id: string }> {
    return this.client.call("jira/addComment", [key, body]);
  }
  transition(key: string, toStatus: string, expectedVersion: string): Promise<Issue> {
    return this.client.call("jira/transition", [key, toStatus, expectedVersion]);
  }
  link(fromKey: string, toKey: string, type: string): Promise<void> {
    return this.client.call("jira/link", [fromKey, toKey, type]);
  }
}

export class DevFakesSourceControl implements SourceControl {
  constructor(private readonly client: DevFakesClient) {}
  getFile(repo: string, ref: string, path: string): Promise<FileContent | null> {
    return this.client.call("github/getFile", [repo, ref, path]);
  }
  getBranch(repo: string, branch: string): Promise<string | null> {
    return this.client.call("github/getBranch", [repo, branch]);
  }
  createBranch(repo: string, branch: string, fromRef: string): Promise<{ sha: string }> {
    return this.client.call("github/createBranch", [repo, branch, fromRef]);
  }
  commit(repo: string, branch: string, change: { files: FileChange[]; message: string; parentSha: string }): Promise<{ sha: string }> {
    return this.client.call("github/commit", [repo, branch, change]);
  }
  openPullRequest(repo: string, pr: { head: string; base: string; title: string; body: string }): Promise<{ number: number; headSha: string }> {
    return this.client.call("github/openPullRequest", [repo, pr]);
  }
  commentOnPullRequest(repo: string, prNumber: number, body: string): Promise<void> {
    return this.client.call("github/commentOnPullRequest", [repo, prNumber, body]);
  }
  checkStatuses(repo: string, sha: string): Promise<CheckStatus[]> {
    return this.client.call("github/checkStatuses", [repo, sha]);
  }
  getPullRequest(repo: string, prNumber: number): Promise<PullRequest | null> {
    return this.client.call("github/getPullRequest", [repo, prNumber]);
  }
  findPullRequest(repo: string, head: string): Promise<PullRequest | null> {
    return this.client.call("github/findPullRequest", [repo, head]);
  }
  setCommitStatus(repo: string, sha: string, status: CommitStatusInput): Promise<void> {
    return this.client.call("github/setCommitStatus", [repo, sha, status]);
  }
}

export class AdapterUnavailableError extends Error {
  override name = "AdapterUnavailableError";
}

export interface AdapterSettings {
  /** No default on purpose: a deployment names its adapters explicitly. */
  ADAPTERS?: string | undefined;
  FAKES_URL?: string | undefined;
  FAKES_TOKEN?: string | undefined;
}

/**
 * Builds the IssueTracker and SourceControl a service uses. `jira-github` is the production
 * choice; its clients are written once sandbox access exists (plan Q-04), so until then it refuses
 * to start rather than run half-configured.
 */
export function createAdapters(settings: AdapterSettings, fetchImpl: typeof fetch = fetch): { issues: IssueTracker; scm: SourceControl } {
  switch (settings.ADAPTERS) {
    case "dev-fakes": {
      if (!settings.FAKES_URL || !settings.FAKES_TOKEN) throw new AdapterUnavailableError("ADAPTERS=dev-fakes needs FAKES_URL and FAKES_TOKEN");
      const client = new DevFakesClient(settings.FAKES_URL, settings.FAKES_TOKEN, fetchImpl);
      return { issues: new DevFakesIssueTracker(client), scm: new DevFakesSourceControl(client) };
    }
    case "jira-github":
      throw new AdapterUnavailableError("the Jira and GitHub clients are not available until sandbox access exists (plan Q-04)");
    default:
      throw new AdapterUnavailableError(`ADAPTERS must be "dev-fakes" or "jira-github", got ${JSON.stringify(settings.ADAPTERS ?? null)}`);
  }
}
