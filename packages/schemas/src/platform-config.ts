import { TASK_COMPLEXITIES, MODEL_TIERS } from "@adlc/domain";
import { z } from "zod";

/**
 * Platform configuration-as-code (C15, FR-JIRA-001, FR-GH-001, SDD §10). These manifests hold only
 * what is specific to the external tool. Workflow statuses, transitions and gate IDs come from
 * `@adlc/domain`, so Jira can never drift from what the orchestrator enforces.
 */

const statusContext = z.string().regex(/^adlc\/[a-z][a-z0-9-]*$/);
const branchPattern = z.string().regex(/^[a-z][a-z0-9-]*\/\*$/, "a branch prefix pattern such as task/*");

/** `infra/github/<repo>.yaml`: rulesets and protection for one product repository (FR-GH-001). */
export const githubRepoConfigSchema = z.strictObject({
  repo: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),
  defaultBranch: z.string().min(1).default("main"),
  /** Branch prefixes agents may push to; everything else is closed to them (SDD §10.2). */
  agentBranches: z.array(branchPattern).min(1),
  main: z.strictObject({
    mergeQueue: z.strictObject({
      required: z.boolean(),
      /** Pilot: one PR per merge group (FR-GH-001). */
      groupSize: z.number().int().min(1).max(100),
      mergeMethod: z.enum(["MERGE", "SQUASH", "REBASE"]),
    }),
    requiredApprovals: z.number().int().min(1),
    codeOwnerReview: z.literal(true),
    dismissStaleApprovals: z.literal(true),
    requireLastPushApproval: z.literal(true),
    /** Required now, each posted by the named GitHub App identity. */
    requiredStatusChecks: z.array(z.strictObject({ context: statusContext, postedBy: z.enum(["ci"]) })).min(1),
    /** Required by FR-GH-001 but not yet posted by anything; reported by every plan until added. */
    pendingStatusChecks: z.array(z.strictObject({ context: statusContext, postedFrom: z.string().min(1) })).default([]),
  }),
  /** CODEOWNERS for the repository (SDD §9.1): approver logins or teams. */
  codeowners: z.array(z.strictObject({ path: z.string().min(1), owners: z.array(z.string().regex(/^@[A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)?$/)).min(1) })).min(1),
});
export type GithubRepoConfig = z.infer<typeof githubRepoConfigSchema>;

const fieldName = z.string().min(1).max(60);

/** `infra/jira/<project>.yaml`: issue types, fields and identities for one Jira project (FR-JIRA-001). */
export const jiraProjectConfigSchema = z.strictObject({
  site: z.url(),
  projectKey: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
  /** Service accounts (SDD §10.1); neither has Administer Projects or workflow edit rights. */
  serviceAccounts: z.strictObject({ orchestrator: z.literal("adlc-orchestrator"), agent: z.literal("adlc-agent") }),
  issueTypes: z.array(z.string().min(1)).min(1),
  customFields: z.array(
    z.discriminatedUnion("type", [
      z.strictObject({ name: fieldName, type: z.enum(["text", "number", "datetime", "labels"]) }),
      z.strictObject({ name: fieldName, type: z.literal("select"), options: z.array(z.string().min(1)).min(1) }),
    ]),
  ),
  /** Gate approver groups are named `adlc-approvers-<gate>`; membership is a human matter (OPEN-06). */
  approverGroupPrefix: z.literal("adlc-approvers-"),
});
export type JiraProjectConfig = z.infer<typeof jiraProjectConfigSchema>;

/** Select options that must match domain vocabularies. */
export const DOMAIN_SELECT_OPTIONS: Record<string, readonly string[]> = {
  complexity: TASK_COMPLEXITIES,
  "model tier": MODEL_TIERS,
};
