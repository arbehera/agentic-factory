import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Issue } from "@adlc/adapters";
import { FakeIssueTracker } from "./fake-issue-tracker.js";
import { FakeSourceControl } from "./fake-source-control.js";

/**
 * Serves the in-memory fakes over HTTP for the Compose stack and end-to-end tests (P0-WP11). The
 * `DevFakes*` clients in `@adlc/adapters` call it.
 *
 * - `POST /jira/<method>` and `POST /github/<method>` run a port method, body `{ "args": [...] }`.
 *   Only port methods are reachable, so services see exactly what a real client offers.
 * - `POST /admin/<op>` stands in for humans and set-up (seed issues and repos, edit an issue, push
 *   to a branch) and `GET /admin/state` returns everything for test assertions.
 *
 * Every request needs the shared bearer token. Errors return `{ error: { name, message } }`.
 */

const JIRA_METHODS = ["getIssue", "search", "createIssue", "addComment", "transition", "link"] as const;
const GITHUB_METHODS = ["getFile", "getBranch", "createBranch", "commit", "openPullRequest", "commentOnPullRequest", "checkStatuses", "getPullRequest", "setCommitStatus"] as const;

const ERROR_STATUS: Record<string, number> = { IssueNotFoundError: 404, IssueConflictError: 409, BranchMovedError: 409, BadRequest: 400 };

class BadRequest extends Error {
  override name = "BadRequest";
}

export interface FakesState {
  issues: Issue[];
  comments: { key: string; body: string }[];
  pullRequests: FakeSourceControl["pullRequests"];
  statuses: FakeSourceControl["postedStatuses"];
}

export function createFakesServer(options: { token: string; issues?: FakeIssueTracker; scm?: FakeSourceControl }): { server: Server; issues: FakeIssueTracker; scm: FakeSourceControl } {
  const issues = options.issues ?? new FakeIssueTracker();
  const scm = options.scm ?? new FakeSourceControl();
  const expected = Buffer.from(`Bearer ${options.token}`);

  const admin: Record<string, (args: unknown[]) => unknown> = {
    seedIssue: ([issue]) => issues.seed(issue as Omit<Issue, "version">),
    humanEdit: ([key, patch]) => {
      issues.humanEdit(String(key), patch as Partial<Omit<Issue, "key" | "version">>);
      return issues.issues.get(String(key));
    },
    seedRepo: ([repo, files]) => scm.seedRepo(String(repo), files as Record<string, string>),
    pushAsHuman: ([repo, branch, files]) => scm.pushAsHuman(String(repo), String(branch), files as Record<string, string>),
  };

  const state = (): FakesState => ({ issues: [...issues.issues.values()], comments: issues.comments, pullRequests: scm.pullRequests, statuses: scm.postedStatuses });

  async function route(req: IncomingMessage): Promise<unknown> {
    const [, area, op] = (req.url ?? "").split("?")[0]?.split("/") ?? [];
    if (req.method === "GET" && area === "admin" && op === "state") return state();
    if (req.method !== "POST" || !area || !op) throw new BadRequest(`no route ${req.method ?? ""} ${req.url ?? ""}`);
    const args = await readArgs(req);
    if (area === "jira" && (JIRA_METHODS as readonly string[]).includes(op)) {
      return (issues[op as (typeof JIRA_METHODS)[number]] as (...a: unknown[]) => Promise<unknown>).apply(issues, args);
    }
    if (area === "github" && (GITHUB_METHODS as readonly string[]).includes(op)) {
      return (scm[op as (typeof GITHUB_METHODS)[number]] as (...a: unknown[]) => Promise<unknown>).apply(scm, args);
    }
    const adminOp = area === "admin" ? admin[op] : undefined;
    if (adminOp) return adminOp(args);
    throw new BadRequest(`unknown operation ${area}/${op}`);
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/health") {
      send(200, { status: "ok" });
      return;
    }
    const given = Buffer.from(req.headers.authorization ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      send(401, { error: { name: "Unauthenticated", message: "missing or wrong token" } });
      return;
    }
    route(req)
      .then((result) => {
        send(200, { result: result ?? null });
      })
      .catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        send(ERROR_STATUS[e.name] ?? 500, { error: { name: e.name, message: e.message } });
      });
  });
  return { server, issues, scm };
}

async function readArgs(req: IncomingMessage): Promise<unknown[]> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new BadRequest("request body too large");
    chunks.push(chunk as Buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new BadRequest("body is not JSON");
  }
  const args = (body as { args?: unknown }).args ?? [];
  if (!Array.isArray(args)) throw new BadRequest("args must be an array");
  return args as unknown[];
}
