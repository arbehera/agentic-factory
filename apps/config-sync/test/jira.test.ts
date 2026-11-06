import { readFile } from "node:fs/promises";
import { GATE_IDS, TASK_STATUSES, taskStatusMachine } from "@adlc/domain";
import { loadYamlContract } from "@adlc/pack-sdk";
import { jiraProjectConfigSchema, type JiraProjectConfig } from "@adlc/schemas";
import { describe, expect, it } from "vitest";
import { desiredJira, JiraConfigError, renderJiraPlan } from "../src/index.js";

const manifestPath = new URL("../../../infra/jira/agensdlc.yaml", import.meta.url);
const load = async (): Promise<JiraProjectConfig> => loadYamlContract(jiraProjectConfigSchema, await readFile(manifestPath, "utf8"), "agensdlc.yaml");

describe("FR-JIRA-001 Jira configuration-as-code", () => {
  it("FR-JIRA-001 issue types and custom fields follow SDD §10.1", async () => {
    const d = desiredJira(await load());
    expect(d.issueTypes).toEqual(["Epic", "Story", "Task", "Bug", "Change Request", "Decision", "Risk", "Nonconformance", "Gate"]);
    expect(d.customFields.map((f) => f.name)).toEqual(["specRef", "requirement IDs", "component", "complexity", "flags", "agent role", "agent version", "model tier", "lease expiry", "tokens used", "Decision ID", "External ID"]);
  });

  it("FR-JIRA-001 the task workflow is the orchestrator's own state machine; only adlc-orchestrator may set Done", async () => {
    const d = desiredJira(await load());
    expect(d.taskWorkflow.statuses).toEqual([...TASK_STATUSES]);
    expect(d.taskWorkflow.transitions).toHaveLength(taskStatusMachine.states.reduce((n, s) => n + taskStatusMachine.next(s).length, 0));
    const intoDone = d.taskWorkflow.transitions.filter((t) => t.to === "Done");
    expect(intoDone).toEqual([{ from: "Awaiting Approval", to: "Done", conditions: ["user = adlc-orchestrator"] }]);
    expect(d.taskWorkflow.transitions.filter((t) => t.to !== "Done").every((t) => t.conditions.length === 0)).toBe(true);
  });

  it("FR-JIRA-001 hard rule 2 gates: approve/reject need the gate's approver group, exclude both service accounts and need a comment", async () => {
    const d = desiredJira(await load());
    const resolve = d.gateWorkflow.transitions.filter((t) => t.to === "Approved" || t.to === "Rejected");
    expect(resolve).toHaveLength(2);
    for (const t of resolve) expect(t.conditions).toEqual(["user in group adlc-approvers-<gate>", "user not in (adlc-orchestrator, adlc-agent)", "comment required"]);
    expect(d.groups).toEqual(GATE_IDS.map((g) => `adlc-approvers-${g}`));
    expect(d.gateWorkflow.approverGroups.find((g) => g.gate === "G1")?.approvals).toBe(2);
    expect(d.gateWorkflow.approverGroups.find((g) => g.gate === "G0")?.approvals).toBe(1);
  });

  it("FR-JIRA-001 select options must equal the domain vocabularies; Task and Gate are required", async () => {
    const config = await load();
    const badTier = { ...config, customFields: config.customFields.map((f) => (f.name === "model tier" ? { name: f.name, type: "select" as const, options: ["A", "B", "C"] } : f)) };
    expect(() => desiredJira(badTier)).toThrow(/model tier.*A, B/);
    expect(() => desiredJira({ ...config, issueTypes: ["Task"] })).toThrow(JiraConfigError);
    expect(() => desiredJira({ ...config, customFields: [...config.customFields, { name: "specRef", type: "text" }] })).toThrow(/duplicate custom field/);
  });

  it("FR-JIRA-001 the rendered plan names every condition for review", async () => {
    const text = renderJiraPlan(desiredJira(await load()));
    expect(text).toContain("Awaiting Approval -> Done   [user = adlc-orchestrator]");
    expect(text).toContain("adlc-approvers-G1  (two-key: 2 distinct approvers, enforced by the orchestrator)");
  });
});
