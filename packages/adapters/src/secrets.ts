/**
 * Secret access (hard rule 9, NFR-001). Only the gateway and orchestrator read secrets, and only
 * to build adapters; secrets never reach tool results, logs, prompts or model context.
 * The vault backend is chosen with the deployment (P0-WP11); dev reads environment variables.
 */
export interface SecretProvider {
  get(name: string): Promise<string>;
  /** Every secret value handed out so far, for output redaction. */
  knownValues(): readonly string[];
}

export class SecretNotFoundError extends Error {
  override name = "SecretNotFoundError";
}

/** Dev/test provider over an environment map; names map to `ADLC_SECRET_<NAME>`. */
export class EnvSecretProvider implements SecretProvider {
  private readonly handed = new Set<string>();
  constructor(private readonly env: Record<string, string | undefined>) {}

  get(name: string): Promise<string> {
    const value = this.env[`ADLC_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
    if (!value) return Promise.reject(new SecretNotFoundError(`secret ${name} is not configured`));
    this.handed.add(value);
    return Promise.resolve(value);
  }

  knownValues(): readonly string[] {
    return [...this.handed];
  }
}

export const REDACTED = "[redacted]";

/** Replaces every known secret value (min. 6 chars, to avoid scrubbing common words) in `value`. */
export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  const active = secrets.filter((s) => s.length >= 6);
  if (active.length === 0) return value;
  const scrub = (v: unknown): unknown => {
    if (typeof v === "string") return active.reduce((s, secret) => s.split(secret).join(REDACTED), v);
    if (Array.isArray(v)) return v.map(scrub);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
    return v;
  };
  return scrub(value) as T;
}
