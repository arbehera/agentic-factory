import type pg from "pg";

/** Tables no service may change or empty once a row exists (hard rule 11, FR-EVD-001). */
export const WRITE_ONCE_TABLES = ["audit_event", "model_call", "reviewer_verdict", "evidence_record"] as const;

const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export class InvalidRoleNameError extends Error {
  override name = "InvalidRoleNameError";
}

/**
 * Grants the application role what services need, and nothing that rewrites history (P0-WP11).
 * Services connect as this role; migrations run as the owner. The role:
 * - reads and writes the platform tables, but has no UPDATE, DELETE or TRUNCATE on the
 *   write-once tables. The triggers reject those too, and as a non-owner the role cannot drop them;
 * - creates audit partitions only through `adlc_ensure_audit_partition` (SECURITY DEFINER);
 * - owns nothing, so it cannot alter or drop schema objects.
 * Safe to repeat after every migration (new tables get the grants too).
 */
export async function grantAppRole(pool: pg.Pool, role: string): Promise<void> {
  if (!ROLE_RE.test(role)) throw new InvalidRoleNameError(`invalid role name ${JSON.stringify(role)}`);
  const r = `"${role}"`;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`grant usage on schema public to ${r}`);
    await client.query(`grant select, insert, update, delete on all tables in schema public to ${r}`);
    await client.query(`grant usage, select, update on all sequences in schema public to ${r}`);
    await client.query(`revoke update, delete, truncate on ${WRITE_ONCE_TABLES.join(", ")} from ${r}`);
    // Existing audit partitions are reached through the parent; direct writes are not granted.
    const { rows } = await client.query<{ name: string }>("select inhrelid::regclass::text as name from pg_inherits where inhparent = 'audit_event'::regclass");
    for (const { name } of rows) await client.query(`revoke all on ${name} from ${r}`);
    await client.query(`grant execute on function adlc_ensure_audit_partition(date) to ${r}`);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
