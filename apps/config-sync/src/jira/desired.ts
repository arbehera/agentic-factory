import { DONE_ACTOR_ID, GATE_IDS, GATE_STATUSES, gateMachine, requiredApprovals, TASK_STATUSES, taskStatusMachine, type GateId } from "@adlc/domain";
import { DOMAIN_SELECT_OPTIONS, type JiraProjectConfig } from "@adlc/schemas";

/**
 * The Jira configuration FR-JIRA-001 asks for (SDD §10.1), derived from the manifest plus the
 * domain state machines. Statuses and transitions are never written by hand: they are the
 * orchestrator's own tables, so Jira and the platform cannot disagree.
 */

export interface JiraTransition {
  from: string;
  to: string;
  /** Workflow conditions Jira must enforce, independently of the gateway (AT-P0-04). */
  conditions: string[];
}

export interface JiraDesiredState {
  site: string;
  projectKey: string;
  serviceAccounts: JiraProjectConfig["serviceAccounts"];
  issueTypes: string[];
  customFields: JiraProjectConfig["customFields"];
  taskWorkflow: { issueTypes: string[]; statuses: string[]; transitions: JiraTransition[] };
  gateWorkflow: { issueType: "Gate"; statuses: string[]; transitions: JiraTransition[]; approverGroups: { gate: GateId; group: string; approvals: number }[] };
  groups: string[];
}

export class JiraConfigError extends Error {
  override name = "JiraConfigError";
}

/** Issue types that follow the task workflow (the others use Jira's defaults for now). */
const TASK_WORKFLOW_TYPES = ["Task", "Bug"];

export function desiredJira(config: JiraProjectConfig): JiraDesiredState {
  const problems: string[] = [];
  for (const required of ["Task", "Gate"]) if (!config.issueTypes.includes(required)) problems.push(`issue type ${required} is required`);
  for (const f of config.customFields) {
    const domain = DOMAIN_SELECT_OPTIONS[f.name];
    if (domain && (f.type !== "select" || f.options.join("|") !== domain.join("|"))) problems.push(`field "${f.name}" must be a select with options ${domain.join(", ")} (domain vocabulary)`);
  }
  if (new Set(config.customFields.map((f) => f.name)).size !== config.customFields.length) problems.push("duplicate custom field");
  if (problems.length > 0) throw new JiraConfigError(`invalid Jira manifest: ${problems.join("; ")}`);

  const { orchestrator, agent } = config.serviceAccounts;
  const taskTransitions = taskStatusMachine.states.flatMap((from) =>
    taskStatusMachine.next(from).map((to) => ({
      from,
      to,
      conditions: to === "Done" ? [`user = ${DONE_ACTOR_ID}`] : [],
    })),
  );
  const approverGroups = GATE_IDS.map((gate) => ({ gate, group: `${config.approverGroupPrefix}${gate}`, approvals: requiredApprovals(gate) }));
  const gateTransitions = gateMachine.states.flatMap((from) =>
    gateMachine.next(from).map((to) => ({
      from,
      to,
      conditions:
        to === "Approved" || to === "Rejected"
          ? [`user in group ${config.approverGroupPrefix}<gate>`, `user not in (${orchestrator}, ${agent})`, "comment required"]
          : [],
    })),
  );
  return {
    site: config.site,
    projectKey: config.projectKey,
    serviceAccounts: config.serviceAccounts,
    issueTypes: config.issueTypes,
    customFields: config.customFields,
    taskWorkflow: { issueTypes: TASK_WORKFLOW_TYPES.filter((t) => config.issueTypes.includes(t)), statuses: [...TASK_STATUSES], transitions: taskTransitions },
    gateWorkflow: { issueType: "Gate", statuses: [...GATE_STATUSES], transitions: gateTransitions, approverGroups },
    groups: approverGroups.map((g) => g.group),
  };
}

/** Plain-text desired state for review; the live drift check arrives with sandbox access (Q-04). */
export function renderJiraPlan(d: JiraDesiredState): string {
  const t = (x: JiraTransition) => `    ${x.from} -> ${x.to}${x.conditions.length ? `   [${x.conditions.join("; ")}]` : ""}`;
  return [
    `Jira desired state for ${d.projectKey} at ${d.site}`,
    `  service accounts (no Administer Projects, no workflow edit): ${d.serviceAccounts.orchestrator}, ${d.serviceAccounts.agent}`,
    `  issue types: ${d.issueTypes.join(", ")}`,
    `  custom fields:`,
    ...d.customFields.map((f) => `    ${f.name} (${f.type}${f.type === "select" ? `: ${f.options.join("/")}` : ""})`),
    `  task workflow (${d.taskWorkflow.issueTypes.join(", ")}): ${d.taskWorkflow.statuses.join(", ")}`,
    ...d.taskWorkflow.transitions.map(t),
    `  gate workflow (Gate): ${d.gateWorkflow.statuses.join(", ")}`,
    ...d.gateWorkflow.transitions.map(t),
    `  approver groups (members added by humans only; two approvers where noted):`,
    ...d.gateWorkflow.approverGroups.map((g) => `    ${g.group}${g.approvals > 1 ? `  (two-key: ${g.approvals} distinct approvers, enforced by the orchestrator)` : ""}`),
    "",
  ].join("\n");
}
