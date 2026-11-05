import { describe, expect, it } from "vitest";
import { auditEventInputSchema, decisionInputSchema } from "../src/index.js";

const decision = {
  class: "consult",
  route: "operational",
  question: "Which header declares the interface?",
  options: [],
  owner: "senior-engineer",
  timeboxMinutes: 30,
  reversible: true,
  autoResolve: true,
  projectId: "p1",
};

const audit = {
  actor: { kind: "service", id: "adlc-orchestrator" },
  action: "lease.acquire",
  target: "PILOT-12",
  reason: "dispatch",
  beforeHash: null,
  afterHash: "a".repeat(64),
  correlation: { taskKey: "PILOT-12" },
};

describe("FR-DEC-001 Decision input validation", () => {
  it("accepts an auto-resolving lookup consult", () => {
    expect(decisionInputSchema.parse(decision)).toMatchObject({ class: "consult" });
  });

  it("FR-DEC-002 rejects auto-resolve on gate, clarification and risk Decisions", () => {
    for (const cls of ["gate", "clarification", "risk", "requirement", "escalation"]) {
      const r = decisionInputSchema.safeParse({ ...decision, class: cls, reversible: false });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.message).toMatch(/only consult|autoResolve=false/);
    }
  });

  it("rejects a reversible gate Decision and unknown fields (e.g. an onTimeout default)", () => {
    expect(decisionInputSchema.safeParse({ ...decision, class: "gate", autoResolve: false }).success).toBe(false);
    expect(decisionInputSchema.safeParse({ ...decision, onTimeout: "approve" }).success).toBe(false);
  });
});

describe("NFR-001 audit event input validation", () => {
  it("accepts a complete event", () => {
    expect(auditEventInputSchema.parse(audit)).toEqual(audit);
  });

  it("requires a reason and well-formed hashes, and rejects unknown actor kinds", () => {
    expect(auditEventInputSchema.safeParse({ ...audit, reason: "" }).success).toBe(false);
    expect(auditEventInputSchema.safeParse({ ...audit, afterHash: "XYZ" }).success).toBe(false);
    expect(auditEventInputSchema.safeParse({ ...audit, actor: { kind: "llm", id: "x" } }).success).toBe(false);
  });
});
