import { z } from "zod";
import { assertRepo, assertWritableBranch, assertWritablePaths } from "./policy.js";
import { defineTool, type ToolDef } from "./tool.js";

/**
 * `github` MCP server (SDD §11.1). Reads at a ref; writes only to the role's task/spec branches
 * and write paths; PRs always target main. There is no merge, approve, delete or force tool.
 */

const repo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const ref = z.string().min(1).max(255);
const sha = z.string().regex(/^[0-9a-f]{7,64}$/);
const MAX_FILE_BYTES = 1_000_000;

export const githubTools: ToolDef[] = [
  defineTool({
    server: "github",
    name: "read_file",
    description: "Read a file at a branch, tag or commit SHA.",
    input: z.strictObject({ repo, ref, path: z.string().min(1).max(1000) }),
    taskWrite: false,
    handle: (ctx, a, d) => {
      assertRepo(ctx, a.repo);
      return d.github.getFile(a.repo, a.ref, a.path);
    },
  }),
  defineTool({
    server: "github",
    name: "get_branch",
    description: "Get the head commit SHA of a branch (null if it does not exist).",
    input: z.strictObject({ repo, branch: ref }),
    taskWrite: false,
    handle: async (ctx, a, d) => {
      assertRepo(ctx, a.repo);
      return { branch: a.branch, sha: await d.github.getBranch(a.repo, a.branch) };
    },
  }),
  defineTool({
    server: "github",
    name: "create_branch",
    description: "Create your task branch from main (or another ref).",
    input: z.strictObject({ repo, branch: ref, from: ref.default("main") }),
    taskWrite: true,
    handle: (ctx, a, d) => {
      assertRepo(ctx, a.repo);
      assertWritableBranch(ctx, a.branch);
      return d.github.createBranch(a.repo, a.branch, a.from);
    },
  }),
  defineTool({
    server: "github",
    name: "commit_files",
    description: "Commit file changes to your branch. parentSha must be the current branch head.",
    input: z.strictObject({
      repo,
      branch: ref,
      message: z.string().min(1).max(5000),
      parentSha: sha,
      files: z.array(z.strictObject({ path: z.string().min(1).max(1000), content: z.string().max(MAX_FILE_BYTES) })).min(1).max(50),
    }),
    taskWrite: true,
    handle: (ctx, a, d) => {
      assertRepo(ctx, a.repo);
      assertWritableBranch(ctx, a.branch);
      assertWritablePaths(ctx, a.files.map((f) => f.path));
      return d.github.commit(a.repo, a.branch, { files: a.files, message: a.message, parentSha: a.parentSha });
    },
  }),
  defineTool({
    server: "github",
    name: "open_pull_request",
    description: "Open a pull request from your branch to main.",
    input: z.strictObject({ repo, branch: ref, title: z.string().min(1).max(256), body: z.string().max(60_000) }),
    taskWrite: true,
    handle: (ctx, a, d) => {
      assertRepo(ctx, a.repo);
      assertWritableBranch(ctx, a.branch);
      return d.github.openPullRequest(a.repo, { head: a.branch, base: "main", title: a.title, body: a.body });
    },
  }),
  defineTool({
    server: "github",
    name: "comment_pull_request",
    description: "Comment on a pull request.",
    input: z.strictObject({ repo, number: z.number().int().positive(), body: z.string().min(1).max(60_000) }),
    taskWrite: true,
    handle: async (ctx, a, d) => {
      assertRepo(ctx, a.repo);
      await d.github.commentOnPullRequest(a.repo, a.number, a.body);
      return { commented: true };
    },
  }),
  defineTool({
    server: "github",
    name: "check_status",
    description: "Read the commit statuses (e.g. adlc/verify) of a commit.",
    input: z.strictObject({ repo, sha }),
    taskWrite: false,
    handle: (ctx, a, d) => {
      assertRepo(ctx, a.repo);
      return d.github.checkStatuses(a.repo, a.sha);
    },
  }),
];
