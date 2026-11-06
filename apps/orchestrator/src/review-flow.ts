import type { IssueTracker, SourceControl } from "@adlc/adapters";
import type { EvidenceRepository, JobQueue, ProjectRepository } from "@adlc/db";
import type { ReviewerSets } from "@adlc/schemas";
import { SIGN_EVIDENCE_JOB, type Clock } from "@adlc/control-plane";
import type { Logger } from "@adlc/telemetry";
import type { JiraTaskStatus } from "./task-status.js";

export const START_REVIEW_JOB = "start-review";
export { SIGN_EVIDENCE_JOB };
export const VERIFY_CONTEXT = "adlc/verify";
export const EVIDENCE_CONTEXT = "adlc/evidence";

export interface StartReviewPayload {
  projectId: string;
  taskKey: string;
  repo: string;
  prNumber: number;
  headSha: string;
  role: string;
}

/**
 * Phase 0 hand-offs after the author's PR (AT-P0-01). This is the minimal trigger, not the full
 * S6–S12 pipeline, which arrives with review dispatch in P3-WP2. Leader only, deterministic, no
 * model (hard rule 1). Per task In Review or Awaiting Approval, from Jira and GitHub as they are now
 * (hard rule 4):
 * - `adlc/verify` green on the PR head: request a review run per required reviewer role (FR-EVD-002 a).
 *   The job is keyed by the head, so each head is reviewed once.
 * - Every required verdict recorded for that head: ask the signer to sign (one job per head). The
 *   signer re-checks all four FR-EVD-002 conditions itself.
 * - `adlc/evidence` green: In Review -> Awaiting Approval. Approving (G5) and merging are human
 *   actions in GitHub: no code here approves or merges (hard rules 2 and 3).
 * - The PR merged by the merge queue: Awaiting Approval -> Done (adlc-orchestrator only).
 */
export class ReviewFlow {
  constructor(
    private readonly issues: IssueTracker,
    private readonly scm: SourceControl,
    private readonly projects: ProjectRepository,
    private readonly evidence: EvidenceRepository,
    private readonly queue: JobQueue,
    private readonly tasks: JiraTaskStatus,
    private readonly reviewerSets: ReviewerSets,
    private readonly authorRole: string,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async tick(): Promise<{ reviews: number; signs: number; moved: string[] }> {
    const out = { reviews: 0, signs: 0, moved: [] as string[] };
    for (const project of await this.projects.listActive()) {
      const repo = project.repos[0];
      if (!repo) continue;
      const jql = `project = ${project.jiraProjectKey} AND status in ("In Review", "Awaiting Approval")`;
      for (const issue of await this.issues.search(jql, 50)) {
        if (!issue.key.startsWith(`${project.jiraProjectKey}-`)) continue;
        const pr = await this.scm.findPullRequest(repo, `task/${issue.key}`);
        if (!pr) continue;
        const correlation = { projectId: project.id, runId: "review-flow" };
        if (issue.status === "Awaiting Approval") {
          if (pr.merged && (await this.tasks.move(issue.key, "Done", `PR #${pr.number} merged at ${pr.headSha}`, correlation)).moved) out.moved.push(`${issue.key}:Done`);
          continue;
        }
        if (issue.status !== "In Review" || pr.merged) continue;
        const statuses = await this.scm.checkStatuses(repo, pr.headSha);
        const state = (context: string) => statuses.find((s) => s.context === context)?.state;
        if (state(VERIFY_CONTEXT) !== "success") continue; // CI first
        if (state(EVIDENCE_CONTEXT) === "success") {
          if ((await this.tasks.move(issue.key, "Awaiting Approval", `adlc/verify and adlc/evidence green on ${pr.headSha}`, correlation)).moved) out.moved.push(`${issue.key}:Awaiting Approval`);
          continue;
        }
        const required = this.reviewerSets.sets[this.authorRole] ?? [];
        const verdicts = (await this.evidence.verdictsFor(repo, pr.number)).filter((v) => v.headSha === pr.headSha);
        const missing = required.filter((role) => !verdicts.some((v) => v.reviewerRole === role));
        const now = this.clock.now();
        for (const role of missing) {
          const payload: StartReviewPayload = { projectId: project.id, taskKey: issue.key, repo, prNumber: pr.number, headSha: pr.headSha, role };
          if (await this.queue.enqueue({ kind: START_REVIEW_JOB, payload: { ...payload }, dedupeKey: `review:${repo}#${pr.number}@${pr.headSha}:${role}`, runAfter: now, maxAttempts: 1 })) out.reviews++;
        }
        if (missing.length === 0 && required.length > 0 && state(EVIDENCE_CONTEXT) === undefined) {
          const queued = await this.queue.enqueue({
            kind: SIGN_EVIDENCE_JOB,
            payload: { repo, prNumber: pr.number, headSha: pr.headSha, authorRole: this.authorRole },
            dedupeKey: `sign:${repo}#${pr.number}@${pr.headSha}`,
            runAfter: now,
          });
          if (queued) out.signs++;
        }
      }
    }
    if (out.moved.length > 0) this.logger.info({ moved: out.moved }, "review flow moved tasks");
    return out;
  }
}
