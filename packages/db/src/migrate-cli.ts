import { createDb, createPool, runMigrations } from "./client.js";

// `pnpm db:migrate` — DATABASE_URL must point at the target PostgreSQL 16 instance.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}
const pool = createPool(url);
try {
  await runMigrations(createDb(pool));
  console.log("migrations applied");
} finally {
  await pool.end();
}
