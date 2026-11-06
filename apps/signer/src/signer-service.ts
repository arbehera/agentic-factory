import type { SourceControl } from "@adlc/adapters";
import { evidenceStatement, signEvidence, type EnvelopeSigner, type EvidenceVerdict } from "@adlc/attestation";
import { evaluateSigning, type Actor, type CheckFact, type VerdictValue } from "@adlc/domain";
import { AuditRepository, EvidenceRepository, ModelCallRepository, ProjectRepository, type Db } from "@adlc/db";
import type { ReviewerSets } from "@adlc/schemas";
import type { Logger } from "@adlc/telemetry";

/** The required status the signer posts (FR-EVD-002, FR-GH-001). */
export const EVIDENCE_CONTEXT = "adlc/evidence";
export const SIGNER_IDENTITY: Actor = { kind: "service", id: "adlc-signer" };

export interface SignerConfig {
  reviewerSets: ReviewerSets;
  /** Checks that must have succeeded on the head SHA, e.g. ["adlc/verify"] (condition d). */
  requiredChecks: readonly string[];
}

export interface Clock {
  now(): Date;
}

export type SignOutcome =
  | { signed: true; headSha: string; evidenceId: string; keyId: string; reposted: boolean }
  | { signed: false; headSha: string | null; reasons: string[] };

/** GitHub limits status descriptions to 140 characters. */
const describe = (s: string) => (s.length <= 140 ? s : `${s.slice(0, 137)}...`);

/**
 * Evidence signer (C8, SDD §8.5 S9). Runs on a dedicated node and never checks out or runs PR
 * code: it reads the PR head from GitHub, the verdicts and model-call log from the write-once
 * store, and the check statuses on the head; it signs only if all four FR-EVD-002 conditions
 * hold, stores the DSSE envelope and posts `adlc/evidence`. A refusal posts a failure status with
 * the first reason and is audited with all of them. Signing the same head again is idempotent.
 */
export class SignerService {
  private readonly evidence: EvidenceRepository;
  private readonly modelCalls: ModelCallRepository;
  private readonly projects: ProjectRepository;
  private readonly audit: AuditRepository;

  constructor(
    db: Db,
    private readonly scm: SourceControl,
    private readonly signer: EnvelopeSigner,
    private readonly config: SignerConfig,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    this.evidence = new EvidenceRepository(db);
    this.modelCalls = new ModelCallRepository(db);
    this.projects = new ProjectRepository(db);
    this.audit = new AuditRepository(db);
  }

  async signPullRequest(repo: string, prNumber: number, authorRole: string): Promise<SignOutcome> {
    const log = this.logger.child({ repo, prNumber, authorRole });
    const pr = await this.scm.getPullRequest(repo, prNumber);
    if (!pr?.headSha) return { signed: false, headSha: null, reasons: ["pull request not found"] };
    const head = pr.headSha;
    const project = await this.projects.findByRepo(repo);
    if (!project) return this.refuse(repo, prNumber, head, null, ["repository is not part of any ADLC project"]);

    const existing = await this.evidence.evidenceFor(repo, prNumber, head);
    if (existing) {
      await this.scm.setCommitStatus(repo, head, { context: EVIDENCE_CONTEXT, state: "success", description: describe(`signed review evidence ${existing.id}`) });
      return { signed: true, headSha: head, evidenceId: existing.id, keyId: this.signer.keyId, reposted: true };
    }

    const verdicts = await this.evidence.verdictsFor(repo, prNumber);
    const calls = await this.modelCalls.getMany([...new Set(verdicts.map((v) => v.modelCallId))]);
    const checks: CheckFact[] = (await this.scm.checkStatuses(repo, head)).filter((c) => c.context !== EVIDENCE_CONTEXT);
    const requiredReviewers = this.config.reviewerSets.sets[authorRole] ?? [];
    const decision = evaluateSigning({
      headSha: head,
      requiredReviewers,
      verdicts: verdicts.map((v) => ({ reviewerRole: v.reviewerRole, reviewerRunId: v.reviewerRunId, headSha: v.headSha, verdict: v.verdict as VerdictValue, modelCallId: v.modelCallId })),
      modelCalls: calls.map((c) => ({ id: c.id, runId: c.runId })),
      requiredChecks: this.config.requiredChecks,
      checks,
    });
    if (!decision.sign) return this.refuse(repo, prNumber, head, project.id, decision.reasons);

    const counted: EvidenceVerdict[] = verdicts
      .filter((v) => v.headSha === head && requiredReviewers.includes(v.reviewerRole))
      .map((v) => ({ reviewerRole: v.reviewerRole, reviewerRunId: v.reviewerRunId, verdict: v.verdict as VerdictValue, modelCallId: v.modelCallId, verdictHash: v.verdictHash }));
    const checkResults = checks.filter((c) => this.config.requiredChecks.includes(c.context));
    const envelope = await signEvidence(
      evidenceStatement({ repo, prNumber, headSha: head, authorRole, verdicts: counted, checks: checkResults, signedAt: this.clock.now().toISOString() }),
      this.signer,
    );
    const row = await this.evidence.storeEvidence(
      {
        projectId: project.id,
        repo,
        authorRole,
        prNumber,
        headSha: head,
        // Patch-id binding for merge groups arrives with the merge-group rule (P3-WP3).
        patchId: "",
        reviewerVerdicts: counted.map((v) => ({ role: v.reviewerRole, tier: "", verdictHash: v.verdictHash, modelCallId: v.modelCallId })),
        checkResults,
        envelope: envelope as unknown as Record<string, unknown>,
        status: "signed",
      },
      SIGNER_IDENTITY,
      this.clock.now(),
    );
    await this.scm.setCommitStatus(repo, head, { context: EVIDENCE_CONTEXT, state: "success", description: describe(`signed review evidence ${row.id}`) });
    log.info({ headSha: head, evidenceId: row.id, keyId: this.signer.keyId }, "review evidence signed");
    return { signed: true, headSha: head, evidenceId: row.id, keyId: this.signer.keyId, reposted: false };
  }

  private async refuse(repo: string, prNumber: number, head: string, projectId: string | null, reasons: string[]): Promise<SignOutcome> {
    await this.scm.setCommitStatus(repo, head, { context: EVIDENCE_CONTEXT, state: "failure", description: describe(reasons[0] ?? "evidence refused") });
    await this.audit.append({
      actor: SIGNER_IDENTITY,
      action: "evidence.refuse",
      target: `pr:${repo}#${prNumber}@${head}`,
      reason: reasons.join("; ").slice(0, 4000),
      beforeHash: null,
      afterHash: null,
      correlation: projectId ? { projectId } : {},
    });
    this.logger.warn({ repo, prNumber, headSha: head, reasons }, "review evidence refused");
    return { signed: false, headSha: head, reasons };
  }
}
