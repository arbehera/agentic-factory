import { defineConfig } from "vitest/config";

// Tests need no React plugin: esbuild compiles JSX through tsconfig ("jsx": "react-jsx").
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "src/vite-env.d.ts"],
      // NFR-007: >= 75% outside domain/orchestrator/signer.
      thresholds: { lines: 75, statements: 75, functions: 75, branches: 75 },
    },
  },
});
