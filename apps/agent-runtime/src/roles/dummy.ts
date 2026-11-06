import type { Logger } from "@adlc/telemetry";
import type { GatewayClient } from "../gateway-client.js";

/**
 * The Phase 0 "dummy agent" (P0-WP4): deterministic, no model calls. It exercises the platform
 * path an agent takes — read the task, create the task branch, commit one file, open a PR, report
 * on the issue — through the gateway only. Each step is safe to repeat, so a run that resumes on
 * the task's existing branch (after a crash, AT-P0-03) continues where the last one stopped.
 *
 * Issue text is untrusted data (hard rule 10): it is written into the file, never interpreted.
 */

export interface DummyContext {
  runId: string;
  taskKey: string;
  repo: string;
  /** Checked between steps: true when the run must stop (kill switch, budget, lost lease). */
  shouldStop: () => boolean;
  logger: Logger;
  /** Simulated work after the commit (load test only); checked against the stop directive each second. */
  workMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type DummyOutcome = { status: "done"; pr: number } | { status: "stopped"; afterStep: string };

interface Issue {
  key: string;
  summary: string;
}
interface FileContent {
  content: string;
}

export function dummyFilePath(taskKey: string): string {
  return `docs/dummy/${taskKey}.md`;
}

export function dummyFileContent(issue: Issue, runId: string): string {
  return `# ${issue.key}\n\n${issue.summary}\n\nWritten by the ADLC dummy agent (run ${runId}).\n`;
}

export async function runDummy(gw: GatewayClient, ctx: DummyContext): Promise<DummyOutcome> {
  const branch = `task/${ctx.taskKey}`;
  const step = (name: string) => {
    ctx.logger.info({ step: name }, "step done");
    return ctx.shouldStop() ? ({ status: "stopped", afterStep: name } as const) : null;
  };

  const issue = await gw.tool<Issue>("jira", "read_issue", { key: ctx.taskKey });
  const s1 = step("read-task");
  if (s1) return s1;

  let head = (await gw.tool<{ sha: string | null }>("github", "get_branch", { repo: ctx.repo, branch })).sha;
  head ??= (await gw.tool<{ sha: string }>("github", "create_branch", { repo: ctx.repo, branch, from: "main" })).sha;
  const s2 = step("branch");
  if (s2) return s2;

  const path = dummyFilePath(ctx.taskKey);
  const content = dummyFileContent(issue, ctx.runId);
  const existing = await gw.tool<FileContent | null>("github", "read_file", { repo: ctx.repo, ref: branch, path });
  if (existing?.content !== content) {
    await gw.tool("github", "commit_files", { repo: ctx.repo, branch, parentSha: head, message: `${ctx.taskKey}: dummy change`, files: [{ path, content }] });
  }
  const s3 = step("commit"); // the WIP is on the task branch from here on
  if (s3) return s3;

  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let left = ctx.workMs ?? 0; left > 0; left -= 1_000) {
    await sleep(Math.min(1_000, left));
    if (ctx.shouldStop()) return { status: "stopped", afterStep: "work" };
  }

  const pr = await gw.tool<{ number: number }>("github", "open_pull_request", {
    repo: ctx.repo,
    branch,
    title: `${ctx.taskKey}: dummy change`,
    body: `Opened by the ADLC dummy agent (run ${ctx.runId}) for ${ctx.taskKey}.`,
  });
  await gw.tool("jira", "comment", { key: ctx.taskKey, body: `Pull request #${pr.number} opened by run ${ctx.runId}.` });
  step("pull-request");
  return { status: "done", pr: pr.number };
}
