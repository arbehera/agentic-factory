import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** `config/working-calendar.yaml` (FR-NOT-002): local working hours and holidays. */
export const workingCalendarSchema = z
  .strictObject({
    timeZone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "unknown time zone"),
    workingDays: z.array(z.number().int().min(1).max(7)).min(1),
    dayStart: hhmm,
    dayEnd: hhmm,
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  })
  .refine((c) => c.dayStart < c.dayEnd, { path: ["dayEnd"], message: "must be after dayStart" });
export type WorkingCalendarConfig = z.infer<typeof workingCalendarSchema>;
