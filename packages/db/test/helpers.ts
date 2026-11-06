import { randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { createDb, runMigrations, type Db } from "../src/index.js";

export const skipIntegration = process.env.ADLC_SKIP_INTEGRATION === "1";

export interface TestDatabase {
  pool: pg.Pool;
  db: Db;
  close(): Promise<void>;
}

/** Creates an isolated, fully migrated database in the shared container. */
export async function freshDatabase(options: { sessionTimeZone?: string } = {}): Promise<TestDatabase> {
  const adminUrl = inject("pgAdminUrl");
  const name = `t_${randomUUID().replace(/-/g, "")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({
    connectionString: url.toString(),
    ...(options.sessionTimeZone ? { options: `-c TimeZone=${options.sessionTimeZone}` } : {}),
  });
  const db = createDb(pool);
  await runMigrations(db);
  return { pool, db, close: () => pool.end() };
}
