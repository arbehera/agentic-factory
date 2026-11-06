import { SIGN_EVIDENCE_JOB } from "@adlc/control-plane";
import { createDb, JobQueue, runMigrations } from "@adlc/db";
import { createLogger } from "@adlc/telemetry";
import { FakeSourceControl, freshDatabase, seedProjectAndDefinition, skipIntegration } from "@adlc/testing";
import { describe, expect, it } from "vitest";
import { buildSigner, signerConfigSchema } from "../src/index.js";

const silent = createLogger("signer-test", { level: "silent" });
const base = { DATABASE_URL: "postgres://u@db/adlc", ADAPTERS: "dev-fakes", FAKES_URL: "http://dev-fakes:4000", FAKES_TOKEN: "x".repeat(16) };

describe("P0-WP11 signer service configuration", () => {
  it("needs an explicit environment; production refuses a software key (OPEN-07)", () => {
    expect(signerConfigSchema.safeParse(base).success).toBe(false); // SIGNER_ENVIRONMENT missing
    const prod = signerConfigSchema.parse({ ...base, SIGNER_ENVIRONMENT: "production" });
    expect(() => buildSigner(prod, { reviewerSets: { sets: {} }, clock: { now: () => new Date() }, logger: silent, scm: new FakeSourceControl() })).toThrow(/production/);
    expect(signerConfigSchema.parse({ ...base, SIGNER_ENVIRONMENT: "dev", REQUIRED_CHECKS: "adlc/verify, adlc/paths" }).REQUIRED_CHECKS).toEqual(["adlc/verify", "adlc/paths"]);
  });
});

describe.skipIf(skipIntegration)("P0-WP11 signer service", () => {
  it("AT-P0-01 claims signing jobs from the queue and decides itself: no verdict, no signature", async () => {
    const t = await freshDatabase({ migrate: (pool) => runMigrations(createDb(pool)) });
    const github = new FakeSourceControl();
    const main = github.seedRepo("org/product", { "README.md": "x" });
    await github.createBranch("org/product", "task/PILOT-1", main);
    const { sha } = await github.commit("org/product", "task/PILOT-1", { files: [{ path: "a.md", content: "a" }], message: "m", parentSha: main });
    await github.openPullRequest("org/product", { head: "task/PILOT-1", base: "main", title: "t", body: "" });
    const seed = await seedProjectAndDefinition(t.pool);
    await t.pool.query(`update project set repos = '["org/product"]'::jsonb where id = $1`, [seed.projectId]);
    const config = signerConfigSchema.parse({ ...base, DATABASE_URL: t.url, SIGNER_ENVIRONMENT: "dev" });
    const svc = buildSigner(config, { reviewerSets: { sets: { dummy: ["dummy-reviewer"] } }, clock: { now: () => new Date() }, logger: silent, scm: github });
    try {
      expect(svc.publicKeyPem).toContain("BEGIN PUBLIC KEY");
      await new JobQueue(createDb(t.pool)).enqueue({ kind: SIGN_EVIDENCE_JOB, payload: { repo: "org/product", prNumber: 1, headSha: sha, authorRole: "dummy" }, runAfter: new Date(Date.now() - 1000) });
      expect(await svc.worker.drain()).toBe(1);
      expect(github.postedStatuses.at(-1)).toMatchObject({ sha, status: { context: "adlc/evidence", state: "failure" } });
    } finally {
      await svc.pool.end();
      await t.close();
    }
  });
});
