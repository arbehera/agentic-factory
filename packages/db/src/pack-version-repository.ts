import {
  assertPackTransition,
  packAllowsNewDispatch,
  stateHash,
  type Actor,
  type DispatchEnvironment,
  type PackKind,
  type PackStatus,
} from "@adlc/domain";
import { and, eq } from "drizzle-orm";
import { AuditRepository } from "./audit-repository.js";
import type { Db } from "./client.js";
import { packVersion } from "./schema.js";

export type PackVersionRow = typeof packVersion.$inferSelect;

export class PackVersionConflictError extends Error {
  override name = "PackVersionConflictError";
}
export class PackNotFoundError extends Error {
  override name = "PackNotFoundError";
}
export class PackNotDispatchableError extends Error {
  override name = "PackNotDispatchableError";
}

export interface PackRegistration {
  packId: string;
  kind: PackKind;
  semver: string;
  imageDigest: string | null;
  ownerId: string;
  /** stateHash() of the validated manifest. */
  contentHash: string;
}

function semverKey(v: string): number[] {
  return v.split(".").map(Number);
}
function compareSemver(a: string, b: string): number {
  const [x, y] = [semverKey(a), semverKey(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const statusHash = (r: Pick<PackVersionRow, "packId" | "semver" | "status">) =>
  stateHash({ packId: r.packId, semver: r.semver, status: r.status });

/** Pack registry (FR-PCK-001, FR-PCK-003): versions are immutable; every status change is audited. */
export class PackVersionRepository {
  constructor(private readonly db: Db) {}

  /** Registers a pack version as Draft. Re-registering identical content is a no-op. */
  async register(reg: PackRegistration, actor: Actor): Promise<PackVersionRow> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(packVersion)
        .where(and(eq(packVersion.packId, reg.packId), eq(packVersion.semver, reg.semver)))
        .for("update");
      if (existing) {
        if (existing.contentHash !== reg.contentHash || existing.kind !== reg.kind) {
          throw new PackVersionConflictError(`${reg.packId}@${reg.semver} is already registered with different content; bump the version`);
        }
        return existing;
      }
      const [row] = await tx.insert(packVersion).values({ ...reg, status: "Draft" }).returning();
      if (!row) throw new Error("insert returned no row");
      await new AuditRepository(tx).append({
        actor,
        action: "pack.register",
        target: `pack:${reg.packId}@${reg.semver}`,
        reason: `registered ${reg.kind} pack as Draft`,
        beforeHash: null,
        afterHash: statusHash(row),
        correlation: {},
      });
      return row;
    });
  }

  /**
   * Applies a lifecycle transition (FR-PCK-003) atomically with its audit event. All approvers are
   * named in the audit reason; the first is the recorded actor.
   */
  async transition(packId: string, semver: string, to: PackStatus, actors: readonly Actor[], reason: string): Promise<PackVersionRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(packVersion)
        .where(and(eq(packVersion.packId, packId), eq(packVersion.semver, semver)))
        .for("update");
      if (!row) throw new PackNotFoundError(`${packId}@${semver} is not registered`);
      const from = row.status as PackStatus;
      assertPackTransition(from, to, { actors, imageDigest: row.imageDigest });
      const [updated] = await tx.update(packVersion).set({ status: to }).where(eq(packVersion.id, row.id)).returning();
      if (!updated) throw new Error("update returned no row");
      const [first] = actors as [Actor, ...Actor[]]; // assertPackTransition guarantees at least one
      await new AuditRepository(tx).append({
        actor: first,
        action: "pack.status",
        target: `pack:${packId}@${semver}`,
        reason: `${from} -> ${to}: ${reason} (by ${actors.map((a) => `${a.kind}:${a.id}`).join(", ")})`,
        beforeHash: statusHash(row),
        afterHash: statusHash(updated),
        correlation: {},
      });
      return updated;
    });
  }

  /**
   * Resolves a profile pack ref (`id@X.Y` or `id@X.Y.Z`) to the highest version that may take new
   * dispatches in this environment (FR-PCK-003). Throws when none does.
   */
  async resolveForDispatch(ref: string, kind: PackKind, env: DispatchEnvironment): Promise<PackVersionRow> {
    const m = /^([a-z][a-z0-9-]*)@(\d+\.\d+)(\.\d+)?$/.exec(ref);
    if (!m) throw new PackNotFoundError(`invalid pack ref "${ref}"`);
    const [, packId = "", minor = "", patch] = m;
    const rows = await this.db
      .select()
      .from(packVersion)
      .where(and(eq(packVersion.packId, packId), eq(packVersion.kind, kind)));
    const matching = rows.filter((r) => (patch ? r.semver === `${minor}${patch}` : r.semver.startsWith(`${minor}.`)));
    if (matching.length === 0) throw new PackNotFoundError(`no ${kind} pack matches ${ref}`);
    const allowed = matching
      .filter((r) => packAllowsNewDispatch(r.status as PackStatus, env))
      .sort((a, b) => compareSemver(b.semver, a.semver));
    const best = allowed[0];
    if (!best) {
      const found = matching.map((r) => `${r.semver}=${r.status}`).join(", ");
      throw new PackNotDispatchableError(`no version of ${ref} may take new ${env} dispatches (${found})`);
    }
    return best;
  }
}
