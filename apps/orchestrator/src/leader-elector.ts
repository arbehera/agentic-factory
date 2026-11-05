import type { Logger } from "@adlc/telemetry";
import pg from "pg";

/**
 * Dispatcher leader election (FR-ORC-015) with a PostgreSQL session advisory lock (hard rule 8).
 * The lock lives on one dedicated connection: if that connection dies, PostgreSQL releases the
 * lock and another replica takes it on its next poll. The leader also checks its connection on
 * every poll and steps down the moment the check fails. Brief overlap between an old leader that
 * has not yet noticed and a new one is harmless: every write is fenced by lease tokens.
 */
export class LeaderElector {
  private client: pg.Client | null = null;
  private leader = false;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private readonly listeners = new Set<(leader: boolean) => void>();

  constructor(
    private readonly connectionString: string,
    private readonly lockKey: number,
    private readonly pollMs: number,
    private readonly logger: Logger,
  ) {}

  get isLeader(): boolean {
    return this.leader;
  }

  onChange(listener: (leader: boolean) => void): void {
    this.listeners.add(listener);
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const client = this.client;
    this.client = null;
    if (client) {
      if (this.leader) await client.query("select pg_advisory_unlock($1)", [this.lockKey]).catch(() => undefined);
      await client.end().catch(() => undefined);
    }
    this.setLeader(false);
  }

  /** One election round; never throws. Exposed for tests. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const client = await this.connection();
      if (this.leader) {
        await client.query("select 1");
      } else {
        const r = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [this.lockKey]);
        if (r.rows[0]?.ok) this.setLeader(true);
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, "leader election connection lost");
      this.dropConnection();
    } finally {
      this.polling = false;
    }
  }

  private async connection(): Promise<pg.Client> {
    if (this.client) return this.client;
    const client = new pg.Client({ connectionString: this.connectionString, application_name: "adlc-orchestrator-leader" });
    client.on("error", () => {
      this.dropConnection();
    });
    await client.connect();
    this.client = client;
    return client;
  }

  private dropConnection(): void {
    const client = this.client;
    this.client = null;
    if (client) void client.end().catch(() => undefined);
    this.setLeader(false);
  }

  private setLeader(value: boolean): void {
    if (this.leader === value) return;
    this.leader = value;
    this.logger.info({ leader: value }, value ? "became dispatcher leader" : "stepped down as dispatcher leader");
    for (const l of this.listeners) l(value);
  }
}
