import { defineConfig } from "vitest/config";

// NFR-007: >= 85% line coverage for packages/domain.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 85 },
    },
  },
});
