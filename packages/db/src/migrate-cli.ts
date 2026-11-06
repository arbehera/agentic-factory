import { createDb, createPool, runMigrations } from "./client.js";
import { grantAppRole } from "./roles.js";

// `pnpm db:migrate` — DATABASE_URL must point at the target PostgreSQL 16 instance, as the owner.
// With APP_DB_ROLE set, the application role's grants are (re)applied afterwards (P0-WP11).
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}
const pool = createPool(url);
try {
  await runMigrations(createDb(pool));
  console.log("migrations applied");
  const role = process.env.APP_DB_ROLE;
  if (role) {
    await grantAppRole(pool, role);
    console.log(`grants applied to ${role}`);
  }
} finally {
  await pool.end();
}
