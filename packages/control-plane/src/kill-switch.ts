import type { Actor } from "@adlc/domain";
import type { ControlFlagRepository } from "@adlc/db";
import type { Clock } from "./clock.js";

export const KILL_SWITCH_FLAG = "kill-switch";

export class KillSwitchError extends Error {
  override name = "KillSwitchError";
}

/**
 * Global kill switch (FR-ORC-012). While engaged the dispatcher claims nothing, and every
 * heartbeat answers "stop-after-step": running steps finish, push WIP and stop. Anyone with
 * access may engage it; only a human may release it. Both need a reason and are audited.
 */
export class KillSwitch {
  constructor(
    private readonly flags: ControlFlagRepository,
    private readonly clock: Clock,
  ) {}

  async isEngaged(): Promise<boolean> {
    return (await this.flags.get(KILL_SWITCH_FLAG))?.enabled ?? false;
  }

  async engage(actor: Actor, reason: string): Promise<void> {
    if (reason.trim() === "") throw new KillSwitchError("a reason is required");
    await this.flags.set(KILL_SWITCH_FLAG, true, actor, reason, this.clock.now());
  }

  async release(actor: Actor, reason: string): Promise<void> {
    if (actor.kind !== "human") throw new KillSwitchError("only a human may release the kill switch");
    if (reason.trim() === "") throw new KillSwitchError("a reason is required");
    await this.flags.set(KILL_SWITCH_FLAG, false, actor, reason, this.clock.now());
  }
}
