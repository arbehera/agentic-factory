import type pg from "pg";

/**
 * Dev seed for the Compose stack (P0-WP11): one project and the Phase 0 agent definitions, so the
 * dispatcher has something to offer. Placeholder data only; nothing Pioneer-specific. Idempotent.
 */
export interface DevSeed {
  projectKey: string;
  repo: string;
}

const DEFINITIONS = [
  // The dummy roles make no model calls (P0-WP4, P0-WP7); model_id records that.
  { name: "dummy", role: "dummy" },
  { name: "dummy-reviewer", role: "dummy-reviewer" },
] as const;

export async function applyDevSeed(pool: pg.Pool, seed: DevSeed): Promise<{ projectId: string }> {
  // `production` is the dispatch class (full executor slots, Qualified packs only), not a claim
  // about the data: the sandbox quota of 2 would cap the 20-run load test (AT-P0-05).
  const { rows } = await pool.query<{ id: string }>(
    `insert into project (name, jira_project_key, repos, status, environment)
     values ($1, $2, $3::jsonb, 'active', 'production')
     on conflict (jira_project_key) do update set repos = excluded.repos, status = 'active'
     returning id`,
    [`Dev project ${seed.projectKey} (placeholder)`, seed.projectKey, JSON.stringify([seed.repo])],
  );
  for (const d of DEFINITIONS) {
    await pool.query(
      `insert into agent_definition (name, version, role, tier, model_id, autonomy_level, owner_role, release, source_sha, content_hash)
       values ($1, '0.0.1', $2, 'B', 'none', 0, 'platform', 'dev', $3, 'dev-seed')
       on conflict (name, version) do nothing`,
      [d.name, d.role, "0".repeat(40)],
    );
  }
  // An upsert with RETURNING always yields the row.
  return { projectId: (rows[0] as { id: string }).id };
}
