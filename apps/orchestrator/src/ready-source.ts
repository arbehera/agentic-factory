import type { IssueTracker } from "@adlc/adapters";
import { isLeaseLive } from "@adlc/domain";
import type { AgentDefinitionRepository, LeaseRepository, ProjectRepository } from "@adlc/db";
import type { Clock } from "@adlc/control-plane";
import type { CandidateSource, ClaimCandidate } from "./dispatcher.js";

/** Jira statuses a Phase 0 task is offered from: new work, and claimed work whose run ended. */
const OFFERED = ["To Do", "In Progress"] as const;

/**
 * Phase 0 stand-in for the ready frontier (FR-ORC-005 arrives in Phase 2). It offers every
 * `To Do` task of an active project, plus `In Progress` tasks with no live lease (a run that
 * stopped or was lost resumes from its branch, AT-P0-03), oldest first, to one configured role.
 * No blockers, DoR, priorities, component locks or fair share yet: those are the Phase 2 rules.
 *
 * Jira is read on every tick, never cached (hard rule 4). JQL narrows the search and the statuses
 * are checked again here, so a search that returns more than asked for cannot widen dispatch.
 */
export class JiraReadySource implements CandidateSource {
  constructor(
    private readonly issues: IssueTracker,
    private readonly projects: ProjectRepository,
    private readonly definitions: AgentDefinitionRepository,
    private readonly leases: LeaseRepository,
    private readonly role: string,
    private readonly clock: Clock,
  ) {}

  async candidates(limit: number): Promise<ClaimCandidate[]> {
    const definition = await this.definitions.latestForRole(this.role);
    if (!definition) return [];
    const out: ClaimCandidate[] = [];
    for (const project of await this.projects.listActive()) {
      const jql = `project = ${project.jiraProjectKey} AND status in (${OFFERED.map((s) => `"${s}"`).join(", ")}) ORDER BY created ASC`;
      for (const issue of await this.issues.search(jql, limit)) {
        if (out.length >= limit) return out;
        if (!(OFFERED as readonly string[]).includes(issue.status) || !issue.key.startsWith(`${project.jiraProjectKey}-`)) continue;
        const lease = await this.leases.get(issue.key);
        if (lease && isLeaseLive(lease, this.clock.now())) continue; // a run already holds it
        out.push({ taskKey: issue.key, projectId: project.id, complexity: "S", agentDefinitionId: definition.id, kind: "task-pipeline" });
      }
    }
    return out;
  }
}
