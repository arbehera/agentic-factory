import { IssueConflictError, type IssueTracker } from "@adlc/adapters";
import { stateHash, taskStatusMachine, type TaskStatus } from "@adlc/domain";
import type { AuditRepository } from "@adlc/db";
import { ORCHESTRATOR_ACTOR } from "./runs.js";

export interface TaskMove {
  /** The task's Jira status after the attempt. */
  status: string;
  moved: boolean;
}

/**
 * Moves a Jira task as `adlc-orchestrator` (hard rule 4: Jira holds task status). Every move
 * re-reads the issue first and only follows the task state machine. A human edit between the read
 * and the write makes Jira refuse it, and the human's version wins: the move is reported as not
 * made with the status the human left. Each move is audited (hard rule 11).
 */
export class JiraTaskStatus {
  constructor(
    private readonly issues: IssueTracker,
    private readonly audit: AuditRepository,
  ) {}

  async move(taskKey: string, to: TaskStatus, reason: string, correlation: { projectId: string; runId: string }): Promise<TaskMove> {
    const issue = await this.issues.getIssue(taskKey);
    if (issue.status === to || !taskStatusMachine.canTransition(issue.status as TaskStatus, to)) return { status: issue.status, moved: false };
    let after;
    try {
      after = await this.issues.transition(taskKey, to, issue.version);
    } catch (err) {
      if (!(err instanceof IssueConflictError)) throw err;
      return { status: (await this.issues.getIssue(taskKey)).status, moved: false };
    }
    await this.audit.append({
      actor: ORCHESTRATOR_ACTOR,
      action: "task.status",
      target: `task:${taskKey}`,
      reason: `${issue.status} -> ${to}: ${reason}`,
      beforeHash: stateHash({ key: issue.key, status: issue.status, version: issue.version }),
      afterHash: stateHash({ key: after.key, status: after.status, version: after.version }),
      correlation: { ...correlation, taskKey },
    });
    return { status: after.status, moved: true };
  }
}
