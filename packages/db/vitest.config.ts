import { defineConfig } from "vitest/config";

// NFR-007: >= 75% line coverage. Integration tests start PostgreSQL 16 with Testcontainers.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/migrate-cli.ts"],
      thresholds: { lines: 75, statements: 75, functions: 75, branches: 75 },
    },
  },
});
