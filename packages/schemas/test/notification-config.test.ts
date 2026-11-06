import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { rotaGroup, rotaSchema, workingCalendarSchema } from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const load = async (rel: string) => parse(await readFile(path.join(repoRoot, rel), "utf8")) as unknown;

describe("FR-NOT-002 rota and working calendar contracts", () => {
  it("FR-NOT-002 the committed config/rota.yaml and config/working-calendar.yaml are valid", async () => {
    const rota = rotaSchema.parse(await load("config/rota.yaml"));
    expect(rota.roleOwners.dummy?.length).toBeGreaterThan(1); // on-duty + backup
    expect(Object.values(rota.roleOwners).flat().every((e) => e.endsWith("@example.invalid"))).toBe(true); // placeholders only (OPEN-21)
    expect(workingCalendarSchema.parse(await load("config/working-calendar.yaml"))).toMatchObject({ timeZone: "Asia/Kolkata" });
  });

  it("FR-NOT-002 resolves role and gate audiences in escalation order; unknown audiences are null", () => {
    const rota = rotaSchema.parse({ programLead: "lead@example.invalid", roleOwners: { dummy: ["a@example.invalid", "b@example.invalid"] }, gateApprovers: { G5: ["g@example.invalid"] } });
    expect(rotaGroup(rota, "role:dummy")).toEqual(["a@example.invalid", "b@example.invalid"]);
    expect(rotaGroup(rota, "gate:G5")).toEqual(["g@example.invalid"]);
    expect(rotaGroup(rota, "role:nobody")).toBeNull();
    expect(rotaGroup(rota, "gate:G6")).toBeNull();
    expect(rotaGroup(rota, "team:x")).toBeNull();
  });

  it("rejects empty groups, bad addresses, unknown gates, unknown time zones and inverted hours", () => {
    const base = { programLead: "lead@example.invalid", roleOwners: {} };
    expect(rotaSchema.safeParse({ ...base, roleOwners: { dummy: [] } }).success).toBe(false);
    expect(rotaSchema.safeParse({ ...base, programLead: "not-an-email" }).success).toBe(false);
    expect(rotaSchema.safeParse({ ...base, gateApprovers: { G9: ["g@example.invalid"] } }).success).toBe(false);
    const cal = { timeZone: "Asia/Kolkata", workingDays: [1, 2, 3, 4, 5], dayStart: "09:00", dayEnd: "18:00" };
    expect(workingCalendarSchema.safeParse({ ...cal, timeZone: "Mars/Olympus" }).success).toBe(false);
    expect(workingCalendarSchema.safeParse({ ...cal, dayStart: "18:00", dayEnd: "09:00" }).success).toBe(false);
    expect(workingCalendarSchema.safeParse({ ...cal, dayStart: "25:00" }).success).toBe(false);
    expect(workingCalendarSchema.parse(cal).holidays).toEqual([]);
  });
});
