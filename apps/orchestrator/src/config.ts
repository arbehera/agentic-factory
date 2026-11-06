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
});
export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: Record<string, string | undefined>): OrchestratorConfig {
  const r = orchestratorConfigSchema.safeParse(env);
  if (!r.success) {
    throw new ConfigError(`invalid orchestrator configuration: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return r.data;
}
