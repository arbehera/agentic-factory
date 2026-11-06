import { stateHash, type Actor, type VerdictValue } from "@adlc/domain";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { AuditRepository } from "./audit-repository.js";
import type { Db } from "./client.js";
import { evidenceRecord, modelCall, reviewerVerdict } from "./schema.js";

export type ModelCallRow = typeof modelCall.$inferSelect;
export type ReviewerVerdictRow = typeof reviewerVerdict.$inferSelect;
export type EvidenceRecordRow = typeof evidenceRecord.$inferSelect;

/** A verdict for this reviewer role on this head already exists; verdicts are write-once. */
export class VerdictExistsError extends Error {
  override name = "VerdictExistsError";
}

const isUniqueViolation = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code === "23505";

/** Gateway's log of proxied model calls (FR-EVD-002 condition c). */
export class ModelCallRepository {
  constructor(private readonly db: Db) {}

  async record(row: Omit<ModelCallRow, "createdAt">, now: Date): Promise<void> {
    await this.db.insert(modelCall).values({ ...row, createdAt: now }).onConflictDoNothing({ target: modelCall.id });
  }

  async getMany(ids: readonly string[]): Promise<ModelCallRow[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(modelCall).where(inArray(modelCall.id, [...ids]));
  }
}

/** Write-once evidence store (FR-EVD-001, FR-EVD-002). */
export class EvidenceRepository {
  constructor(private readonly db: Db) {}

  /** Stores a reviewer verdict bound to a head SHA and a model call; never overwrites. */
  async writeVerdict(
    v: {
      projectId: string;
      repo: string;
      prNumber: number;
      headSha: string;
      reviewerRole: string;
      reviewerRunId: string;
      verdict: VerdictValue;
      summary: string;
      modelCallId: string;
    },
    actor: Actor,
    now: Date,
  ): Promise<ReviewerVerdictRow> {
    const verdictHash = stateHash({ ...v });
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx.insert(reviewerVerdict).values({ ...v, verdictHash, createdAt: now }).returning();
        if (!row) throw new Error("insert returned no row");
        await new AuditRepository(tx).append({
          actor,
          action: "evidence.verdict",
          target: `pr:${v.repo}#${v.prNumber}@${v.headSha}`,
          reason: `${v.reviewerRole} ${v.verdict}`,
          beforeHash: null,
          afterHash: verdictHash,
          correlation: { projectId: v.projectId, runId: v.reviewerRunId },
        });
        return row;
      });
    } catch (err) {
      if (isUniqueViolation(err) && (err as { cause?: { constraint?: string } }).cause?.constraint === "reviewer_verdict_head_role_uq") {
        throw new VerdictExistsError(`${v.reviewerRole} already recorded a verdict on ${v.headSha}`);
      }
      throw err;
    }
  }

  async verdictsFor(repo: string, prNumber: number): Promise<ReviewerVerdictRow[]> {
    return this.db.select().from(reviewerVerdict).where(and(eq(reviewerVerdict.repo, repo), eq(reviewerVerdict.prNumber, prNumber)));
  }

  /** Stores signed evidence for a PR head; a second record for the same head is refused. */
  async storeEvidence(
    e: Omit<EvidenceRecordRow, "id" | "createdAt" | "mergeGroupSha" | "envelopeRef">,
    actor: Actor,
    now: Date,
  ): Promise<EvidenceRecordRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(evidenceRecord).values({ ...e, createdAt: now }).returning();
      if (!row) throw new Error("insert returned no row");
      await new AuditRepository(tx).append({
        actor,
        action: "evidence.sign",
        target: `pr:${e.repo}#${e.prNumber}@${e.headSha}`,
        reason: `signed review evidence (${e.reviewerVerdicts.length} verdicts)`,
        beforeHash: null,
        afterHash: stateHash(e.envelope),
        correlation: { projectId: e.projectId },
      });
      return row;
    });
  }

  async evidenceFor(repo: string, prNumber: number, headSha: string): Promise<EvidenceRecordRow | null> {
    const [row] = await this.db
      .select()
      .from(evidenceRecord)
      .where(and(eq(evidenceRecord.repo, repo), eq(evidenceRecord.prNumber, prNumber), eq(evidenceRecord.headSha, headSha), isNull(evidenceRecord.mergeGroupSha)));
    return row ?? null;
  }
}
