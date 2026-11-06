/**
 * Working-time arithmetic for notification deadlines (FR-NOT-002, SDD §16.3): acknowledgement
 * SLAs count working time only — nights, weekends and holidays do not count — in the configured
 * time zone (Asia/Kolkata for the pilot). Critical events ignore the calendar.
 *
 * The working hours and holiday list are Pioneer facts (plan Q-14); they come from configuration.
 */

export interface WorkingCalendar {
  timeZone: string;
  /** ISO weekdays that are working days: 1 = Monday … 7 = Sunday. */
  workingDays: readonly number[];
  /** Local start and end of the working day, "HH:MM", end after start. */
  dayStart: string;
  dayEnd: string;
  /** Local holiday dates, "YYYY-MM-DD". */
  holidays: readonly string[];
}

interface LocalParts {
  date: string; // YYYY-MM-DD
  isoWeekday: number;
  minuteOfDay: number;
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short" });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function localParts(t: Date, timeZone: string): LocalParts {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(t).map((x) => [x.type, x.value]));
  return {
    date: `${p.year ?? ""}-${p.month ?? ""}-${p.day ?? ""}`,
    isoWeekday: WEEKDAYS[p.weekday ?? ""] ?? 0,
    minuteOfDay: Number(p.hour) * 60 + Number(p.minute) + Number(p.second) / 60,
  };
}

/** The instant at local `date` + `minuteOfDay` in `timeZone` (offset found by correction). */
function zonedInstant(date: string, minuteOfDay: number, timeZone: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const guess = Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1, 0, minuteOfDay);
  let t = guess;
  for (let i = 0; i < 3; i++) {
    const lp = localParts(new Date(t), timeZone);
    const [ly, lmo, ld] = lp.date.split("-").map(Number);
    const asUtc = Date.UTC(ly ?? 1970, (lmo ?? 1) - 1, ld ?? 1, 0, Math.round(lp.minuteOfDay));
    t += guess - asUtc;
  }
  return new Date(t);
}

function nextDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10);
}

function isoWeekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const wd = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function isWorkingDate(date: string, cal: WorkingCalendar): boolean {
  return cal.workingDays.includes(isoWeekdayOf(date)) && !cal.holidays.includes(date);
}

export function workingDayMinutes(cal: WorkingCalendar): number {
  return toMinutes(cal.dayEnd) - toMinutes(cal.dayStart);
}

/** `start` plus `minutes` of working time. Time outside working hours does not count. */
export function addWorkingMinutes(start: Date, minutes: number, cal: WorkingCalendar): Date {
  const open = toMinutes(cal.dayStart);
  const close = toMinutes(cal.dayEnd);
  let remaining = minutes;
  // Step from the real start instant; instants are only rebuilt at whole-minute day openings, so
  // sub-second precision of the start is never lost.
  let cursor = start;
  let { date, minuteOfDay: at } = localParts(start, cal.timeZone);
  for (let guard = 0; guard < 3700; guard++) {
    if (isWorkingDate(date, cal) && at < close) {
      if (at < open) {
        cursor = zonedInstant(date, open, cal.timeZone);
        at = open;
      }
      const available = close - at;
      if (remaining <= available) return new Date(cursor.getTime() + remaining * 60_000);
      remaining -= available;
    }
    date = nextDate(date);
    at = 0;
    cursor = zonedInstant(date, 0, cal.timeZone);
  }
  throw new Error("working calendar has no working time in the next ten years");
}

/** An acknowledgement window: working time for normal events, wall-clock time for Critical ones. */
export type AckWindow = { workingMinutes: number } | { workingDays: number } | { wallClockMinutes: number };

export function ackDeadline(start: Date, window: AckWindow, cal: WorkingCalendar): Date {
  if ("wallClockMinutes" in window) return new Date(start.getTime() + window.wallClockMinutes * 60_000);
  const minutes = "workingDays" in window ? window.workingDays * workingDayMinutes(cal) : window.workingMinutes;
  return addWorkingMinutes(start, minutes, cal);
}
