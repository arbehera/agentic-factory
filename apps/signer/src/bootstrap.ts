import { createAdapters, type SourceControl } from "@adlc/adapters";
import { SoftwareEd25519Signer } from "@adlc/attestation";
import { SIGN_EVIDENCE_JOB, Worker, type Clock } from "@adlc/control-plane";
import { createDb, createPool, JobQueue } from "@adlc/db";
import type { ReviewerSets } from "@adlc/schemas";
import type { Logger } from "@adlc/telemetry";
import type pg from "pg";
import { z } from "zod";
import { SignerService } from "./signer-service.js";

/** Signer configuration from the environment (NFR-009). */
export const signerConfigSchema = z
  .object({
    DATABASE_URL: z.url(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    ADAPTERS: z.enum(["dev-fakes", "jira-github"]),
    FAKES_URL: z.url().optional(),
    FAKES_TOKEN: z.string().min(16).optional(),
    REVIEWER_SETS_FILE: z.string().min(1).default("agents/reviewer-sets.yaml"),
    /** Condition (d): checks that must be green on the head before signing. */
    REQUIRED_CHECKS: z.string().default("adlc/verify").transform((v) => v.split(",").map((c) => c.trim()).filter(Boolean)),
    /** Software keys are refused in production (OPEN-07: HSM/KMS key arrives with the pilot). */
    SIGNER_ENVIRONMENT: z.enum(["dev", "test", "sandbox", "production"]),
    /** Ed25519 private key (PEM). Unset in dev: an ephemeral key is generated and its public half logged. */
    SIGNER_KEY_PEM: z.string().min(1).optional(),
    WORKER_POLL_MS: z.coerce.number().int().positive().default(2_000),
  })
  .strip();
export type SignerServiceConfig = z.infer<typeof signerConfigSchema>;

const signPayload = z.object({ repo: z.string().min(1), prNumber: z.number().int().positive(), headSha: z.string(), authorRole: z.string().min(1) });

/**
 * Signer service (C8, P0-WP11): a worker on the PostgreSQL queue that claims only signing jobs.
 * The orchestrator requests a signature; the signer decides, re-checking all four FR-EVD-002
 * conditions itself (SignerService). It holds the only signing key.
 */
export function buildSigner(
  config: SignerServiceConfig,
  deps: { reviewerSets: ReviewerSets; clock: Clock; logger: Logger; scm?: SourceControl },
): { worker: Worker; signer: SignerService; publicKeyPem: string; keyId: string; pool: pg.Pool } {
  const key = config.SIGNER_KEY_PEM
    ? SoftwareEd25519Signer.fromPem(config.SIGNER_KEY_PEM, config.SIGNER_ENVIRONMENT)
    : SoftwareEd25519Signer.generate(config.SIGNER_ENVIRONMENT);
  const scm = deps.scm ?? createAdapters(config).scm;
  const pool = createPool(config.DATABASE_URL, { onIdleError: (err) => {
    deps.logger.warn({ err: err.message }, "idle database connection closed");
  } });
  const db = createDb(pool);
  const signer = new SignerService(db, scm, key, { reviewerSets: deps.reviewerSets, requiredChecks: config.REQUIRED_CHECKS }, deps.clock, deps.logger);
  const worker = new Worker(
    new JobQueue(db),
    {
      [SIGN_EVIDENCE_JOB]: async (job) => {
        const p = signPayload.parse(job.payload);
        const out = await signer.signPullRequest(p.repo, p.prNumber, p.authorRole);
        deps.logger.info({ repo: p.repo, prNumber: p.prNumber, requestedHead: p.headSha, ...out }, out.signed ? "evidence signed" : "signing refused");
        return out;
      },
    },
    deps.clock,
    deps.logger,
    { pollMs: config.WORKER_POLL_MS, lockMs: 60_000, retryMs: 10_000 },
  );
  return { worker, signer, publicKeyPem: key.publicKeyPem, keyId: key.keyId, pool };
}
