import { z } from "zod";

/** Gateway configuration from the environment (NFR-009), validated at start-up. */
export const gatewayConfigSchema = z
  .object({
    DATABASE_URL: z.url(),
    PORT: z.coerce.number().int().min(0).max(65535).default(3001),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    /** Jira and GitHub adapters: `dev-fakes` for Compose and e2e; `jira-github` after Q-04. */
    ADAPTERS: z.enum(["dev-fakes", "jira-github"]),
    FAKES_URL: z.url().optional(),
    FAKES_TOKEN: z.string().min(16).optional(),
    /** Directory holding `<role>/policy.yaml` (FR-AGT policy, ADR-0010). */
    AGENTS_DIR: z.string().min(1).default("agents"),
    /** Model proxy: off unless an upstream is configured. The key is read as a secret, never logged. */
    MODEL_UPSTREAM_URL: z.url().optional(),
    MODEL_API_KEY_SECRET: z.string().min(1).default("claude-api-key"),
    MODEL_MAX_TOKENS_CAP: z.coerce.number().int().positive().default(8192),
  })
  .strip();
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

export class GatewayStartupError extends Error {
  override name = "GatewayStartupError";
}

export function loadGatewayConfig(env: Record<string, string | undefined>): GatewayConfig {
  const r = gatewayConfigSchema.safeParse(env);
  if (!r.success) throw new GatewayStartupError(`invalid gateway configuration: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}
