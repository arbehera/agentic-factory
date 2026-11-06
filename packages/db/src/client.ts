import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;
/** A transaction handle; repositories accept either so callers can compose them atomically. */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbExecutor = Db | DbTx;

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

/**
 * A connection pool. An idle connection can be closed by the server at any time (restart,
 * failover, `pg_terminate_backend`). node-postgres reports that as an `error` event on the pool,
 * which would crash the process if unhandled. The pool has already discarded the client, and the
 * next query opens a new connection, so the error is reported to `onIdleError` and the service
 * carries on. That is how services ride through a database failover (AT-P0-06).
 */
export function createPool(connectionString: string, opts: { onIdleError?: (err: Error) => void } = {}): pg.Pool {
  // Bounded connects and TCP keep-alive: a vanished host fails fast instead of hanging (AT-P0-06).
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 10_000, keepAlive: true });
  const report =
    opts.onIdleError ??
    ((err: Error) => {
      process.emitWarning(`idle database connection closed: ${err.message}`);
    });
  pool.on("error", report);
  return pool;
}

/** Applies pending migrations; safe to repeat. */
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
