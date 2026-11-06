import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { gatewaySession, project } from "./schema.js";

export interface ReviewTarget {
  repo: string;
  prNumber: number;
  headSha: string;
}

export interface GatewaySessionContext {
  runId: string;
  role: string;
  projectId: string;
  jiraProjectKey: string;
  repos: string[];
  taskKey: string | null;
  fencingToken: bigint | null;
  /** Set for review runs: the only PR head this session may record a verdict on. */
  reviewTarget: ReviewTarget | null;
}

export class InvalidSessionError extends Error {
  override name = "InvalidSessionError";
}

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** Per-run gateway credentials (ADR-0010): random bearer tokens, stored only as hashes. */
export class GatewaySessionRepository {
  constructor(private readonly db: Db) {}

  /** Issues a token for a run; the raw token is returned once and never stored. */
  async issue(
    input: { runId: string; role: string; projectId: string; taskKey: string | null; fencingToken: bigint | null; expiresAt: Date; reviewTarget?: ReviewTarget },
    now: Date,
  ): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const { reviewTarget, ...rest } = input;
    await this.db.insert(gatewaySession).values({
      ...rest,
      tokenHash: hashToken(token),
      issuedAt: now,
      reviewRepo: reviewTarget?.repo ?? null,
      reviewPrNumber: reviewTarget?.prNumber ?? null,
      reviewHeadSha: reviewTarget?.headSha ?? null,
    });
    return token;
  }

  /** Resolves a live, unrevoked token to its run context; anything else is InvalidSessionError. */
  async resolve(token: string, now: Date): Promise<GatewaySessionContext> {
    const [row] = await this.db
      .select({
        runId: gatewaySession.runId,
        role: gatewaySession.role,
        projectId: gatewaySession.projectId,
        taskKey: gatewaySession.taskKey,
        fencingToken: gatewaySession.fencingToken,
        jiraProjectKey: project.jiraProjectKey,
        repos: project.repos,
        reviewRepo: gatewaySession.reviewRepo,
        reviewPrNumber: gatewaySession.reviewPrNumber,
        reviewHeadSha: gatewaySession.reviewHeadSha,
      })
      .from(gatewaySession)
      .innerJoin(project, eq(project.id, gatewaySession.projectId))
      .where(and(eq(gatewaySession.tokenHash, hashToken(token)), isNull(gatewaySession.revokedAt), gt(gatewaySession.expiresAt, now)));
    if (!row) throw new InvalidSessionError("unknown, expired or revoked gateway session");
    const { reviewRepo, reviewPrNumber, reviewHeadSha, ...ctx } = row;
    return {
      ...ctx,
      reviewTarget: reviewRepo !== null && reviewPrNumber !== null && reviewHeadSha !== null ? { repo: reviewRepo, prNumber: reviewPrNumber, headSha: reviewHeadSha } : null,
    };
  }

  /** Revokes every session of a run (run end, kill, restart from checkpoint). */
  async revokeRun(runId: string, now: Date): Promise<void> {
    await this.db.update(gatewaySession).set({ revokedAt: now }).where(and(eq(gatewaySession.runId, runId), isNull(gatewaySession.revokedAt)));
  }
}
