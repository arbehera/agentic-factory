import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { createLogger } from "@adlc/telemetry";
import { systemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { AppModule } from "./http/app.module.js";
import { buildOrchestrator } from "./orchestrator.js";

const config = loadConfig(process.env);
const logger = createLogger("orchestrator", { level: config.LOG_LEVEL });
const app = await NestFactory.create(AppModule.forRoot(buildOrchestrator(config, { clock: systemClock, logger })), { logger: false });
app.enableShutdownHooks();
await app.listen(config.PORT);
logger.info({ port: config.PORT }, "orchestrator listening");
