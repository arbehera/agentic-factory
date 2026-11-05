import type { AckWindow } from "./working-time.js";

/**
 * Notification events (FR-NOT-001, SDD §16.3). Phase 0 covers the two P0-WP10 events; the rest of
 * the catalogue arrives with P3-WP6. The audience is resolved by the notifier from the rota.
 */
export const NOTIFICATION_SEVERITIES = ["low", "normal", "high", "critical"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export interface NotificationEventDef {
  severity: NotificationSeverity;
  ackWithin: AckWindow;
  /** What a human should do; part of every message (SDD §16.3 "Content"). */
  suggestedAction: string;
}

export const NOTIFICATION_EVENTS = {
  /** Agent run failed and escalated to Needs Human — role owner group, 4 working hours. */
  "run.needs-human": {
    severity: "high",
    ackWithin: { workingMinutes: 4 * 60 },
    suggestedAction: "Open the run, read the diagnosis, then retry, reassign or fix the task.",
  },
  /** Gate ready for approval — gate approver group, 1 working day. */
  "gate.ready": {
    severity: "normal",
    ackWithin: { workingDays: 1 },
    suggestedAction: "Review the gate readiness report and approve or reject the gate in Jira.",
  },
} as const satisfies Record<string, NotificationEventDef>;

export type NotificationEvent = keyof typeof NOTIFICATION_EVENTS;
export const NOTIFICATION_EVENT_NAMES = Object.keys(NOTIFICATION_EVENTS) as NotificationEvent[];

/**
 * Escalation ladder (SDD §16.3): the on-duty member first, then the backup, then the Program Lead.
 * Level 2 is the top; an unacknowledged item stays there and keeps being re-sent each window.
 */
export const MAX_ESCALATION_LEVEL = 2;

export function escalationRecipients(group: readonly string[], programLead: string, level: number): string[] {
  if (level <= 0) return group.slice(0, 1);
  if (level === 1) return group.length > 1 ? group.slice(1, 2) : [programLead];
  return [programLead];
}
