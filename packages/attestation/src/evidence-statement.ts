import { canonicalJson, type CheckFact, type VerdictValue } from "@adlc/domain";
import { signEnvelope, verifyEnvelope, type DsseEnvelope, type EnvelopeSigner, type EnvelopeVerifier } from "./dsse.js";

/**
 * Review evidence as an in-toto v1 Statement (SDD §8.5 S9). The subject is the PR head commit;
 * the predicate binds the reviewer verdicts and check results to it. The merge-group subject
 * (S11) is added with P3-WP3.
 */

export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const REVIEW_EVIDENCE_PREDICATE = "https://adlc.pioneer/attestation/review-evidence/v0.1";

export interface EvidenceVerdict {
  reviewerRole: string;
  reviewerRunId: string;
  verdict: VerdictValue;
  modelCallId: string;
  verdictHash: string;
}

export interface EvidencePredicate {
  repo: string;
  prNumber: number;
  headSha: string;
  authorRole: string;
  verdicts: EvidenceVerdict[];
  checks: CheckFact[];
  signedAt: string;
}

export interface EvidenceStatement {
  _type: typeof IN_TOTO_STATEMENT_TYPE;
  subject: { name: string; digest: { gitCommit: string } }[];
  predicateType: typeof REVIEW_EVIDENCE_PREDICATE;
  predicate: EvidencePredicate;
}

export function evidenceStatement(p: EvidencePredicate): EvidenceStatement {
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: `git+${p.repo}#pr-${p.prNumber}`, digest: { gitCommit: p.headSha } }],
    predicateType: REVIEW_EVIDENCE_PREDICATE,
    predicate: p,
  };
}

/** Signs the statement as deterministic (canonical) JSON inside a DSSE envelope. */
export function signEvidence(statement: EvidenceStatement, signer: EnvelopeSigner): Promise<DsseEnvelope> {
  return signEnvelope(IN_TOTO_PAYLOAD_TYPE, Buffer.from(canonicalJson(statement), "utf8"), signer);
}

export async function verifyEvidence(env: DsseEnvelope, verifier: EnvelopeVerifier): Promise<EvidenceStatement> {
  const payload = await verifyEnvelope(env, IN_TOTO_PAYLOAD_TYPE, verifier);
  // The payload is untrusted until it is shown to be one of ours, even with a valid signature.
  const parsed: unknown = JSON.parse(payload.toString("utf8"));
  if (!isEvidenceStatement(parsed)) throw new Error("not an ADLC review-evidence statement");
  return parsed;
}

function isEvidenceStatement(v: unknown): v is EvidenceStatement {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return s._type === IN_TOTO_STATEMENT_TYPE && s.predicateType === REVIEW_EVIDENCE_PREDICATE && Array.isArray(s.subject) && typeof s.predicate === "object" && s.predicate !== null;
}
