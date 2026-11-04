import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";
import type { Actor } from "./vocabulary.js";

/**
 * Hash-chained audit events (hard rule 11, NFR-001, NFR-006). Each event's hash covers its
 * content and the previous event's hash, so editing or removing any event breaks every later
 * link. Removing events at the tail is detected against the daily export anchor (NFR-006).
 */

export const GENESIS_HASH = "0".repeat(64);

/** Correlation fields carried by logs and audit (CLAUDE.md §6). */
export interface Correlation {
  projectId?: string | undefined;
  runId?: string | undefined;
  taskKey?: string | undefined;
  traceId?: string | undefined;
}

export interface AuditEventContent {
  actor: Actor;
  action: string;
  target: string;
  reason: string;
  /** Hash of the target's state before and after the change; null when it did not exist. */
  beforeHash: string | null;
  afterHash: string | null;
  correlation: Correlation;
}

export interface ChainedAuditEvent extends AuditEventContent {
  seq: number;
  /** UTC ISO-8601 with milliseconds. */
  ts: string;
  prevHash: string;
  hash: string;
}

export class CanonicalJsonError extends DomainError {
  override name = "CanonicalJsonError";
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Deterministic JSON: sorted object keys, no whitespace, `undefined` properties omitted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalJsonError(`non-finite number: ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && isPlainObject(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new CanonicalJsonError(`unsupported value of type ${typeof value}`);
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** before/after hash of an entity state (spec.md §5 AuditEvent). */
export function stateHash(state: unknown): string {
  return sha256Hex(canonicalJson(state));
}

export function computeAuditHash(e: Omit<ChainedAuditEvent, "hash">): string {
  const { seq, ts, prevHash, actor, action, target, reason, beforeHash, afterHash, correlation } = e;
  return sha256Hex(
    canonicalJson({ seq, ts, prevHash, actor, action, target, reason, beforeHash, afterHash, correlation }),
  );
}

export function chainAuditEvent(
  content: AuditEventContent,
  seq: number,
  ts: Date,
  prevHash: string,
): ChainedAuditEvent {
  const unhashed = { ...content, seq, ts: ts.toISOString(), prevHash };
  return { ...unhashed, hash: computeAuditHash(unhashed) };
}

export type ChainVerification =
  | { ok: true; lastHash: string; count: number }
  | { ok: false; brokenAtSeq: number; reason: "hash-mismatch" | "link-mismatch" | "seq-order" };

/** Verifies events ordered by seq, starting from `anchorHash` (genesis or the last export). */
export function verifyAuditChain(
  events: readonly ChainedAuditEvent[],
  anchorHash: string = GENESIS_HASH,
): ChainVerification {
  let prev = anchorHash;
  let prevSeq = -Infinity;
  for (const e of events) {
    if (e.seq <= prevSeq) return { ok: false, brokenAtSeq: e.seq, reason: "seq-order" };
    if (e.prevHash !== prev) return { ok: false, brokenAtSeq: e.seq, reason: "link-mismatch" };
    if (computeAuditHash(e) !== e.hash) return { ok: false, brokenAtSeq: e.seq, reason: "hash-mismatch" };
    prev = e.hash;
    prevSeq = e.seq;
  }
  return { ok: true, lastHash: prev, count: events.length };
}
