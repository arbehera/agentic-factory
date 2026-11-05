import { defineConfig } from "vitest/config";

// NFR-007: >= 85% line coverage for apps/signer. Integration tests share one PostgreSQL 16 container.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 85 },
    },
  },
});
