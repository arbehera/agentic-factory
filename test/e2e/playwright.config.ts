import { defineConfig } from "@playwright/test";

// Portal end-to-end tests (P0-WP11) against the Compose stack; run by scripts/dev/e2e.sh inside the
// pinned Playwright image, in Keycloak's network namespace (so localhost:8080 is Keycloak, as in the
// token issuer, and the portal is http://portal-web:8080).
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "results/artifacts",
  timeout: 120_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PORTAL_URL ?? "http://portal-web:8080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Sign-in uses PKCE, which needs crypto.subtle, which browsers give only to secure origins.
    // localhost is one (people use http://localhost:8081); the test's in-network origin is not.
    // The flag needs full Chromium: the default headless shell ignores it (checked in the image).
    channel: "chromium",
    launchOptions: { args: ["--unsafely-treat-insecure-origin-as-secure=http://portal-web:8080"] },
  },
});
