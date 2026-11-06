import type { ObjectStore, ObjectVersion } from "@adlc/adapters";
import { AuditRepository, EvidenceRepository, type Db } from "@adlc/db";
import {
  AUDIT_EXPORT_ACTION,
  buildExportSegment,
  checkExportEvents,
  compareWithDatabase,
  EVIDENCE_PREFIX,
  evidenceKey,
  evidenceTargets,
  SEGMENT_PREFIX,
  segmentKey,
  verifyExportSegments,
  verifyAuditChain,
  type Actor,
  type AuditExportSegment,
  type ExportedEvidence,
  type ExportFinding,
  type ExportVerification,
} from "@adlc/domain";
import { auditExportSegmentSchema, exportedEvidenceSchema } from "@adlc/schemas";
import type { Logger } from "@adlc/telemetry";
import type { Clock } from "./clock.js";

const EXPORTER: Actor = { kind: "service", id: "adlc-orchestrator" };
const DAY_MS = 86_400_000;

/** A stored segment, validated; null when absent or not a segment. */
async function readSegment(store: ObjectStore, key: string, versionId?: string): Promise<AuditExportSegment | null> {
  const body = await store.get(key, versionId);
  if (body === null) return null;
  const parsed = auditExportSegmentSchema.safeParse(JSON.parse(body) as unknown);
  return parsed.success ? parsed.data : null;
}

export interface AuditExportOptions {
  /** Compliance retention of each exported object, per ISMS (Pioneer decision; ADR-0015). */
  retentionDays: number;
  /** Minimum time between segments (NFR-006: daily). */
  everyMs: number;
}

export interface ExportResult {
  key: string;
  index: number;
  events: number;
  evidence: number;
}

/**
 * The write-once export (NFR-006, ADR-0015). Run by the orchestrator leader. Its progress lives in
 * the object store itself — the next segment starts where the newest stored one ends — so a
 * database administrator cannot move the export's bookmark.
 */
export class AuditExporter {
  private readonly audit: AuditRepository;
  private readonly evidence: EvidenceRepository;

  constructor(
    db: Db,
    private readonly store: ObjectStore,
    private readonly options: AuditExportOptions,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    this.audit = new AuditRepository(db);
    this.evidence = new EvidenceRepository(db);
  }

  /** The newest stored segment, or null before the first export. */
  async latestSegment(): Promise<AuditExportSegment | null> {
    const keys = await this.store.listKeys(SEGMENT_PREFIX);
    const key = keys.at(-1);
    if (key === undefined) return null;
    const segment = await readSegment(this.store, key).catch(() => null);
    if (!segment) throw new Error(`newest audit export segment ${key} is unreadable; run the verifier`);
    return segment;
  }

  /** Exports a segment when the last one is older than `everyMs`. */
  async exportIfDue(): Promise<ExportResult | null> {
    const latest = await this.latestSegment();
    if (latest && this.clock.now().getTime() - Date.parse(latest.exportedAt) < this.options.everyMs) return null;
    return this.exportFrom(latest);
  }

  /** Seals every audit event after the newest segment into the next segment. */
  async export(): Promise<ExportResult | null> {
    return this.exportFrom(await this.latestSegment());
  }

  private async exportFrom(latest: AuditExportSegment | null): Promise<ExportResult | null> {
    const fromSeq = (latest?.last.seq ?? 0) + 1;
    const events = await this.audit.listSealable(fromSeq);
    if (events.length === 0) return null;
    const now = this.clock.now();
    const segment = buildExportSegment(latest, events, now); // refuses a broken chain
    const retainUntil = new Date(now.getTime() + this.options.retentionDays * DAY_MS);

    // Evidence first, so a stored segment never refers to evidence that is not there yet.
    const targets = evidenceTargets(events);
    for (const { target } of targets) {
      const key = evidenceKey(target);
      if (await this.store.exists(key)) continue; // a retry after a crash; never write twice
      const row = await this.evidence.evidenceFor(target.repo, target.prNumber, target.headSha);
      if (!row) throw new Error(`evidence for ${key} is in the audit chain but not in the evidence store`);
      await this.store.putLocked(key, JSON.stringify(row), retainUntil);
    }
    const key = segmentKey(segment.index);
    // Only the leader exports; this catches an overlap with a replica that just lost leadership.
    if (await this.store.exists(key)) throw new Error(`${key} already exists; another exporter is running`);
    await this.store.putLocked(key, JSON.stringify(segment), retainUntil);
    await this.audit.append(
      {
        actor: EXPORTER,
        action: AUDIT_EXPORT_ACTION,
        target: `object:${key}`,
        reason: `sealed seq ${segment.events[0]?.seq ?? fromSeq}-${segment.last.seq} (${events.length} events, ${targets.length} evidence records)`,
        beforeHash: segment.anchor.hash,
        afterHash: segment.last.hash,
        correlation: {},
      },
      now,
    );
    this.logger.info({ key, events: events.length, evidence: targets.length }, "audit export segment sealed");
    return { key, index: segment.index, events: events.length, evidence: targets.length };
  }
}

/**
 * Verifies the export against itself and the database:
 * - every object has exactly one version and no delete marker (overwrites and deletes show up as
 *   extra versions; the original, oldest version is what gets verified);
 * - segments chain from genesis, and each `evidence.sign` event has its envelope exported;
 * - the database holds exactly the exported events up to the last exported seq;
 * - every export the database recorded (`audit.export`) is still in the store;
 * - the database's later events chain on from the export.
 */
export async function verifyAuditExport(db: Db, store: ObjectStore): Promise<ExportVerification> {
  const audit = new AuditRepository(db);
  const findings: ExportFinding[] = [];
  const originals = async (prefix: string): Promise<Map<string, ObjectVersion>> => {
    const byKey = new Map<string, ObjectVersion[]>();
    for (const v of await store.listVersions(prefix)) byKey.set(v.key, [...(byKey.get(v.key) ?? []), v]);
    const out = new Map<string, ObjectVersion>();
    for (const [key, versions] of byKey) {
      if (versions.some((v) => v.deleteMarker)) findings.push({ kind: "object-deleted", key });
      const data = versions.filter((v) => !v.deleteMarker).sort((a, b) => a.lastModified.localeCompare(b.lastModified));
      if (data.length > 1) findings.push({ kind: "object-rewritten", key, versions: data.length });
      if (data[0]) out.set(key, data[0]);
    }
    return out;
  };

  const segments: AuditExportSegment[] = [];
  for (const [key, v] of [...(await originals(SEGMENT_PREFIX))].sort(([a], [b]) => a.localeCompare(b))) {
    const segment = await readSegment(store, key, v.versionId).catch(() => null);
    if (!segment || segmentKey(segment.index) !== key) findings.push({ kind: "segment-malformed", key });
    else segments.push(segment);
  }
  const evidence = new Map<string, ExportedEvidence>();
  for (const [key, v] of await originals(EVIDENCE_PREFIX)) {
    const body = await store.get(key, v.versionId);
    const parsed = body === null ? null : exportedEvidenceSchema.safeParse(JSON.parse(body) as unknown);
    if (parsed?.success) evidence.set(key, parsed.data);
  }

  const result = verifyExportSegments(segments, evidence);
  findings.push(...result.findings);
  const exported = segments.flatMap((s) => s.events);
  const database = await audit.list();
  findings.push(...compareWithDatabase(exported, database.filter((e) => e.seq <= result.last.seq)));
  findings.push(...checkExportEvents(database, segments));
  const tail = verifyAuditChain(database.filter((e) => e.seq > result.last.seq), result.last.hash);
  if (!tail.ok) findings.push({ kind: "database-chain-broken", seq: tail.brokenAtSeq, reason: tail.reason });
  return { ...result, findings };
}
