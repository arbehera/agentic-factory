import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { gatewaySession, project } from "./schema.js";

export interface GatewaySessionContext {
  runId: string;
  role: string;
  projectId: string;
  jiraProjectKey: string;
  repos: string[];
  taskKey: string | null;
  fencingToken: bigint | null;
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
    input: { runId: string; role: string; projectId: string; taskKey: string | null; fencingToken: bigint | null; expiresAt: Date },
    now: Date,
  ): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.db.insert(gatewaySession).values({ ...input, tokenHash: hashToken(token), issuedAt: now });
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
      })
      .from(gatewaySession)
      .innerJoin(project, eq(project.id, gatewaySession.projectId))
      .where(and(eq(gatewaySession.tokenHash, hashToken(token)), isNull(gatewaySession.revokedAt), gt(gatewaySession.expiresAt, now)));
    if (!row) throw new InvalidSessionError("unknown, expired or revoked gateway session");
    return row;
  }

  /** Revokes every session of a run (run end, kill, restart from checkpoint). */
  async revokeRun(runId: string, now: Date): Promise<void> {
    await this.db.update(gatewaySession).set({ revokedAt: now }).where(and(eq(gatewaySession.runId, runId), isNull(gatewaySession.revokedAt)));
  }
}
