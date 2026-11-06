import { z } from "zod";

/** Orchestrator configuration from the environment (NFR-009), validated at start-up. */
export const orchestratorConfigSchema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** NFR-003: dispatch latency < 30 s, so the dispatcher ticks well inside that. */
  DISPATCH_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  REAP_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  LEADER_POLL_MS: z.coerce.number().int().positive().default(2_000),
  MAINTENANCE_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  /** FR-ORC-014: concurrent executor slots, and how many sandbox projects may hold (pilot 8 / 2). */
  EXECUTOR_SLOTS: z.coerce.number().int().positive().default(8),
  SANDBOX_SLOTS: z.coerce.number().int().min(0).default(2),
  /** Executor (P0-WP4). Without AGENT_IMAGE no containers are started on this replica. */
  AGENT_IMAGE: z.string().regex(/^(?:[a-z0-9]+(?:[._/:-][a-z0-9]+)*@)?sha256:[0-9a-f]{64}$/, "must be pinned by sha256 digest").optional(),
  AGENT_GATEWAY_URL: z.url().optional(),
  AGENT_NETWORK: z.string().min(1).default("adlc-agents"),
  AGENT_CPUS: z.coerce.number().positive().default(1),
  AGENT_MEMORY_MB: z.coerce.number().int().positive().default(1024),
  AGENT_PIDS: z.coerce.number().int().positive().default(512),
  AGENT_SCRATCH_MB: z.coerce.number().int().positive().default(2048),
  /** Optional run tuning passed to agent containers; unset = the runtime defaults (5-minute beats). */
  AGENT_HEARTBEAT_MS: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(1_000).optional()),
  /** Phase 0 load test (AT-P0-05): how long the dummy agent works before opening its PR. */
  AGENT_DUMMY_WORK_MS: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(0).max(3_600_000).optional()),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1_000),
  SUPERVISE_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  /** Jira and GitHub adapters (P0-WP11): `dev-fakes` for Compose and e2e; `jira-github` after Q-04. */
  ADAPTERS: z.enum(["dev-fakes", "jira-github"]).optional(),
  FAKES_URL: z.url().optional(),
  FAKES_TOKEN: z.string().min(16).optional(),
  /** Role the Phase 0 ready source offers tasks to; without it nothing is dispatched. */
  DISPATCH_ROLE: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(),
  /** Required reviewer roles per author role (agents/reviewer-sets.yaml); enables the review flow. */
  REVIEWER_SETS_FILE: z.string().min(1).optional(),
  REVIEW_FLOW_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  /** Bearer token for the internal routes (live logs for the portal API). Unset: routes off. */
  INTERNAL_API_TOKEN: z.string().min(32).optional(),
  /** Write-once audit/evidence export (NFR-006, ADR-0015). Unset endpoint: export off (logged). */
  OBJECT_STORE_ENDPOINT: z.url().optional(),
  OBJECT_STORE_BUCKET: z.string().optional(),
  OBJECT_STORE_REGION: z.string().optional(),
  OBJECT_STORE_ACCESS_KEY_ID: z.string().optional(),
  OBJECT_STORE_SECRET_ACCESS_KEY: z.string().optional(),
  /** Compliance retention of exported objects. No default: the period is an ISMS decision. */
  AUDIT_EXPORT_RETENTION_DAYS: z.coerce.number().int().positive().max(36_500).optional(),
  AUDIT_EXPORT_EVERY_MS: z.coerce.number().int().positive().default(86_400_000),
});
export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: Record<string, string | undefined>): OrchestratorConfig {
  const r = orchestratorConfigSchema
    .refine((c) => c.SANDBOX_SLOTS <= c.EXECUTOR_SLOTS, { path: ["SANDBOX_SLOTS"], message: "must not exceed EXECUTOR_SLOTS" })
    .refine((c) => !c.AGENT_IMAGE || c.AGENT_GATEWAY_URL, { path: ["AGENT_GATEWAY_URL"], message: "is required when AGENT_IMAGE is set" })
    .refine((c) => !c.OBJECT_STORE_ENDPOINT || c.AUDIT_EXPORT_RETENTION_DAYS, { path: ["AUDIT_EXPORT_RETENTION_DAYS"], message: "is required with OBJECT_STORE_ENDPOINT (retention per ISMS)" })
    .refine((c) => !c.DISPATCH_ROLE || c.ADAPTERS, { path: ["DISPATCH_ROLE"], message: "needs ADAPTERS (the ready source reads Jira)" })
    .safeParse(env);
  if (!r.success) {
    throw new ConfigError(`invalid orchestrator configuration: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return r.data;
}
