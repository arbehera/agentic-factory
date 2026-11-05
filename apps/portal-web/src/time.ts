/** The portal shows times in Asia/Kolkata unless the user chooses otherwise (CLAUDE.md §6). */
export const DISPLAY_TIME_ZONE = "Asia/Kolkata";

export function formatTime(iso: string | null, timeZone = DISPLAY_TIME_ZONE): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "medium" }).format(new Date(iso));
}

export function formatAge(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
