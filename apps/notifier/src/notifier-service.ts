import { ackDeadline, escalationRecipients, NOTIFICATION_EVENTS, type NotificationEvent, type WorkingCalendar } from "@adlc/domain";
import type { NotificationRepository, NotificationRow } from "@adlc/db";
import { rotaGroup, type Rota } from "@adlc/schemas";
import type { Logger } from "@adlc/telemetry";
import type { EmailChannel } from "./email.js";

export interface Clock {
  now(): Date;
}

export interface TickResult {
  routed: number;
  escalated: number;
  delivered: number;
  failed: number;
}

/**
 * Notification service (C10, FR-NOT-001/002, SDD §16.3). Each tick:
 *  1. routes new events: recipients from the rota (on-duty first) and an acknowledgement deadline
 *     in working time;
 *  2. escalates unacknowledged events past their deadline — backup, then the Program Lead, who
 *     keeps receiving it every window until someone acknowledges;
 *  3. delivers every level not yet sent, by email (the portal inbox reads the same rows).
 * Delivery failures are retried on the next tick. Acknowledgement happens in the portal.
 */
export class NotifierService {
  constructor(
    private readonly repo: NotificationRepository,
    private readonly email: EmailChannel,
    private readonly rota: Rota,
    private readonly calendar: WorkingCalendar,
    private readonly portalUrl: string,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async tick(): Promise<TickResult> {
    const result: TickResult = { routed: 0, escalated: 0, delivered: 0, failed: 0 };
    const now = this.clock.now();

    for (const n of await this.repo.unrouted()) {
      await this.repo.route(n.id, this.recipients(n, 0), this.deadline(n, now), now);
      result.routed++;
    }

    for (const n of await this.repo.overdue(now)) {
      const level = n.escalationLevel + 1;
      if (await this.repo.escalate(n.id, level, this.recipients(n, level), this.deadline(n, now), now)) {
        this.logger.warn({ notificationId: n.id, event: n.event, level }, "notification escalated");
        result.escalated++;
      }
    }

    for (const n of await this.repo.undelivered()) {
      try {
        await this.email.send({ to: n.recipients, subject: `[ADLC ${n.severity.toUpperCase()}] ${n.title}`, text: this.message(n) });
        await this.repo.markSent(n.id, n.escalationLevel, this.clock.now());
        result.delivered++;
      } catch (err) {
        this.logger.error({ notificationId: n.id, err: (err as Error).message }, "notification delivery failed; will retry");
        result.failed++;
      }
    }
    return result;
  }

  private def(n: NotificationRow) {
    return NOTIFICATION_EVENTS[n.event as NotificationEvent] as (typeof NOTIFICATION_EVENTS)[NotificationEvent] | undefined;
  }

  private recipients(n: NotificationRow, level: number): string[] {
    const group = rotaGroup(this.rota, n.audience);
    if (!group) {
      // An audience the rota does not know still reaches a human: the Program Lead.
      this.logger.error({ notificationId: n.id, audience: n.audience }, "audience not in rota; sending to the Program Lead");
      return [this.rota.programLead];
    }
    return escalationRecipients(group, this.rota.programLead, level);
  }

  private deadline(n: NotificationRow, from: Date): Date {
    // Unknown events get the strictest normal window rather than none.
    return ackDeadline(from, this.def(n)?.ackWithin ?? { workingMinutes: 4 * 60 }, this.calendar);
  }

  /** What happened, why a human is needed, the deadline, the suggested action, and a deep link. */
  private message(n: NotificationRow): string {
    const due = n.dueAt
      ? new Intl.DateTimeFormat("en-GB", { timeZone: this.calendar.timeZone, dateStyle: "medium", timeStyle: "short" }).format(n.dueAt) + ` (${this.calendar.timeZone})`
      : "not set";
    return [
      n.body,
      "",
      `Acknowledge by: ${due}`,
      `Suggested action: ${this.def(n)?.suggestedAction ?? "Open the item and decide what to do."}`,
      `Open: ${this.portalUrl}${n.link}`,
      n.escalationLevel > 0 ? `\nEscalated (level ${n.escalationLevel}): it was not acknowledged in time.` : "",
    ].join("\n");
  }
}
