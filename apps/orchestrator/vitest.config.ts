import { defineConfig } from "vitest/config";

// NFR-007: >= 85% line coverage for apps/orchestrator. Integration tests share one PostgreSQL 16 container.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Process entry points (wiring only; exercised by the Compose stack): main and the audit-export CLI.
      exclude: ["src/main.ts", "src/audit-export-cli.ts"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 85 },
    },
  },
});
