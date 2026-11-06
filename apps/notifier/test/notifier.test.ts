import type { AddressInfo } from "node:net";
import { createDb, NotificationRepository, runMigrations, type Db } from "@adlc/db";
import { createLogger } from "@adlc/telemetry";
import { freshDatabase, skipIntegration, type TestDatabase } from "@adlc/testing";
import { SMTPServer } from "smtp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotifierService, SmtpEmailChannel } from "../src/index.js";
import { CALENDAR, FakeEmail, ROTA } from "./helpers.js";

const ist = (local: string) => new Date(`${local}+05:30`);
const silent = createLogger("notifier-test", { level: "silent" });

describe.skipIf(skipIntegration)("FR-NOT-001/002 notifier", () => {
  let t: TestDatabase;
  let db: Db;
  let email: FakeEmail;
  let now: Date;
  let notifier: NotifierService;
  let repo: NotificationRepository;
  const raise = (over: Partial<Parameters<NotificationRepository["raise"]>[0]> = {}) =>
    repo.raise({ event: "run.needs-human", severity: "high", audience: "role:dummy", title: "PILOT-1 needs a human", body: "Run r1 failed.", link: "/runs/r1", dedupeKey: "run.needs-human:PILOT-1", ...over }, now);

  beforeEach(async () => {
    t = await freshDatabase({ migrate: (pool) => runMigrations(createDb(pool)) });
    db = createDb(t.pool);
    repo = new NotificationRepository(db);
    email = new FakeEmail();
    now = ist("2026-11-05T10:00:00");
    notifier = new NotifierService(repo, email, ROTA, CALENDAR, "https://portal.example.invalid", { now: () => now }, silent);
  });
  afterEach(async () => {
    await t.close();
  });

  it("FR-NOT-001 routes to the on-duty member with a working-time deadline and emails the full content", async () => {
    await raise();
    expect(await notifier.tick()).toEqual({ routed: 1, escalated: 0, delivered: 1, failed: 0 });
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m?.to).toEqual(["onduty@example.invalid"]);
    expect(m?.subject).toBe("[ADLC HIGH] PILOT-1 needs a human");
    expect(m?.text).toContain("Run r1 failed.");
    expect(m?.text).toContain("Acknowledge by: 5 Nov 2026, 14:00 (Asia/Kolkata)");
    expect(m?.text).toContain("Suggested action: Open the run");
    expect(m?.text).toContain("Open: https://portal.example.invalid/runs/r1");
    expect((await repo.inbox("onduty@example.invalid")).map((n) => n.title)).toEqual(["PILOT-1 needs a human"]);
    expect(await notifier.tick()).toEqual({ routed: 0, escalated: 0, delivered: 0, failed: 0 }); // nothing re-sent
  });

  it("FR-NOT-002 escalates on-duty → backup → Program Lead, then keeps reminding the lead until acknowledged", async () => {
    await raise();
    await notifier.tick();
    now = ist("2026-11-05T14:01:00");
    expect(await notifier.tick()).toMatchObject({ escalated: 1, delivered: 1 });
    expect(email.sent.at(-1)?.to).toEqual(["backup@example.invalid"]);
    expect(email.sent.at(-1)?.text).toContain("Escalated (level 1)");
    expect(await repo.inbox("onduty@example.invalid")).toEqual([]); // the inbox follows the current level
    now = ist("2026-11-06T09:30:00"); // 14:01 + 4 working hours = Fri 09:01
    await notifier.tick();
    expect(email.sent.at(-1)?.to).toEqual(["lead@example.invalid"]);
    now = ist("2026-11-06T13:40:00");
    await notifier.tick();
    expect(email.sent.at(-1)?.to).toEqual(["lead@example.invalid"]);
    expect(email.sent).toHaveLength(4);

    const [open] = await repo.inbox("lead@example.invalid");
    await repo.acknowledge(open?.id ?? "", { kind: "human", id: "lead" }, now);
    now = ist("2026-11-10T13:40:00");
    expect(await notifier.tick()).toEqual({ routed: 0, escalated: 0, delivered: 0, failed: 0 });
  });

  it("FR-NOT-002 duplicates merge while open; after acknowledgement a new event is a new notification", async () => {
    const a = await raise();
    const b = await raise({ body: "Run r2 failed." });
    expect(b).toMatchObject({ merged: true, row: { id: a.row.id } });
    await repo.acknowledge(a.row.id, { kind: "human", id: "op" }, now);
    const c = await raise();
    expect(c.merged).toBe(false);
    expect(c.row.id).not.toBe(a.row.id);
  });

  it("FR-NOT-002 a failed delivery is retried on the next tick", async () => {
    await raise();
    email.failNext = true;
    expect(await notifier.tick()).toMatchObject({ routed: 1, delivered: 0, failed: 1 });
    expect(await notifier.tick()).toMatchObject({ delivered: 1, failed: 0 });
  });

  it("FR-NOT-001 gate-ready gives one working day; an audience missing from the rota reaches the Program Lead", async () => {
    await raise({ event: "gate.ready", severity: "normal", audience: "gate:G5", title: "G5 ready", dedupeKey: "gate.ready:G5:PR-1" });
    await raise({ audience: "role:unknown-role", dedupeKey: "x" });
    await notifier.tick();
    expect(email.sent.map((m) => m.to)).toEqual([["g5@example.invalid"], ["lead@example.invalid"]]);
    expect((await repo.inbox("g5@example.invalid"))[0]?.dueAt).toEqual(ist("2026-11-06T10:00:00"));
  });

  it("hard rule 11: acknowledging is audited and idempotent", async () => {
    const { row } = await raise();
    await repo.acknowledge(row.id, { kind: "human", id: "op" }, now);
    await repo.acknowledge(row.id, { kind: "human", id: "someone-else" }, now);
    expect((await repo.get(row.id)).ackBy).toBe("human:op");
    const { rows } = await t.pool.query<{ n: string }>("select count(*) as n from audit_event where action = 'notification.ack'");
    expect(rows[0]?.n).toBe("1");
  });
});

describe("FR-NOT-003 SMTP email channel", () => {
  it("FR-NOT-003 delivers through SMTP", async () => {
    const received: string[] = [];
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS"],
      onData(stream, _session, done) {
        let data = "";
        stream.on("data", (c: Buffer) => (data += c.toString()));
        stream.on("end", () => {
          received.push(data);
          done();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.server.address() as AddressInfo).port;
    const channel = new SmtpEmailChannel(`smtp://127.0.0.1:${port}`, "adlc@example.invalid");
    try {
      await channel.send({ to: ["onduty@example.invalid"], subject: "[ADLC HIGH] test", text: "body line" });
      expect(received).toHaveLength(1);
      expect(received[0]).toContain("Subject: [ADLC HIGH] test");
      expect(received[0]).toContain("body line");
    } finally {
      channel.close();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }
  });
});
