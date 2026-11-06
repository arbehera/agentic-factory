import { createLogger } from "@adlc/telemetry";
import { createFakesServer } from "@adlc/testing/fakes";
import { z } from "zod";

/**
 * Dev-only fake Jira + GitHub for the Compose stack and end-to-end tests (P0-WP11). State is in
 * memory and lost on restart. Never part of a production deployment.
 */
const env = z
  .object({
    PORT: z.coerce.number().int().min(0).max(65535).default(4000),
    FAKES_TOKEN: z.string().min(16),
    LOG_LEVEL: z.string().default("info"),
  })
  .parse(process.env);

const logger = createLogger("dev-fakes", { level: env.LOG_LEVEL });
const { server } = createFakesServer({ token: env.FAKES_TOKEN });
server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "dev-fakes listening (fake Jira and GitHub, in memory)");
});
process.on("SIGTERM", () => server.close());
