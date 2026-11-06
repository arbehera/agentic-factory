import { createDb, JobQueue, runMigrations } from "@adlc/db";
import { createLogger } from "@adlc/telemetry";
import { freshDatabase, skipIntegration, type TestDatabase } from "@adlc/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManualClock, SIGN_EVIDENCE_JOB, Worker } from "../src/index.js";

const silent = createLogger("worker-test", { level: "silent" });

describe.skipIf(skipIntegration)("hard rule 8 job worker on the PostgreSQL queue", () => {
  let t: TestDatabase;
  let queue: JobQueue;
  const clock = new ManualClock(new Date("2026-11-06T08:00:00.000Z"));

  beforeAll(async () => {
    t = await freshDatabase({ migrate: (pool) => runMigrations(createDb(pool)) });
    queue = new JobQueue(createDb(t.pool));
  });
  afterAll(async () => {
    await t.close();
  });

  const state = async (kind: string) => (await t.pool.query<{ done: boolean; failed: boolean; attempts: number; err: string | null }>("select done_at is not null as done, failed_at is not null as failed, attempts, last_error as err from job where kind = $1", [kind])).rows;

  it("claims only its own job kinds, runs each handler once, and records failures for retry", async () => {
    const seen: string[] = [];
    await queue.enqueue({ kind: "ok", payload: { n: 1 }, runAfter: clock.now() });
    await queue.enqueue({ kind: "boom", payload: {}, runAfter: clock.now(), maxAttempts: 2 });
    await queue.enqueue({ kind: SIGN_EVIDENCE_JOB, payload: {}, runAfter: clock.now() });
    const worker = new Worker(
      queue,
      {
        ok: (j) => Promise.resolve(seen.push(`ok:${String(j.payload.n)}`)),
        boom: () => Promise.reject(new Error("handler failed")),
      },
      clock,
      silent,
      { pollMs: 10, lockMs: 60_000, retryMs: 5_000 },
    );
    expect(await worker.drain()).toBe(2); // ok + one failed attempt of boom; the signing job is not its kind
    expect(seen).toEqual(["ok:1"]);
    expect(await state("ok")).toEqual([{ done: true, failed: false, attempts: 1, err: null }]);
    expect(await state("boom")).toEqual([{ done: false, failed: false, attempts: 1, err: "handler failed" }]);
    clock.advance(5_001);
    expect(await worker.drain()).toBe(1);
    expect(await state("boom")).toMatchObject([{ failed: true, attempts: 2 }]);
    expect(await state(SIGN_EVIDENCE_JOB)).toMatchObject([{ done: false, attempts: 0 }]);
  });

  it("start/stop polls on an interval; a drain already running is not re-entered", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    await queue.enqueue({ kind: "slow", payload: {}, runAfter: clock.now() });
    const worker = new Worker(queue, { slow: () => gate }, clock, silent, { pollMs: 10, lockMs: 60_000, retryMs: 1_000 });
    const first = worker.drain();
    expect(await worker.drain()).toBe(0); // busy
    release();
    expect(await first).toBe(1);
    await queue.enqueue({ kind: "slow", payload: {}, runAfter: clock.now() });
    worker.start();
    worker.start(); // idempotent
    for (let i = 0; i < 100 && (await state("slow")).some((r) => !r.done); i++) await new Promise((r) => setTimeout(r, 20));
    worker.stop();
    expect((await state("slow")).every((r) => r.done)).toBe(true);
  });
});
