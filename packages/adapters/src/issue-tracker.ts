/**
 * IssueTracker port (spec.md §7): the Jira Cloud REST v3 client implements it per identity
 * (`adlc-orchestrator`, `adlc-agent`). Callers never see credentials: an instance is built
 * with them inside the gateway or orchestrator (hard rule 9).
 *
 * The real client is written with sandbox access (plan Q-04); tests use the fake in
 * `@adlc/testing`.
 */

export interface Issue {
  key: string;
  type: string;
  status: string;
  summary: string;
  description: string;
  /** Latest changelog ID: re-read before every write; a change means a human edited it (FR-JIRA-002). */
  version: string;
}

export interface NewIssue {
  projectKey: string;
  type: string;
  summary: string;
  description: string;
  /** Idempotency key, e.g. `<feature>/<T###>` (FR-IMP-003). */
  externalId?: string;
}

export interface IssueTracker {
  getIssue(key: string): Promise<Issue>;
  search(jql: string, limit: number): Promise<Issue[]>;
  createIssue(input: NewIssue): Promise<Issue>;
  addComment(key: string, body: string): Promise<{ id: string }>;
  /** Fails with IssueConflictError if the issue changed since `expectedVersion`. */
  transition(key: string, toStatus: string, expectedVersion: string): Promise<Issue>;
  link(fromKey: string, toKey: string, type: string): Promise<void>;
}

export class IssueNotFoundError extends Error {
  override name = "IssueNotFoundError";
}

/** The issue changed between read and write; the human change wins (FR-JIRA-002). */
export class IssueConflictError extends Error {
  override name = "IssueConflictError";
}
