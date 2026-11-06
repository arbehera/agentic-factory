import { defineConfig } from "vitest/config";

// NFR-007: >= 75% line coverage (apps/dev-fakes).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts"],
      thresholds: { lines: 75, statements: 75, functions: 75, branches: 75 },
    },
  },
});
