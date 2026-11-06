import { randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";

/**
 * PostgreSQL test helpers (CLAUDE.md §7: Testcontainers for PostgreSQL). Use with the global
 * setup in `@adlc/testing/postgres-global-setup`, which starts one container per test run.
 */

export const skipIntegration = process.env.ADLC_SKIP_INTEGRATION === "1";

export interface TestDatabase {
  url: string;
  pool: pg.Pool;
  close(): Promise<void>;
}

/** Creates an isolated database in the shared container and runs `migrate` against it. */
export async function freshDatabase(options: {
  migrate: (pool: pg.Pool) => Promise<void>;
  sessionTimeZone?: string;
}): Promise<TestDatabase> {
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
  await options.migrate(pool);
  return { url: url.toString(), pool, close: () => pool.end() };
}

/** Inserts one project and one agent definition; returns their IDs. */
export async function seedProjectAndDefinition(pool: pg.Pool): Promise<{ projectId: string; agentDefinitionId: string }> {
  const { rows: p } = await pool.query<{ id: string }>(
    "insert into project (name, jira_project_key, status) values ('p', $1, 'active') returning id",
    [`P${randomUUID().slice(0, 8).toUpperCase()}`],
  );
  const { rows: d } = await pool.query<{ id: string }>(
    `insert into agent_definition (name, version, role, tier, model_id, autonomy_level, owner_role, release, source_sha, content_hash)
     values ($1, '0.0.1', 'dummy', 'B', 'none', 1, 'lead', 'R1', 'sha', 'hash') returning id`,
    [`dummy-${randomUUID()}`],
  );
  return { projectId: (p[0] as { id: string }).id, agentDefinitionId: (d[0] as { id: string }).id };
}
