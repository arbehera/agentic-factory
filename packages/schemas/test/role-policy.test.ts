import { describe, expect, it } from "vitest";
import { rolePolicySchema } from "../src/index.js";

const base = { role: "dummy", tools: ["jira.read_issue"] };

describe("hard rule 3 role policy contract", () => {
  it("defaults every section to no rights", () => {
    expect(rolePolicySchema.parse(base)).toEqual({
      role: "dummy",
      tools: ["jira.read_issue"],
      jira: { createIssueTypes: [], transitions: [] },
      github: { branches: [], writePaths: [], blockedPaths: [] },
      decisions: { answerClasses: [] },
    });
  });

  it("AT-P0-04 cannot grant Done, Gate issues, main or human-only Decision classes", () => {
    const bad = (extra: object) => rolePolicySchema.safeParse({ ...base, ...extra }).success;
    expect(bad({ jira: { transitions: [{ from: "Awaiting Approval", to: "Done" }] } })).toBe(false);
    expect(bad({ jira: { createIssueTypes: ["Gate"] } })).toBe(false);
    expect(bad({ github: { branches: ["main"] } })).toBe(false);
    expect(bad({ github: { branches: ["release/1.0"] } })).toBe(false);
    expect(bad({ github: { writePaths: ["../outside/**"] } })).toBe(false);
    expect(bad({ decisions: { answerClasses: ["gate"] } })).toBe(false);
    expect(bad({ decisions: { answerClasses: ["risk"] } })).toBe(false);
    expect(bad({ tools: ["github.merge pull"] })).toBe(false);
  });

  it("accepts task branches with the {taskKey} placeholder, path globs and agent-answerable classes", () => {
    const p = rolePolicySchema.parse({
      ...base,
      github: { branches: ["task/{taskKey}"], writePaths: ["docs/dummy/**"], blockedPaths: ["ci/**"] },
      decisions: { answerClasses: ["consult"] },
    });
    expect(p.github.branches).toEqual(["task/{taskKey}"]);
  });
});
