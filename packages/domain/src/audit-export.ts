import { computeAuditHash, GENESIS_HASH, stateHash, verifyAuditChain, type ChainedAuditEvent } from "./audit.js";
import { DomainError } from "./errors.js";

/**
 * Write-once (WORM) export of the audit chain and the signed evidence (NFR-006, ADR-0015).
 *
 * The chain is cut into numbered segments. Each segment starts from the previous segment's last
 * `{seq, hash}` (its anchor), so the segments form one chain of their own. Verification then works
 * both ways: the export proves the database was not rewritten, and the database's later events
 * prove no segment was removed from the end. Evidence is tied to the chain without extra
 * bookkeeping: every `evidence.sign` audit event carries the hash of the signed envelope, and the
 * exported evidence object must match it.
 */

export const AUDIT_EXPORT_FORMAT = "adlc.audit-export/v1";

export interface ChainPoint {
  seq: number;
  hash: string;
}

/** Where the first segment starts: before any event. */
export const GENESIS_POINT: ChainPoint = { seq: 0, hash: GENESIS_HASH };

export interface AuditExportSegment {
  format: typeof AUDIT_EXPORT_FORMAT;
  /** 1, 2, 3, … without gaps. */
  index: number;
  anchor: ChainPoint;
  last: ChainPoint;
  /** UTC ISO-8601. */
  exportedAt: string;
  events: ChainedAuditEvent[];
}

/** The exported copy of one signed evidence record (FR-EVD-002). */
export interface ExportedEvidence {
  repo: string;
  prNumber: number;
  headSha: string;
  envelope: unknown;
  [field: string]: unknown;
}

export class AuditExportError extends DomainError {
  override name = "AuditExportError";
}

export const SEGMENT_PREFIX = "audit/";
export const EVIDENCE_PREFIX = "evidence/";

export function segmentKey(index: number): string {
  return `${SEGMENT_PREFIX}segment-${String(index).padStart(10, "0")}.json`;
}

// owner/name; neither part may be "." or ".." (object keys must not traverse).
const REPO = /^(?!\.\.?\/)[A-Za-z0-9._-]+\/(?!\.\.?$)[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/;

export interface EvidenceTarget {
  repo: string;
  prNumber: number;
  headSha: string;
}

/** Parses the audit target of an `evidence.sign` event: `pr:<owner>/<repo>#<n>@<sha>`. */
export function parseEvidenceTarget(target: string): EvidenceTarget | null {
  const m = /^pr:([^#]+)#(\d+)@([0-9a-f]+)$/.exec(target);
  if (!m?.[1] || !m[2] || !m[3] || !REPO.test(m[1]) || !SHA.test(m[3])) return null;
  return { repo: m[1], prNumber: Number(m[2]), headSha: m[3] };
}

export function evidenceKey(t: EvidenceTarget): string {
  if (!REPO.test(t.repo) || !SHA.test(t.headSha) || !Number.isInteger(t.prNumber)) throw new AuditExportError(`invalid evidence target ${t.repo}#${t.prNumber}@${t.headSha}`);
  return `${EVIDENCE_PREFIX}${t.repo}/${t.prNumber}/${t.headSha}.json`;
}

export const EVIDENCE_SIGN_ACTION = "evidence.sign";
/** The exporter audits each segment it seals; the database thereby knows what the store must hold. */
export const AUDIT_EXPORT_ACTION = "audit.export";

/** The evidence objects a segment must be accompanied by. */
export function evidenceTargets(events: readonly ChainedAuditEvent[]): { event: ChainedAuditEvent; target: EvidenceTarget }[] {
  return events.flatMap((event) => {
    if (event.action !== EVIDENCE_SIGN_ACTION) return [];
    const target = parseEvidenceTarget(event.target);
    if (!target) throw new AuditExportError(`audit event ${event.seq} has a malformed evidence target`);
    return [{ event, target }];
  });
}

/**
 * Builds the next segment. Refuses to export a chain that does not verify from the anchor: a
 * broken database chain must be investigated, never sealed into the write-once store.
 */
export function buildExportSegment(previous: AuditExportSegment | null, events: readonly ChainedAuditEvent[], exportedAt: Date): AuditExportSegment {
  const anchor = previous?.last ?? GENESIS_POINT;
  const last = events.at(-1);
  if (!last) throw new AuditExportError("nothing to export");
  if (events[0] && events[0].seq <= anchor.seq) throw new AuditExportError(`event ${events[0].seq} is not after the anchor ${anchor.seq}`);
  const check = verifyAuditChain(events, anchor.hash);
  if (!check.ok) throw new AuditExportError(`audit chain broken at seq ${check.brokenAtSeq} (${check.reason}); export refused`);
  return {
    format: AUDIT_EXPORT_FORMAT,
    index: (previous?.index ?? 0) + 1,
    anchor,
    last: { seq: last.seq, hash: last.hash },
    exportedAt: exportedAt.toISOString(),
    events: [...events],
  };
}

export type ExportFinding =
  | { kind: "segment-missing"; index: number }
  | { kind: "export-missing"; seq: number; key: string }
  | { kind: "segment-anchor-mismatch"; index: number }
  | { kind: "segment-chain-broken"; index: number; seq: number; reason: string }
  | { kind: "segment-malformed"; key: string }
  | { kind: "evidence-missing"; seq: number; key: string }
  | { kind: "evidence-mismatch"; seq: number; key: string }
  | { kind: "object-rewritten"; key: string; versions: number }
  | { kind: "object-deleted"; key: string }
  | { kind: "database-diverges"; seq: number; reason: "missing" | "changed" | "extra" }
  | { kind: "database-chain-broken"; seq: number; reason: string };

export interface ExportVerification {
  findings: ExportFinding[];
  /** The last exported chain point (genesis when nothing was exported yet). */
  last: ChainPoint;
  events: number;
  segments: number;
}

/**
 * Verifies the exported segments (ordered by index) and the evidence objects they require.
 * `evidence` maps an evidence key to its object, or is missing the key when absent.
 */
export function verifyExportSegments(segments: readonly AuditExportSegment[], evidence: ReadonlyMap<string, ExportedEvidence>): ExportVerification {
  const findings: ExportFinding[] = [];
  let prev = GENESIS_POINT;
  let events = 0;
  segments.forEach((s, i) => {
    if (s.index !== i + 1) findings.push({ kind: "segment-missing", index: i + 1 });
    if (s.anchor.seq !== prev.seq || s.anchor.hash !== prev.hash) findings.push({ kind: "segment-anchor-mismatch", index: s.index });
    const check = verifyAuditChain(s.events, s.anchor.hash);
    if (!check.ok) findings.push({ kind: "segment-chain-broken", index: s.index, seq: check.brokenAtSeq, reason: check.reason });
    else if (check.lastHash !== s.last.hash || s.events.at(-1)?.seq !== s.last.seq) findings.push({ kind: "segment-chain-broken", index: s.index, seq: s.last.seq, reason: "last-mismatch" });
    for (const { event, target } of evidenceTargetsLenient(s.events)) {
      const key = evidenceKey(target);
      const obj = evidence.get(key);
      if (!obj) findings.push({ kind: "evidence-missing", seq: event.seq, key });
      else if (obj.repo !== target.repo || obj.prNumber !== target.prNumber || obj.headSha !== target.headSha || stateHash(obj.envelope) !== event.afterHash) {
        findings.push({ kind: "evidence-mismatch", seq: event.seq, key });
      }
    }
    events += s.events.length;
    prev = s.last;
  });
  return { findings, last: prev, events, segments: segments.length };
}

function evidenceTargetsLenient(events: readonly ChainedAuditEvent[]): { event: ChainedAuditEvent; target: EvidenceTarget }[] {
  return events.flatMap((event) => {
    const target = event.action === EVIDENCE_SIGN_ACTION ? parseEvidenceTarget(event.target) : null;
    return target ? [{ event, target }] : [];
  });
}

/**
 * Compares the database's events up to the last exported seq with the exported ones. Any event
 * missing, changed or added in the database within the exported range is a finding.
 */
export function compareWithDatabase(exported: readonly ChainedAuditEvent[], database: readonly ChainedAuditEvent[]): ExportFinding[] {
  const findings: ExportFinding[] = [];
  const db = new Map(database.map((e) => [e.seq, e]));
  const seen = new Set<number>();
  for (const e of exported) {
    seen.add(e.seq);
    const d = db.get(e.seq);
    if (!d) findings.push({ kind: "database-diverges", seq: e.seq, reason: "missing" });
    // Recompute from the row's content: an edit that left the stored hash column alone counts too.
    else if (computeAuditHash(d) !== e.hash || d.prevHash !== e.prevHash) findings.push({ kind: "database-diverges", seq: e.seq, reason: "changed" });
  }
  for (const d of database) if (!seen.has(d.seq)) findings.push({ kind: "database-diverges", seq: d.seq, reason: "extra" });
  return findings;
}

/**
 * Every `audit.export` event in the database names a segment the store must still hold, with the
 * chain point it sealed. This catches a store emptied or a bucket deleted (which SeaweedFS lets an
 * admin do despite Object Lock, ADR-0015): the database remembers the exports.
 */
export function checkExportEvents(database: readonly ChainedAuditEvent[], segments: readonly AuditExportSegment[]): ExportFinding[] {
  const byKey = new Map(segments.map((s) => [segmentKey(s.index), s]));
  return database.flatMap((e): ExportFinding[] => {
    if (e.action !== AUDIT_EXPORT_ACTION || !e.target.startsWith("object:")) return [];
    const key = e.target.slice("object:".length);
    const segment = byKey.get(key);
    return segment && segment.last.hash === e.afterHash ? [] : [{ kind: "export-missing", seq: e.seq, key }];
  });
}
