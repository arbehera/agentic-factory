import { freshDatabase as fresh, type TestDatabase as Base } from "@adlc/testing";
import { createDb, runMigrations, type Db } from "../src/index.js";

export { seedProjectAndDefinition, skipIntegration } from "@adlc/testing";

export interface TestDatabase extends Base {
  db: Db;
}

/** A migrated database for one test file, with a Drizzle handle. */
export async function freshDatabase(options: { sessionTimeZone?: string } = {}): Promise<TestDatabase> {
  const t = await fresh({ ...options, migrate: (pool) => runMigrations(createDb(pool)) });
  return { ...t, db: createDb(t.pool) };
}
