import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DISPATCH_ENVIRONMENTS, hasFreeSlot, PILOT_SLOT_POLICY } from "../src/index.js";

describe("FR-ORC-014 executor slots and sandbox quota", () => {
  it("FR-ORC-014 the pilot default is 8 slots, at most 2 for sandbox", () => {
    expect(PILOT_SLOT_POLICY).toEqual({ total: 8, sandboxQuota: 2 });
    expect(hasFreeSlot(PILOT_SLOT_POLICY, { total: 2, sandbox: 2 }, "sandbox")).toBe(false);
    expect(hasFreeSlot(PILOT_SLOT_POLICY, { total: 2, sandbox: 2 }, "production")).toBe(true);
    expect(hasFreeSlot(PILOT_SLOT_POLICY, { total: 8, sandbox: 0 }, "production")).toBe(false);
  });

  it("FR-ORC-014 property: granting a slot never exceeds the total or the sandbox quota", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 32 }),
        fc.integer({ min: 0, max: 32 }),
        fc.array(fc.constantFrom(...DISPATCH_ENVIRONMENTS), { maxLength: 100 }),
        (total, quota, requests) => {
          const policy = { total, sandboxQuota: Math.min(quota, total) };
          const active = { total: 0, sandbox: 0 };
          for (const env of requests) {
            if (!hasFreeSlot(policy, active, env)) continue;
            active.total++;
            if (env === "sandbox") active.sandbox++;
            expect(active.total).toBeLessThanOrEqual(policy.total);
            expect(active.sandbox).toBeLessThanOrEqual(policy.sandboxQuota);
          }
        },
      ),
    );
  });
});
