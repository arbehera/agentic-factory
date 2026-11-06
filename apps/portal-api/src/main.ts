import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { systemClock } from "@adlc/control-plane";
import { createDb, createPool } from "@adlc/db";
import { createLogger } from "@adlc/telemetry";
import { createRemoteJWKSet } from "jose";
import { PortalAuth } from "./auth.js";
import { jwksUrl, loadPortalConfig } from "./config.js";
import { PortalModule } from "./http/portal.module.js";
import { OrchestratorLogSource } from "./orchestrator-logs.js";
import { PortalService } from "./portal-service.js";

const config = loadPortalConfig(process.env);
const logger = createLogger("portal-api", { level: config.LOG_LEVEL });
const pool = createPool(config.DATABASE_URL);
const logs = config.INTERNAL_API_TOKEN && config.ORCHESTRATOR_URLS.length > 0 ? new OrchestratorLogSource(config.ORCHESTRATOR_URLS, config.INTERNAL_API_TOKEN) : null;
const auth = new PortalAuth({ issuer: config.OIDC_ISSUER, audience: config.OIDC_AUDIENCE, keys: createRemoteJWKSet(new URL(jwksUrl(config))) });
const app = await NestFactory.create(PortalModule.forRoot(new PortalService(createDb(pool), logs, systemClock), auth), { logger: false });
app.enableShutdownHooks();
process.on("SIGTERM", () => {
  void app.close().then(() => pool.end());
});
await app.listen(config.PORT);
logger.info({ port: config.PORT, liveLogs: Boolean(logs) }, "portal API listening");
