import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ackDeadline, addWorkingMinutes, escalationRecipients, isWorkingDate, NOTIFICATION_EVENTS, type WorkingCalendar } from "../src/index.js";

// Dev default from config (plan Q-14: Pioneer working hours are to be confirmed).
const IST: WorkingCalendar = { timeZone: "Asia/Kolkata", workingDays: [1, 2, 3, 4, 5], dayStart: "09:00", dayEnd: "18:00", holidays: ["2026-11-09"] };
const ist = (local: string) => new Date(`${local}+05:30`);

describe("FR-NOT-002 working-time deadlines (Asia/Kolkata)", () => {
  it("FR-NOT-002 counts only working hours: same day, across the night, across a weekend and a holiday", () => {
    expect(addWorkingMinutes(ist("2026-11-05T10:00:00"), 240, IST)).toEqual(ist("2026-11-05T14:00:00")); // Thu
    expect(addWorkingMinutes(ist("2026-11-05T16:00:00"), 240, IST)).toEqual(ist("2026-11-06T11:00:00")); // into Fri
    expect(addWorkingMinutes(ist("2026-11-06T17:00:00"), 240, IST)).toEqual(ist("2026-11-10T12:00:00")); // Fri → Sat, Sun, holiday Mon → Tue
    expect(addWorkingMinutes(ist("2026-11-07T23:00:00"), 60, IST)).toEqual(ist("2026-11-10T10:00:00")); // raised on Saturday night
    expect(addWorkingMinutes(ist("2026-11-05T07:30:00"), 30, IST)).toEqual(ist("2026-11-05T09:30:00")); // before opening
  });

  it("FR-NOT-002 Critical events ignore the calendar; one working day is one full working day", () => {
    expect(ackDeadline(ist("2026-11-07T23:00:00"), { wallClockMinutes: 60 }, IST)).toEqual(ist("2026-11-08T00:00:00"));
    expect(ackDeadline(ist("2026-11-05T10:00:00"), NOTIFICATION_EVENTS["gate.ready"].ackWithin, IST)).toEqual(ist("2026-11-06T10:00:00"));
    expect(ackDeadline(ist("2026-11-05T10:00:00"), NOTIFICATION_EVENTS["run.needs-human"].ackWithin, IST)).toEqual(ist("2026-11-05T14:00:00"));
  });

  it("FR-NOT-002 property: the deadline is never earlier than start + the window, and lands in working hours", () => {
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }), fc.integer({ min: 1, max: 5000 }), (startMs, minutes) => {
        const start = new Date(startMs);
        const due = addWorkingMinutes(start, minutes, IST);
        expect(due.getTime()).toBeGreaterThanOrEqual(start.getTime() + minutes * 60_000 - 1);
        const local = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(due);
        expect(local >= "09:00" && local <= "18:00").toBe(true);
        expect(isWorkingDate(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(due), IST)).toBe(true);
      }),
    );
  });

  it("rejects a calendar without working time", () => {
    expect(() => addWorkingMinutes(new Date(), 10, { ...IST, workingDays: [] })).toThrow(/no working time/);
  });
});

describe("FR-NOT-002 escalation ladder", () => {
  it("FR-NOT-002 on-duty member first, then the backup, then the Program Lead", () => {
    const group = ["primary@example.invalid", "backup@example.invalid", "third@example.invalid"];
    expect([0, 1, 2, 3].map((l) => escalationRecipients(group, "lead@example.invalid", l))).toEqual([
      ["primary@example.invalid"],
      ["backup@example.invalid"],
      ["lead@example.invalid"],
      ["lead@example.invalid"],
    ]);
    expect(escalationRecipients(["only@example.invalid"], "lead@example.invalid", 1)).toEqual(["lead@example.invalid"]);
  });
});
