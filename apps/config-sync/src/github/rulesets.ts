import type { GithubRepoConfig } from "@adlc/schemas";

/**
 * GitHub repository rulesets for FR-GH-001 (SDD §10.2), rendered as REST API bodies
 * (`POST /repos/{owner}/{repo}/rulesets`). Every ruleset this tool owns is named `adlc-*`;
 * other rulesets are reported and never touched.
 *
 * An installation token cannot be scoped to branches, so the agent App is confined by rulesets:
 * - main needs a PR, a code-owner approval of the latest push, the required checks and the merge
 *   queue, with no bypass actors at all;
 * - agent branches (task/*, spec/*) cannot be deleted or force-pushed, by anyone;
 * - every other branch and every tag is locked, and only the repository admin role may bypass.
 *   An App is never a repository role, so the agent App cannot.
 */

export interface RulesetBody {
  name: string;
  target: "branch" | "tag";
  enforcement: "active";
  bypass_actors: { actor_id: number; actor_type: "RepositoryRole"; bypass_mode: "always" }[];
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: { type: string; parameters?: Record<string, unknown> }[];
}

/** GitHub's built-in repository admin role (rulesets API `RepositoryRole`). */
export const REPOSITORY_ADMIN_ROLE_ID = 5;
/** Branches GitHub's merge queue creates for itself. */
export const MERGE_QUEUE_BRANCHES = "refs/heads/gh-readonly-queue/*";

export interface AppIds {
  /** Installation of the CI App (adlc-ci) that must post the required statuses. */
  ci: number | null;
}

const adminBypass = [{ actor_id: REPOSITORY_ADMIN_ROLE_ID, actor_type: "RepositoryRole" as const, bypass_mode: "always" as const }];

export function renderRulesets(config: GithubRepoConfig, apps: AppIds, opts: { mergeQueue: boolean }): RulesetBody[] {
  const agentRefs = config.agentBranches.map((b) => `refs/heads/${b}`);
  const m = config.main;
  const mainRules: RulesetBody["rules"] = [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: m.requiredApprovals,
        dismiss_stale_reviews_on_push: m.dismissStaleApprovals,
        require_code_owner_review: m.codeOwnerReview,
        require_last_push_approval: m.requireLastPushApproval,
        required_review_thread_resolution: false,
        allowed_merge_methods: [m.mergeQueue.mergeMethod.toLowerCase()],
      },
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: false,
        // Pinning a check to the CI App means a status from any other identity does not count.
        required_status_checks: m.requiredStatusChecks.map((c) => ({ context: c.context, ...(apps.ci === null ? {} : { integration_id: apps.ci }) })),
      },
    },
  ];
  if (opts.mergeQueue && m.mergeQueue.required) {
    mainRules.push({
      type: "merge_queue",
      parameters: {
        check_response_timeout_minutes: 60,
        grouping_strategy: "ALLGREEN",
        max_entries_to_build: m.mergeQueue.groupSize,
        max_entries_to_merge: m.mergeQueue.groupSize,
        merge_method: m.mergeQueue.mergeMethod,
        min_entries_to_merge: 1,
        min_entries_to_merge_wait_minutes: 0,
      },
    });
  }
  return [
    {
      name: "adlc-main",
      target: "branch",
      enforcement: "active",
      bypass_actors: [], // no bypass actors, administrators included (FR-GH-001)
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: mainRules,
    },
    {
      name: "adlc-agent-branches",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: agentRefs, exclude: [] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
    },
    {
      name: "adlc-other-branches",
      target: "branch",
      enforcement: "active",
      bypass_actors: adminBypass,
      conditions: { ref_name: { include: ["~ALL"], exclude: ["~DEFAULT_BRANCH", ...agentRefs, MERGE_QUEUE_BRANCHES] } },
      rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }, { type: "non_fast_forward" }],
    },
    {
      name: "adlc-tags",
      target: "tag",
      enforcement: "active",
      bypass_actors: adminBypass,
      conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
      rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
    },
  ];
}

/** CODEOWNERS file content (SDD §9.1). */
export function renderCodeowners(config: GithubRepoConfig): string {
  const lines = config.codeowners.map((c) => `${c.path} ${c.owners.join(" ")}`);
  return `# Generated from infra/github/${config.repo.split("/")[1] ?? ""}.yaml by config-sync (FR-GH-001). Do not edit here.\n${lines.join("\n")}\n`;
}
