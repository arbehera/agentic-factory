import { defineConfig } from "drizzle-kit";

// audit-table.ts is intentionally excluded: audit_event is created by a hand-written migration.
export default defineConfig({ dialect: "postgresql", schema: "./src/schema.ts", out: "./migrations" });
