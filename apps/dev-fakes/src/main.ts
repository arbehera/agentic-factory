import { randomBytes } from "node:crypto";
import { createLogger } from "@adlc/telemetry";
import { createFakesServer, FakeClaudeApi } from "@adlc/testing/fakes";
import { z } from "zod";

/**
 * Dev-only fake Jira + GitHub for the Compose stack and end-to-end tests (P0-WP11). State is in
 * memory and lost on restart. Never part of a production deployment.
 */
const env = z
  .object({
    PORT: z.coerce.number().int().min(0).max(65535).default(4000),
    /** Fake Claude Messages API for the gateway's model proxy (dummy reviewer, P0-WP7). */
    MODEL_PORT: z.coerce.number().int().min(0).max(65535).default(4001),
    FAKES_TOKEN: z.string().min(16),
    /** Repositories created on start with a README on main, comma-separated. */
    SEED_REPOS: z.string().default(""),
    LOG_LEVEL: z.string().default("info"),
  })
  .parse(process.env);

const logger = createLogger("dev-fakes", { level: env.LOG_LEVEL });
const { server, scm } = createFakesServer({ token: env.FAKES_TOKEN });
for (const repo of env.SEED_REPOS.split(",").map((r) => r.trim()).filter(Boolean)) {
  scm.seedRepo(repo, { "README.md": `# ${repo}\n\nFake repository (dev-fakes).\n` });
}
server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "dev-fakes listening (fake Jira and GitHub, in memory)");
});
// Unique per start: model-call IDs outlive this process in the database (found by AT-P0-01 e2e).
const model = new FakeClaudeApi(`msg_dev_${randomBytes(6).toString("hex")}_`);
await model.start({ port: env.MODEL_PORT, host: "0.0.0.0" });
logger.info({ port: env.MODEL_PORT }, "fake model API listening (POST /v1/messages)");
process.on("SIGTERM", () => {
  server.close();
  void model.stop();
});
