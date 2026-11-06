import { defineConfig } from "vitest/config";

// NFR-007: >= 75% line coverage outside domain/orchestrator/signer.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts"],
      thresholds: { lines: 75, statements: 75, functions: 75, branches: 75 },
    },
  },
});
