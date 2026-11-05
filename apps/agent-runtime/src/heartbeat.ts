import type { Logger } from "@adlc/telemetry";
import type { GatewayClient } from "./gateway-client.js";

/**
 * Heartbeats (FR-ORC-008): every interval (5 minutes in production, three per lease TTL) the run
 * renews its lease through the gateway. The reply can ask the run to stop after its current step
 * (kill switch, budget) or report that the lease is gone, in which case the run must stop at once.
 */
export class Heartbeater {
  private timer: NodeJS.Timeout | null = null;
  private stopAfterStep = false;
  private lost = false;
  private usage = { tokens: 0, costUsd: 0 };

  constructor(
    private readonly gateway: GatewayClient,
    private readonly logger: Logger,
  ) {}

  /** Methods, not getters: these change asynchronously while the run proceeds. */
  stopRequested(): boolean {
    return this.stopAfterStep || this.lost;
  }

  leaseLost(): boolean {
    return this.lost;
  }

  /** Usage since the last beat (model calls arrive with the agent SDK; the dummy agent has none). */
  addUsage(tokens: number, costUsd: number): void {
    this.usage = { tokens: this.usage.tokens + tokens, costUsd: this.usage.costUsd + costUsd };
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.beat(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async beat(): Promise<void> {
    const usage = this.usage;
    this.usage = { tokens: 0, costUsd: 0 };
    try {
      const directive = await this.gateway.heartbeat(usage);
      if (directive === "stop") this.lost = true;
      if (directive === "stop-after-step") this.stopAfterStep = true;
      if (directive !== "continue") this.logger.warn({ directive }, "heartbeat directive");
    } catch (err) {
      // A missed beat is not fatal on its own: the lease survives three intervals.
      this.usage = { tokens: this.usage.tokens + usage.tokens, costUsd: this.usage.costUsd + usage.costUsd };
      this.logger.warn({ err: (err as Error).message }, "heartbeat failed");
    }
  }
}
