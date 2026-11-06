import { AuditRepository, createDb, EvidenceRepository, runMigrations, type Db } from "@adlc/db";
import { segmentKey, stateHash, type Actor } from "@adlc/domain";
import { createLogger } from "@adlc/telemetry";
import { freshDatabase, InMemoryObjectStore, seedProjectAndDefinition, skipIntegration, type TestDatabase } from "@adlc/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditExporter, ManualClock, verifyAuditExport } from "../src/index.js";

const silent = createLogger("audit-export-test", { level: "silent" });
const svc: Actor = { kind: "service", id: "adlc-orchestrator" };
const SHA = "b".repeat(40);
const envelope = { payloadType: "application/vnd.in-toto+json", payload: "e30=", signatures: [{ keyid: "k", sig: "s" }] };
const DAY = 86_400_000;

describe.skipIf(skipIntegration)("NFR-006 write-once (WORM) export of audit and evidence", () => {
  let t: TestDatabase;
  let db: Db;
  let projectId: string;
  let clock: ManualClock;
  let store: InMemoryObjectStore;
  let exporter: AuditExporter;

  beforeAll(async () => {
    t = await freshDatabase({ migrate: (pool) => runMigrations(createDb(pool)) });
    db = createDb(t.pool);
    ({ projectId } = await seedProjectAndDefinition(t.pool));
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    // Each test starts from a fresh chain and an empty store.
    const client = await t.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      await client.query("delete from audit_event");
      await client.query("delete from evidence_record");
      await client.query("commit");
    } finally {
      client.release();
    }
    clock = new ManualClock(new Date("2026-11-06T00:00:00.000Z"));
    store = new InMemoryObjectStore(() => clock.now());
    exporter = new AuditExporter(db, store, { retentionDays: 30, everyMs: DAY }, clock, silent);
  });

  const audit = () => new AuditRepository(db);
  const event = (action: string) => audit().append({ actor: svc, action, target: "task:PILOT-1", reason: "r", beforeHash: null, afterHash: null, correlation: {} }, clock.now());
  const sign = (headSha = SHA) =>
    new EvidenceRepository(db).storeEvidence(
      { projectId, repo: "org/product", authorRole: "dummy", prNumber: 7, headSha, patchId: "p", reviewerVerdicts: [], checkResults: [], envelope, status: "signed" },
      { kind: "service", id: "adlc-signer" },
      clock.now(),
    );
  /** As a superuser bypassing the write-once triggers (the threat the export exists for). */
  const asSuperuser = async (q: string, params: unknown[] = []) => {
    const client = await t.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      await client.query(q, params);
      await client.query("commit");
    } finally {
      client.release();
    }
  };

  it("NFR-006 seals the chain and the signed evidence into locked objects; segments continue each other", async () => {
    await event("a");
    await sign();
    const first = await exporter.export();
    expect(first).toEqual({ key: segmentKey(1), index: 1, events: 2, evidence: 1 });
    expect(store.retention(segmentKey(1))).toEqual(new Date(clock.now().getTime() + 30 * DAY));
    const exported = JSON.parse((await store.get(`evidence/org/product/7/${SHA}.json`)) ?? "null") as { envelope: unknown };
    expect(stateHash(exported.envelope)).toBe(stateHash(envelope));

    // The export audits itself; that event opens the next segment.
    const last = (await audit().list()).at(-1);
    expect(last).toMatchObject({ action: "audit.export", target: `object:${segmentKey(1)}` });
    await event("b");
    expect(await exporter.export()).toMatchObject({ index: 2, events: 2, evidence: 0 });
    expect(await verifyAuditExport(db, store)).toMatchObject({ findings: [], segments: 2, events: 4 });
  });

  it("NFR-006 exports at most once per interval", async () => {
    await event("a");
    expect(await exporter.exportIfDue()).toMatchObject({ index: 1 });
    clock.advance(DAY - 1);
    expect(await exporter.exportIfDue()).toBeNull();
    clock.advance(1);
    expect(await exporter.exportIfDue()).toMatchObject({ index: 2 });
  });

  it("NFR-006 nothing new: no segment", async () => {
    expect(await exporter.export()).toBeNull();
    expect(await verifyAuditExport(db, store)).toEqual({ findings: [], last: { seq: 0, hash: "0".repeat(64) }, events: 0, segments: 0 });
  });

  it("NFR-006 a database row rewritten by a superuser after export is caught", async () => {
    const a = await event("a");
    await event("b");
    await exporter.export();
    await asSuperuser("update audit_event set reason = 'rewritten' where seq = $1", [a.seq]);
    expect((await verifyAuditExport(db, store)).findings).toEqual([{ kind: "database-diverges", seq: a.seq, reason: "changed" }]);
  });

  it("NFR-006 events deleted from the tail of the database are caught against the export", async () => {
    await event("a");
    const b = await event("b");
    await exporter.export();
    await asSuperuser("delete from audit_event where seq = $1", [b.seq]);
    expect((await verifyAuditExport(db, store)).findings).toEqual([{ kind: "database-diverges", seq: b.seq, reason: "missing" }]);
  });

  it("NFR-006 a broken database chain is refused, never sealed", async () => {
    const a = await event("a");
    await asSuperuser("update audit_event set action = 'forged' where seq = $1", [a.seq]);
    await expect(exporter.export()).rejects.toThrow(/chain broken at seq/);
    expect(await store.listKeys("")).toEqual([]);
  });

  it("NFR-006 a later edit beyond the exported range is reported as a broken chain", async () => {
    await event("a");
    await exporter.export();
    const c = await event("c");
    await asSuperuser("update audit_event set reason = 'x' where seq = $1", [c.seq]);
    expect((await verifyAuditExport(db, store)).findings).toEqual([{ kind: "database-chain-broken", seq: c.seq, reason: "hash-mismatch" }]);
  });

  it("NFR-006 overwriting or deleting an exported object is visible, and the original still verifies", async () => {
    await event("a");
    await sign();
    await exporter.export();
    const evidenceKey = `evidence/org/product/7/${SHA}.json`;
    const forged = JSON.parse((await store.get(evidenceKey)) ?? "{}") as Record<string, unknown>;
    store.overwrite(evidenceKey, JSON.stringify({ ...forged, envelope: { ...envelope, payload: "forged" } }));
    store.deleteLatest(segmentKey(1));
    expect(() => {
      store.removeVersion(segmentKey(1), "v2");
    }).toThrow(/locked/);
    expect((await verifyAuditExport(db, store)).findings).toEqual(
      expect.arrayContaining([
        { kind: "object-rewritten", key: evidenceKey, versions: 2 },
        { kind: "object-deleted", key: segmentKey(1) },
      ]),
    );
    expect((await verifyAuditExport(db, store)).findings).toHaveLength(2);
  });

  it("NFR-006 a deleted bucket is caught: the database remembers every export it made", async () => {
    await event("a");
    await exporter.export();
    await event("b");
    await exporter.export();
    store.deleteBucket();
    const { findings } = await verifyAuditExport(db, store);
    expect(findings).toEqual([
      { kind: "export-missing", seq: expect.any(Number) as number, key: segmentKey(1) },
      { kind: "export-missing", seq: expect.any(Number) as number, key: segmentKey(2) },
    ]);
  });

  it("FR-EVD-002 NFR-006 a signed-evidence event without its evidence row is refused", async () => {
    await audit().append({ actor: svc, action: "evidence.sign", target: `pr:org/product#9@${SHA}`, reason: "r", beforeHash: null, afterHash: stateHash(envelope), correlation: {} }, clock.now());
    await expect(exporter.export()).rejects.toThrow(/not in the evidence store/);
    expect(await store.listKeys("audit/")).toEqual([]);
  });

  it("NFR-006 an unreadable newest segment stops the export instead of starting a new chain", async () => {
    store.overwrite(segmentKey(1), "{\"not\":\"a segment\"}");
    await expect(exporter.export()).rejects.toThrow(/unreadable/);
  });
});
