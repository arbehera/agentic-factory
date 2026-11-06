import { randomUUID } from "node:crypto";
import type { JobQueue, JobRow } from "@adlc/db";
import type { Clock } from "./clock.js";
import type { Logger } from "@adlc/telemetry";

export type JobHandler = (job: JobRow) => Promise<unknown>;

/** Signing requests (one per PR head). Only the signer claims them, on its own node with the key. */
export const SIGN_EVIDENCE_JOB = "sign-evidence";

/**
 * Job worker on the PostgreSQL queue (hard rule 8). Every orchestrator replica runs one for its job
 * kinds (FR-ORC-015: replicas other than the leader are stateless workers); the signer runs one
 * for signing jobs only, on its own node. Claims one job at a time from the PostgreSQL queue and runs its handler.
 */
export class Worker {
  readonly id = `worker-${randomUUID().slice(0, 8)}`;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: Readonly<Record<string, JobHandler>>,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly opts: { pollMs: number; lockMs: number; retryMs: number },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain(), this.opts.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Processes jobs until none is ready. Exposed for tests. */
  async drain(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let done = 0;
    try {
      for (;;) {
        const job = await this.queue.claim(this.id, Object.keys(this.handlers), this.clock.now(), this.opts.lockMs);
        if (!job) return done;
        const handler = this.handlers[job.kind];
        try {
          if (!handler) throw new Error(`no handler for ${job.kind}`);
          await handler(job);
          await this.queue.complete(job.id, this.id, this.clock.now());
        } catch (err) {
          const outcome = await this.queue.fail(job.id, this.id, (err as Error).message, this.clock.now(), this.opts.retryMs);
          this.logger.error({ jobId: job.id, kind: job.kind, outcome, err: (err as Error).message }, "job failed");
        }
        done++;
      }
    } finally {
      this.busy = false;
    }
  }
}
