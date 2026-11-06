import pg from "pg";
import { z } from "zod";
import { applyDevSeed } from "./dev-seed.js";

// Compose one-shot (after migrations): node apps/dev-fakes/dist/seed-cli.js
const env = z
  .object({ DATABASE_URL: z.url(), DEV_PROJECT_KEY: z.string().regex(/^[A-Z][A-Z0-9]+$/).default("PILOT"), DEV_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/).default("org/product") })
  .parse(process.env);
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
try {
  const { projectId } = await applyDevSeed(pool, { projectKey: env.DEV_PROJECT_KEY, repo: env.DEV_REPO });
  console.log(`dev seed applied: project ${env.DEV_PROJECT_KEY} (${projectId}), repo ${env.DEV_REPO}`);
} finally {
  await pool.end();
}
