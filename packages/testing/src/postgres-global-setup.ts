import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

/**
 * One PostgreSQL 16 container per test run; each test file gets its own database (helpers.ts).
 * ADLC_SKIP_INTEGRATION=1 skips explicitly — the tests then report as skipped, never as passed.
 */
export default async function setup(project: TestProject): Promise<(() => Promise<void>) | undefined> {
  if (process.env.ADLC_SKIP_INTEGRATION === "1") {
    project.provide("pgAdminUrl", "");
    return undefined;
  }
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  project.provide("pgAdminUrl", container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}
