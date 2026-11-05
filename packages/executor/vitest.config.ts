import { defineConfig } from "vitest/config";

// NFR-007: >= 75% line coverage outside domain/orchestrator/signer.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: { lines: 75, statements: 75, functions: 75, branches: 75 },
    },
  },
});
