/**
 * The container contract, importable without any Docker code as `@adlc/executor/contract`
 * (the agent runtime uses it; the agent image must not contain a Docker client).
 *
 * ExecutorBackend (spec.md §7, C2): creates, runs and destroys one container per agent run
 * (hard rule 6). The pilot uses Docker (rootless); a Kubernetes backend can implement the same
 * interface later (SDD §17.4).
 */

export interface RunLimits {
  /** CPU cores (fractional allowed). */
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  /** Size of the writable scratch space (/workspace + /tmp); doubles as the disk limit. */
  scratchMb: number;
}

export interface RunSpec {
  runId: string;
  /** Digest-pinned image: `<name>@sha256:<64 hex>`, or a local image ID `sha256:<64 hex>`. */
  image: string;
  /** Non-secret configuration only; the gateway session token is the one credential allowed. */
  env: Readonly<Record<string, string>>;
  limits: RunLimits;
  /** The internal (no-egress) agent network; its only reachable service is the gateway. */
  network: string;
  command?: readonly string[];
}

export interface RunHandle {
  runId: string;
  containerId: string;
}

export interface RunStatus {
  state: "created" | "running" | "exited" | "missing";
  exitCode: number | null;
  oomKilled: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface LogLine {
  stream: "stdout" | "stderr";
  line: string;
}

export interface ExecutorBackend {
  create(spec: RunSpec): Promise<RunHandle>;
  start(h: RunHandle): Promise<void>;
  /** Graceful stop (SIGTERM, then kill after a grace period). Idempotent. */
  stop(h: RunHandle, reason: string): Promise<void>;
  status(h: RunHandle): Promise<RunStatus>;
  logs(h: RunHandle, opts: { follow: boolean }): AsyncIterable<LogLine>;
  /** Removes the container and its anonymous volumes. Idempotent. */
  delete(h: RunHandle): Promise<void>;
}

/**
 * Exit codes of the agent runtime (the contract between the container and the supervisor).
 * Anything other than these is a failure.
 */
export const RUN_EXIT_CODES = {
  succeeded: 0,
  failed: 1,
  /** The run obeyed a stop-after-step directive (kill switch, budget) after pushing its WIP. */
  stoppedByDirective: 3,
} as const;
