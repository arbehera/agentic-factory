import { pino, stdTimeFunctions, type DestinationStream, type Logger } from "pino";

/**
 * Structured JSON logging (CLAUDE.md §6). Every log line carries the service name; callers add
 * correlation fields (`projectId`, `runId`, `taskKey`, `traceId`) with `logger.child({...})`.
 * Secrets never reach logs (hard rule 9): common credential fields are redacted as a backstop.
 * OpenTelemetry spans and metrics are added with NFR-005.
 */
export type { Logger };

export const REDACTED_PATHS = ["*.password", "*.token", "*.secret", "*.apiKey", "*.authorization", "headers.authorization"];

export function createLogger(service: string, options: { level?: string; destination?: DestinationStream } = {}): Logger {
  return pino(
    {
      level: options.level ?? process.env.LOG_LEVEL ?? "info",
      base: { service },
      timestamp: stdTimeFunctions.isoTime,
      redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    },
    options.destination ?? process.stdout,
  );
}
