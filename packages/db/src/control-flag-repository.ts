import { stateHash, type Actor } from "@adlc/domain";
import { eq } from "drizzle-orm";
import { AuditRepository } from "./audit-repository.js";
import type { Db } from "./client.js";
import { controlFlag } from "./schema.js";

export type ControlFlagRow = typeof controlFlag.$inferSelect;

/** Shared control-plane switches (e.g. the kill switch), audited on every change. */
export class ControlFlagRepository {
  constructor(private readonly db: Db) {}

  async get(key: string): Promise<ControlFlagRow | null> {
    const [row] = await this.db.select().from(controlFlag).where(eq(controlFlag.key, key));
    return row ?? null;
  }

  async set(key: string, enabled: boolean, actor: Actor, reason: string, now: Date): Promise<ControlFlagRow> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(controlFlag).where(eq(controlFlag.key, key)).for("update");
      const values = { enabled, reason, setBy: `${actor.kind}:${actor.id}`, setAt: now };
      const [row] = await tx
        .insert(controlFlag)
        .values({ key, ...values })
        .onConflictDoUpdate({ target: controlFlag.key, set: values })
        .returning();
      if (!row) throw new Error("upsert returned no row");
      await new AuditRepository(tx).append({
        actor,
        action: "control.flag",
        target: `flag:${key}`,
        reason: `${enabled ? "engaged" : "released"}: ${reason}`,
        beforeHash: before ? stateHash({ key, enabled: before.enabled }) : null,
        afterHash: stateHash({ key, enabled }),
        correlation: {},
      });
      return row;
    });
  }
}
