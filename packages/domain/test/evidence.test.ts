import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateSigning, type SigningFacts, type VerdictFact } from "../src/index.js";

const HEAD = "a".repeat(40);
const verdict = (over: Partial<VerdictFact> = {}): VerdictFact => ({ reviewerRole: "dummy-reviewer", reviewerRunId: "run-r", headSha: HEAD, verdict: "approve", modelCallId: "msg_1", ...over });
const facts = (over: Partial<SigningFacts> = {}): SigningFacts => ({
  headSha: HEAD,
  requiredReviewers: ["dummy-reviewer"],
  verdicts: [verdict()],
  modelCalls: [{ id: "msg_1", runId: "run-r" }],
  requiredChecks: ["adlc/verify"],
  checks: [{ context: "adlc/verify", state: "success" }],
  ...over,
});

describe("FR-EVD-002 signing preconditions", () => {
  it("FR-EVD-002 signs when all four conditions hold", () => {
    expect(evaluateSigning(facts())).toEqual({ sign: true });
  });

  it("FR-EVD-002 (a) refuses without a complete, approving reviewer set", () => {
    expect(evaluateSigning(facts({ requiredReviewers: ["dummy-reviewer", "security"] }))).toEqual({ sign: false, reasons: ["missing verdict from required reviewer security"] });
    expect(evaluateSigning(facts({ verdicts: [verdict({ verdict: "request-changes" })] }))).toEqual({ sign: false, reasons: ["dummy-reviewer requested changes"] });
    expect(evaluateSigning(facts({ requiredReviewers: [] }))).toMatchObject({ sign: false, reasons: ["no reviewer set is configured for the author role"] });
  });

  it("FR-EVD-002 (b) a verdict on an older SHA does not count (a later push invalidates reviews)", () => {
    const r = evaluateSigning(facts({ verdicts: [verdict({ headSha: "b".repeat(40) })] }));
    expect(r).toEqual({ sign: false, reasons: ["missing verdict from required reviewer dummy-reviewer"] });
  });

  it("FR-EVD-002 (b) stale verdicts from earlier heads do not block signing once the new head is reviewed", () => {
    const old = verdict({ headSha: "b".repeat(40), verdict: "request-changes", modelCallId: "msg_0" });
    expect(evaluateSigning(facts({ verdicts: [old, verdict()] }))).toEqual({ sign: true });
  });

  it("FR-EVD-002 (c) refuses verdicts without a gateway-logged model call of the same run (forged evidence)", () => {
    expect(evaluateSigning(facts({ modelCalls: [] }))).toEqual({ sign: false, reasons: ["verdict of dummy-reviewer cites model call msg_1, which the gateway did not log"] });
    expect(evaluateSigning(facts({ modelCalls: [{ id: "msg_1", runId: "someone-else" }] }))).toEqual({ sign: false, reasons: ["verdict of dummy-reviewer cites a model call of another run"] });
  });

  it("FR-EVD-002 (d) refuses unless every required check succeeded; the latest status counts", () => {
    expect(evaluateSigning(facts({ checks: [] }))).toEqual({ sign: false, reasons: ["required check adlc/verify is missing"] });
    expect(evaluateSigning(facts({ checks: [{ context: "adlc/verify", state: "pending" }] }))).toMatchObject({ sign: false });
    expect(evaluateSigning(facts({ checks: [{ context: "adlc/verify", state: "failure" }, { context: "adlc/verify", state: "success" }] }))).toEqual({ sign: true });
  });

  it("FR-EVD-002 property: signing implies every condition holds — no combination of bad facts signs", () => {
    const arb = fc.record({
      reviewerOk: fc.boolean(),
      approve: fc.boolean(),
      shaOk: fc.boolean(),
      callLogged: fc.boolean(),
      sameRun: fc.boolean(),
      checkState: fc.constantFrom("pending", "success", "failure", "error", "missing"),
    });
    fc.assert(
      fc.property(arb, (x) => {
        const f = facts({
          requiredReviewers: x.reviewerOk ? ["dummy-reviewer"] : ["other"],
          verdicts: [verdict({ verdict: x.approve ? "approve" : "request-changes", headSha: x.shaOk ? HEAD : "c".repeat(40) })],
          modelCalls: x.callLogged ? [{ id: "msg_1", runId: x.sameRun ? "run-r" : "run-x" }] : [],
          checks: x.checkState === "missing" ? [] : [{ context: "adlc/verify", state: x.checkState as "success" }],
        });
        const allHold = x.reviewerOk && x.approve && x.shaOk && x.callLogged && x.sameRun && x.checkState === "success";
        expect(evaluateSigning(f).sign).toBe(allHold);
      }),
    );
  });
});
