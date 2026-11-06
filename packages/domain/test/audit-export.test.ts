import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AuditExportError,
  buildExportSegment,
  chainAuditEvent,
  checkExportEvents,
  compareWithDatabase,
  evidenceKey,
  GENESIS_POINT,
  parseEvidenceTarget,
  segmentKey,
  stateHash,
  verifyExportSegments,
  type AuditEventContent,
  type ChainedAuditEvent,
  type ExportedEvidence,
} from "../src/index.js";

const SHA = "a".repeat(40);
const envelope = { payloadType: "application/vnd.in-toto+json", payload: "e30=", signatures: [{ keyid: "k", sig: "s" }] };
const content = (action: string, target = "task:PILOT-1", afterHash: string | null = null): AuditEventContent => ({
  actor: { kind: "service", id: "adlc-orchestrator" },
  action,
  target,
  reason: "r",
  beforeHash: null,
  afterHash,
  correlation: {},
});

/** Chains contents starting after `from` (seq gaps allowed, as in the database). */
function chain(contents: AuditEventContent[], from = GENESIS_POINT, gap = 1): ChainedAuditEvent[] {
  const out: ChainedAuditEvent[] = [];
  let prev = from.hash;
  let seq = from.seq;
  for (const c of contents) {
    seq += gap;
    const e = chainAuditEvent(c, seq, new Date(Date.UTC(2026, 10, 6, 0, 0, seq)), prev);
    out.push(e);
    prev = e.hash;
  }
  return out;
}

const sign = content("evidence.sign", `pr:org/product#7@${SHA}`, stateHash(envelope));
const evidence: ExportedEvidence = { repo: "org/product", prNumber: 7, headSha: SHA, envelope, status: "signed" };
const at = new Date("2026-11-06T00:00:00.000Z");

describe("NFR-006 WORM audit export: segments", () => {
  it("NFR-006 keys are ordered by segment index; evidence keys come only from valid targets", () => {
    expect(segmentKey(12)).toBe("audit/segment-0000000012.json");
    expect(segmentKey(9) < segmentKey(10)).toBe(true);
    expect(parseEvidenceTarget(`pr:org/product#7@${SHA}`)).toEqual({ repo: "org/product", prNumber: 7, headSha: SHA });
    expect(parseEvidenceTarget(`pr:../etc#7@${SHA}`)).toBeNull();
    expect(parseEvidenceTarget(`pr:org/..#7@${SHA}`)).toBeNull();
    expect(parseEvidenceTarget(`pr:org/.github#7@${SHA}`)).not.toBeNull();
    expect(parseEvidenceTarget("pr:org/product#7@HEAD")).toBeNull();
    expect(evidenceKey({ repo: "org/product", prNumber: 7, headSha: SHA })).toBe(`evidence/org/product/7/${SHA}.json`);
    expect(() => evidenceKey({ repo: "a/../b", prNumber: 7, headSha: SHA })).toThrow(AuditExportError);
  });

  it("NFR-006 each segment continues from the previous one's last chain point", () => {
    const first = chain([content("a"), content("b")]);
    const s1 = buildExportSegment(null, first, at);
    expect(s1).toMatchObject({ index: 1, anchor: GENESIS_POINT, last: { seq: 2, hash: first[1]?.hash } });
    const s2 = buildExportSegment(s1, chain([content("c")], s1.last, 3), at);
    expect(s2).toMatchObject({ index: 2, anchor: s1.last, last: { seq: 5 } });
    expect(verifyExportSegments([s1, s2], new Map())).toEqual({ findings: [], last: s2.last, events: 3, segments: 2 });
  });

  it("NFR-006 refuses to seal a broken chain or an empty or overlapping range", () => {
    const events = chain([content("a"), content("b")]);
    const forged = events.map((e, i) => (i === 1 ? { ...e, reason: "edited" } : e));
    expect(() => buildExportSegment(null, forged, at)).toThrow(/chain broken at seq 2/);
    expect(() => buildExportSegment(null, [], at)).toThrow(AuditExportError);
    const s1 = buildExportSegment(null, events, at);
    expect(() => buildExportSegment(s1, events.slice(1), at)).toThrow(/not after the anchor/);
  });

  it("NFR-006 verification finds a missing segment, a forged event and a re-anchored segment", () => {
    const s1 = buildExportSegment(null, chain([content("a")]), at);
    const s2 = buildExportSegment(s1, chain([content("b")], s1.last), at);
    const s3 = buildExportSegment(s2, chain([content("c")], s2.last), at);
    expect(verifyExportSegments([s1, s3], new Map()).findings).toEqual([
      { kind: "segment-missing", index: 2 },
      { kind: "segment-anchor-mismatch", index: 3 },
    ]);
    const forged = { ...s2, events: s2.events.map((e) => ({ ...e, action: "x" })) };
    expect(verifyExportSegments([s1, forged, s3], new Map()).findings).toEqual([{ kind: "segment-chain-broken", index: 2, seq: 2, reason: "hash-mismatch" }]);
    const truncated = { ...s2, last: { seq: 9, hash: "f".repeat(64) } };
    expect(verifyExportSegments([s1, truncated], new Map()).findings).toEqual([{ kind: "segment-chain-broken", index: 2, seq: 9, reason: "last-mismatch" }]);
  });

  it("FR-EVD-002 NFR-006 every signed evidence event needs a matching exported envelope", () => {
    const s = buildExportSegment(null, chain([content("a"), sign]), at);
    const key = `evidence/org/product/7/${SHA}.json`;
    expect(verifyExportSegments([s], new Map([[key, evidence]])).findings).toEqual([]);
    expect(verifyExportSegments([s], new Map()).findings).toEqual([{ kind: "evidence-missing", seq: 2, key }]);
    const swapped = { ...evidence, envelope: { ...envelope, payload: "e3gwfQ==" } };
    expect(verifyExportSegments([s], new Map([[key, swapped]])).findings).toEqual([{ kind: "evidence-mismatch", seq: 2, key }]);
  });

  it("NFR-006 property: any single edit to an exported event is detected", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.nat(), fc.constantFrom("action", "reason", "target", "ts"), (n, pick, field) => {
        const events = chain(Array.from({ length: n }, (_, i) => content(`a${i}`)));
        const s = buildExportSegment(null, events, at);
        const i = pick % n;
        const edited = { ...s, events: s.events.map((e, j) => (j === i ? { ...e, [field]: `${e[field]}!` } : e)) };
        return verifyExportSegments([edited], new Map()).findings.length > 0;
      }),
    );
  });
});

describe("NFR-006 WORM audit export: database cross-check", () => {
  const exported = chain([content("a"), content("b"), content("c")]);

  it("NFR-006 an unchanged database agrees with the export", () => {
    expect(compareWithDatabase(exported, exported)).toEqual([]);
  });

  it("NFR-006 rows deleted, rewritten or inserted in the exported range are reported", () => {
    const [a, b, c] = exported as [ChainedAuditEvent, ChainedAuditEvent, ChainedAuditEvent];
    expect(compareWithDatabase(exported, [a, c])).toEqual([{ kind: "database-diverges", seq: 2, reason: "missing" }]);
    const rewritten = chainAuditEvent({ ...content("b2") }, 2, new Date(b.ts), a.hash);
    expect(compareWithDatabase(exported, [a, rewritten, c])).toEqual([{ kind: "database-diverges", seq: 2, reason: "changed" }]);
    const inserted = { ...b, seq: 99 };
    expect(compareWithDatabase(exported, [a, b, c, inserted]).map((f) => f.kind)).toEqual(["database-diverges"]);
  });
});

describe("NFR-006 WORM audit export: exports recorded in the database", () => {
  it("NFR-006 each recorded export must still be in the store, sealing the same chain point", () => {
    const s1 = buildExportSegment(null, chain([content("a")]), at);
    const exportEvent = (key: string, afterHash: string) => chain([{ ...content("audit.export", `object:${key}`), afterHash }], s1.last)[0] as ChainedAuditEvent;
    expect(checkExportEvents([exportEvent(segmentKey(1), s1.last.hash)], [s1])).toEqual([]);
    expect(checkExportEvents([exportEvent(segmentKey(1), s1.last.hash)], [])).toEqual([{ kind: "export-missing", seq: 2, key: segmentKey(1) }]);
    expect(checkExportEvents([exportEvent(segmentKey(1), "c".repeat(64))], [s1])).toEqual([{ kind: "export-missing", seq: 2, key: segmentKey(1) }]);
    expect(checkExportEvents(chain([content("other")]), [])).toEqual([]);
  });
});
