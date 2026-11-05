import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  budgetLevel,
  dayBucket,
  HEARTBEAT_INTERVAL_MS,
  isLeaseLive,
  LEASE_TTL_MS,
  leaseDeadline,
  leaseExpiryReason,
  monthBucket,
  nextExpiry,
  renewLease,
  TASK_COMPLEXITIES,
  WALL_CLOCK_BUDGET_MS,
  type LeaseTiming,
} from "../src/index.js";

const t0 = Date.UTC(2026, 10, 5, 8, 0, 0);

describe("FR-ORC-008 lease timing", () => {
  it("FR-ORC-008 TTL is three heartbeats; budgets are S 1 h, M 4 h, L 8 h", () => {
    expect(LEASE_TTL_MS).toBe(3 * HEARTBEAT_INTERVAL_MS);
    expect(WALL_CLOCK_BUDGET_MS).toEqual({ S: 3_600_000, M: 14_400_000, L: 28_800_000 });
    expect(leaseDeadline(new Date(t0), "M").getTime()).toBe(t0 + 14_400_000);
  });

  it("FR-ORC-008 property: renewals are monotonic and never extend a lease past its wall-clock deadline", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TASK_COMPLEXITIES), fc.array(fc.integer({ min: 1, max: LEASE_TTL_MS - 1 }), { maxLength: 200 }), (cx, gaps) => {
        const deadlineAt = leaseDeadline(new Date(t0), cx);
        let lease: LeaseTiming = { expiresAt: nextExpiry(new Date(t0), deadlineAt), deadlineAt };
        let now = t0;
        for (const gap of gaps) {
          now += gap;
          const r = renewLease(lease, new Date(now));
          if (r.kind === "expired") {
            expect(now).toBeGreaterThanOrEqual(lease.expiresAt.getTime());
            break;
          }
          expect(r.expiresAt.getTime()).toBeLessThanOrEqual(deadlineAt.getTime());
          expect(r.expiresAt.getTime()).toBeGreaterThanOrEqual(lease.expiresAt.getTime()); // never moves backwards
          lease = { expiresAt: r.expiresAt, deadlineAt };
        }
      }),
    );
  });

  it("FR-ORC-008 property: a lease without a heartbeat for one TTL is expired (crash detected in 15 min)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 * LEASE_TTL_MS }), (late) => {
        const lease = { expiresAt: new Date(t0 + LEASE_TTL_MS), deadlineAt: new Date(t0 + 8 * 3_600_000) };
        const now = new Date(t0 + LEASE_TTL_MS + late);
        expect(isLeaseLive(lease, now)).toBe(false);
        expect(renewLease(lease, now)).toEqual({ kind: "expired" });
      }),
    );
  });

  it("FR-ORC-008 tells a missed heartbeat from an exhausted wall-clock budget", () => {
    const deadlineAt = new Date(t0 + 3_600_000);
    expect(leaseExpiryReason({ expiresAt: new Date(t0 + LEASE_TTL_MS), deadlineAt })).toBe("heartbeat-missed");
    expect(leaseExpiryReason({ expiresAt: deadlineAt, deadlineAt })).toBe("wall-clock-budget");
    expect(nextExpiry(new Date(t0 + 3_590_000), deadlineAt)).toEqual(deadlineAt);
  });
});

describe("FR-ORC-011 budget levels", () => {
  it("FR-ORC-011 property: ok below 80 %, alert from 80 %, exhausted at the cap; no cap is always ok", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e9, noNaN: true }), fc.double({ min: 1, max: 1e9, noNaN: true }), (used, cap) => {
        const expected = used >= cap ? "exhausted" : used >= cap * 0.8 ? "alert" : "ok";
        expect(budgetLevel(used, cap)).toBe(expected);
        expect(budgetLevel(used, null)).toBe("ok");
      }),
    );
    expect(budgetLevel(80, 100)).toBe("alert");
    expect(budgetLevel(100, 100)).toBe("exhausted");
  });

  it("FR-ORC-011 buckets days and months in UTC", () => {
    const at = new Date("2026-11-30T20:00:00+05:30"); // still 30 Nov in UTC (14:30Z)
    expect(dayBucket("p1", at)).toBe("p1:2026-11-30");
    expect(monthBucket("p1", new Date("2026-12-01T03:00:00+05:30"))).toBe("p1:2026-11");
  });
});
