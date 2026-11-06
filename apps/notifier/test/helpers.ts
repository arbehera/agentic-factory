import type { WorkingCalendar } from "@adlc/domain";
import type { Rota } from "@adlc/schemas";
import type { EmailChannel, EmailMessage } from "../src/index.js";

export class FakeEmail implements EmailChannel {
  readonly sent: EmailMessage[] = [];
  failNext = false;
  send(m: EmailMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("smtp down"));
    }
    this.sent.push(m);
    return Promise.resolve();
  }
}

export const ROTA: Rota = {
  programLead: "lead@example.invalid",
  roleOwners: { dummy: ["onduty@example.invalid", "backup@example.invalid"] },
  gateApprovers: { G5: ["g5@example.invalid"] },
};
export const CALENDAR: WorkingCalendar = { timeZone: "Asia/Kolkata", workingDays: [1, 2, 3, 4, 5], dayStart: "09:00", dayEnd: "18:00", holidays: [] };
