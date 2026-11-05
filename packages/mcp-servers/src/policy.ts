import picomatch from "picomatch";
import { deny, type ToolContext } from "./tool.js";

/**
 * Deterministic policy checks shared by the tools (SDD §11.2: "None of these limits relies on
 * prompts"). Platform invariants are checked here regardless of what a role policy says.
 */

const PROTECTED_BRANCHES = new Set(["main", "master"]);

export function assertProjectIssue(ctx: ToolContext, key: string): void {
  if (!key.startsWith(`${ctx.run.jiraProjectKey}-`)) deny(`issue ${key} is outside project ${ctx.run.jiraProjectKey}`);
}

export function assertOwnTask(ctx: ToolContext, key: string): void {
  if (ctx.run.taskKey === null || key !== ctx.run.taskKey) deny(`only the run's own task (${ctx.run.taskKey ?? "none"}) may be changed`);
}

export function assertRepo(ctx: ToolContext, repo: string): void {
  if (!ctx.run.repos.includes(repo)) deny(`repository ${repo} is not part of this project`);
}

/** Branches this run may write: the policy's patterns with `{taskKey}` resolved. */
export function writableBranches(ctx: ToolContext): string[] {
  return ctx.policy.github.branches.flatMap((b) => {
    if (!b.includes("{taskKey}")) return [b];
    return ctx.run.taskKey ? [b.split("{taskKey}").join(ctx.run.taskKey)] : [];
  });
}

export function assertWritableBranch(ctx: ToolContext, branch: string): void {
  if (PROTECTED_BRANCHES.has(branch)) deny(`agents never write ${branch}`);
  if (!/^(task|spec)\//.test(branch)) deny(`agents write only task/* or spec/* branches, not ${branch}`);
  if (!writableBranches(ctx).includes(branch)) deny(`branch ${branch} is not writable by role ${ctx.policy.role}`);
}

export function assertWritablePaths(ctx: ToolContext, paths: readonly string[]): void {
  const allowed = picomatch(ctx.policy.github.writePaths.length > 0 ? ctx.policy.github.writePaths : ["\0none"], { dot: true });
  const blocked = picomatch(ctx.policy.github.blockedPaths.length > 0 ? ctx.policy.github.blockedPaths : ["\0none"], { dot: true });
  for (const p of paths) {
    if (p.startsWith("/") || p.split("/").some((seg) => seg === ".." || seg === "." || seg === "") || p.includes("\\")) {
      deny(`invalid path ${p}`);
    }
    if (blocked(p)) deny(`path ${p} is blocked for role ${ctx.policy.role}`);
    if (!allowed(p)) deny(`path ${p} is outside the write paths of role ${ctx.policy.role}`);
  }
}
