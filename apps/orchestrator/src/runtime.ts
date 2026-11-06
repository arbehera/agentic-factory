import type { Logger } from "@adlc/telemetry";
import type { LeaderElector } from "./leader-elector.js";

export interface LeaderJob {
  name: string;
  intervalMs: number;
  run(): Promise<unknown>;
}

/**
 * Runs leader-only jobs (dispatch, lease reaping, partition maintenance) while this replica holds
 * leadership, and stops them as soon as it loses it (FR-ORC-015). A job never overlaps itself,
 * and a failing job is logged and retried on its next interval.
 */
export class OrchestratorRuntime {
  private timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();

  constructor(
    private readonly elector: LeaderElector,
    private readonly jobs: readonly LeaderJob[],
    private readonly logger: Logger,
  ) {
    elector.onChange((leader) => {
      if (leader) this.startJobs();
      else this.stopJobs();
    });
  }

  start(): void {
    this.elector.start();
  }

  async stop(): Promise<void> {
    this.stopJobs();
    await this.elector.stop();
  }

  /** Runs one job now if it is not already running. Exposed for tests. */
  async runJob(job: LeaderJob): Promise<void> {
    if (this.running.has(job.name) || !this.elector.isLeader) return;
    this.running.add(job.name);
    try {
      await job.run();
    } catch (err) {
      this.logger.error({ job: job.name, err: (err as Error).message }, "leader job failed");
    } finally {
      this.running.delete(job.name);
    }
  }

  private startJobs(): void {
    this.stopJobs();
    for (const job of this.jobs) {
      void this.runJob(job);
      this.timers.push(setInterval(() => void this.runJob(job), job.intervalMs));
    }
  }

  private stopJobs(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
