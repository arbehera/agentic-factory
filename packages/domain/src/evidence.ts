/**
 * Signing preconditions (FR-EVD-002, SDD §8.5 S9, §15.1). The signer signs evidence for a PR head
 * only if all four hold:
 *  (a) the verdicts cover the author role's required reviewer set;
 *  (b) every verdict names the exact head SHA;
 *  (c) every verdict matches a model call the gateway logged for the reviewing run;
 *  (d) every required check passed on the head SHA.
 * Every unmet condition is reported, so a refusal explains itself.
 */

export const VERDICTS = ["approve", "request-changes"] as const;
export type VerdictValue = (typeof VERDICTS)[number];

export interface VerdictFact {
  reviewerRole: string;
  reviewerRunId: string;
  headSha: string;
  verdict: VerdictValue;
  modelCallId: string;
}

export interface ModelCallFact {
  id: string;
  runId: string;
}

export interface CheckFact {
  context: string;
  state: "pending" | "success" | "failure" | "error";
}

export interface SigningFacts {
  headSha: string;
  requiredReviewers: readonly string[];
  verdicts: readonly VerdictFact[];
  modelCalls: readonly ModelCallFact[];
  requiredChecks: readonly string[];
  checks: readonly CheckFact[];
}

export type SigningDecision = { sign: true } | { sign: false; reasons: string[] };

export function evaluateSigning(f: SigningFacts): SigningDecision {
  const reasons: string[] = [];
  if (f.requiredReviewers.length === 0) reasons.push("no reviewer set is configured for the author role");

  // (b) Only verdicts naming the exact head count. Verdicts on earlier heads stay in the write-once
  // store forever, so they are ignored rather than treated as a refusal reason.
  const onHead = f.verdicts.filter((v) => v.headSha === f.headSha);

  // (a) Every required reviewer role approved on the head, and none requested changes.
  for (const role of f.requiredReviewers) {
    const mine = onHead.filter((v) => v.reviewerRole === role);
    if (mine.length === 0) reasons.push(`missing verdict from required reviewer ${role}`);
    else if (mine.some((v) => v.verdict !== "approve")) reasons.push(`${role} requested changes`);
  }

  // (c) Each counted verdict is backed by a model call logged for the same reviewer run.
  const calls = new Map(f.modelCalls.map((c) => [c.id, c.runId]));
  for (const v of onHead) {
    const runId = calls.get(v.modelCallId);
    if (runId === undefined) reasons.push(`verdict of ${v.reviewerRole} cites model call ${v.modelCallId}, which the gateway did not log`);
    else if (runId !== v.reviewerRunId) reasons.push(`verdict of ${v.reviewerRole} cites a model call of another run`);
  }

  // (d) Required checks passed (the latest status per context counts).
  const latest = new Map(f.checks.map((c) => [c.context, c.state]));
  for (const context of f.requiredChecks) {
    const state = latest.get(context);
    if (state !== "success") reasons.push(`required check ${context} is ${state ?? "missing"}`);
  }

  return reasons.length === 0 ? { sign: true } : { sign: false, reasons };
}
