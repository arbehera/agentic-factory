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
}

export class BranchMovedError extends Error {
  override name = "BranchMovedError";
}
