import { z } from "zod";

/** Portal API configuration from the environment (NFR-009), validated at start-up. */
export const portalConfigSchema = z
  .object({
    DATABASE_URL: z.url(),
    PORT: z.coerce.number().int().min(0).max(65535).default(3002),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    /** Token issuer as browsers see it (the `iss` claim), e.g. http://localhost:8080/realms/adlc. */
    OIDC_ISSUER: z.url(),
    OIDC_AUDIENCE: z.string().min(1).default("adlc-portal"),
    /** Where this service fetches the realm keys; defaults to the issuer's certs endpoint. */
    OIDC_JWKS_URL: z.url().optional(),
    /** Orchestrator replicas serving the internal live-log route, comma-separated. */
    ORCHESTRATOR_URLS: z
      .string()
      .optional()
      .transform((v) => (v ? v.split(",").map((u) => u.trim()).filter(Boolean) : []))
      .pipe(z.array(z.url())),
    INTERNAL_API_TOKEN: z.string().min(32).optional(),
  })
  .strip()
  .refine((c) => c.ORCHESTRATOR_URLS.length === 0 || c.INTERNAL_API_TOKEN, { path: ["INTERNAL_API_TOKEN"], message: "is required with ORCHESTRATOR_URLS" });
export type PortalConfig = z.infer<typeof portalConfigSchema>;

export class PortalStartupError extends Error {
  override name = "PortalStartupError";
}

export function loadPortalConfig(env: Record<string, string | undefined>): PortalConfig {
  const r = portalConfigSchema.safeParse(env);
  if (!r.success) throw new PortalStartupError(`invalid portal configuration: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

export function jwksUrl(c: PortalConfig): string {
  return c.OIDC_JWKS_URL ?? `${c.OIDC_ISSUER.replace(/\/$/, "")}/protocol/openid-connect/certs`;
}
