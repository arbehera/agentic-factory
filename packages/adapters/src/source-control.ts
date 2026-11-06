/**
 * SourceControl port (spec.md §7): implemented by the GitHub App client with a per-task
 * installation token held by the gateway. There is deliberately no merge, approve, delete-branch,
 * force-push or settings operation: an agent-facing path to them must not exist (hard rule 3).
 *
 * The real client is written with sandbox access (plan Q-04); tests use the fake in
 * `@adlc/testing`.
 */

export interface FileContent {
  path: string;
  content: string;
  sha: string;
}

export interface FileChange {
  path: string;
  content: string;
}

export interface CheckStatus {
  context: string;
  state: "pending" | "success" | "failure" | "error";
}

export interface PullRequest {
  number: number;
  head: string;
  base: string;
  headSha: string;
  /** Merged by the merge queue after human approval; agents and the platform never merge. */
  merged: boolean;
}

export interface CommitStatusInput {
  context: string;
  state: CheckStatus["state"];
  description: string;
  targetUrl?: string;
}

export interface SourceControl {
  getFile(repo: string, ref: string, path: string): Promise<FileContent | null>;
  /** Returns the branch head SHA. */
  getBranch(repo: string, branch: string): Promise<string | null>;
  createBranch(repo: string, branch: string, fromRef: string): Promise<{ sha: string }>;
  /** Fails with BranchMovedError if the branch head is not `parentSha` (no blind overwrite). */
  commit(repo: string, branch: string, change: { files: FileChange[]; message: string; parentSha: string }): Promise<{ sha: string }>;
  openPullRequest(repo: string, pr: { head: string; base: string; title: string; body: string }): Promise<{ number: number; headSha: string }>;
  commentOnPullRequest(repo: string, prNumber: number, body: string): Promise<void>;
  checkStatuses(repo: string, sha: string): Promise<CheckStatus[]>;
  getPullRequest(repo: string, prNumber: number): Promise<PullRequest | null>;
  /** The most recent pull request from `head` (open or merged), or null. Read-only. */
  findPullRequest(repo: string, head: string): Promise<PullRequest | null>;
  /**
   * Posts a commit status (e.g. adlc/verify, adlc/evidence). Used by CI and the signer under their
   * own identities; no agent tool exposes it. Re-posting the same status is safe.
   */
  setCommitStatus(repo: string, sha: string, status: CommitStatusInput): Promise<void>;
}

export class BranchMovedError extends Error {
  override name = "BranchMovedError";
}
