import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobLockLostError, JobQueue } from "../src/index.js";
import { freshDatabase, skipIntegration, type TestDatabase } from "./helpers.js";

const t0 = new Date("2026-11-05T08:00:00.000Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

describe.skipIf(skipIntegration)("hard rule 8 PostgreSQL job queue", () => {
  let t: TestDatabase;
  let q: JobQueue;
  beforeAll(async () => {
    t = await freshDatabase();
    q = new JobQueue(t.db);
  });
  afterAll(async () => {
    await t.close();
  });

  it("hard rule 8 concurrent workers never claim the same job (FOR UPDATE SKIP LOCKED)", async () => {
    for (let i = 0; i < 20; i++) await q.enqueue({ kind: "start-run", payload: { i }, runAfter: t0 });
    const claims = await Promise.all(Array.from({ length: 30 }, (_, w) => q.claim(`w${w}`, ["start-run"], t0, 60_000)));
    const ids = claims.filter((c) => c !== null).map((c) => c.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    for (const c of claims) if (c) await q.complete(c.id, c.lockedBy ?? "", t0);
    expect(await q.claim("w", ["start-run"], t0, 60_000)).toBeNull();
  });

  it("enqueue is idempotent per dedupe key, honours run_after and kind filters", async () => {
    await q.enqueue({ kind: "start-run", payload: { a: 1 }, dedupeKey: "start-run:r1", runAfter: at(1000) });
    await q.enqueue({ kind: "start-run", payload: { a: 2 }, dedupeKey: "start-run:r1", runAfter: at(1000) });
    expect(await q.claim("w", ["start-run"], t0, 1000)).toBeNull(); // not yet due
    expect(await q.claim("w", ["other"], at(1000), 1000)).toBeNull();
    const j = await q.claim("w", ["start-run"], at(1000), 1000);
    expect(j?.payload).toEqual({ a: 1 });
    await q.complete(j?.id ?? 0, "w", at(1000));
    expect(await q.claim("w", ["start-run"], at(5000), 1000)).toBeNull();
  });

  it("a crashed worker's job is reclaimed after its lock lapses; the old worker can no longer finish it", async () => {
    await q.enqueue({ kind: "supervise", payload: {}, runAfter: t0 });
    const first = await q.claim("dead", ["supervise"], t0, 10_000);
    expect(await q.claim("live", ["supervise"], at(5_000), 10_000)).toBeNull(); // still locked
    const again = await q.claim("live", ["supervise"], at(10_001), 10_000);
    expect(again?.id).toBe(first?.id);
    expect(again?.attempts).toBe(2);
    await expect(q.complete(first?.id ?? 0, "dead", at(10_002))).rejects.toBeInstanceOf(JobLockLostError);
    await q.complete(again?.id ?? 0, "live", at(10_002));
  });

  it("failures retry with a delay until max attempts, then the job is marked failed", async () => {
    await q.enqueue({ kind: "flaky", payload: {}, runAfter: t0, maxAttempts: 2 });
    const a = await q.claim("w", ["flaky"], t0, 1000);
    expect(await q.fail(a?.id ?? 0, "w", "boom", t0, 5000)).toBe("retry");
    expect(await q.claim("w", ["flaky"], at(1000), 1000)).toBeNull();
    const b = await q.claim("w", ["flaky"], at(5000), 1000);
    expect(await q.fail(b?.id ?? 0, "w", "boom again", at(5000), 5000)).toBe("failed");
    expect(await q.get(b?.id ?? 0)).toMatchObject({ lastError: "boom again", failedAt: at(5000) });
    expect(await q.claim("w", ["flaky"], at(60_000), 1000)).toBeNull();
  });
});
