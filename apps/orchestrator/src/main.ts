import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { createAdapters } from "@adlc/adapters";
import { systemClock } from "@adlc/control-plane";
import { DockerExecutorBackend } from "@adlc/executor";
import { createLogger } from "@adlc/telemetry";
import { loadConfig } from "./config.js";
import { AppModule } from "./http/app.module.js";
import { buildOrchestrator } from "./orchestrator.js";

const config = loadConfig(process.env);
const logger = createLogger("orchestrator", { level: config.LOG_LEVEL });
const issues = config.ADAPTERS ? createAdapters(config).issues : undefined;
// Executor host role: this replica starts agent containers on the rootless daemon (ADR-0011, ADR-0014).
const executor = config.AGENT_IMAGE ? await DockerExecutorBackend.connect({ trustedImages: new Set([config.AGENT_IMAGE]) }) : undefined;
const orchestrator = buildOrchestrator(config, { clock: systemClock, logger, ...(issues ? { issues } : {}), ...(executor ? { executor } : {}) });
const app = await NestFactory.create(AppModule.forRoot(orchestrator, config.INTERNAL_API_TOKEN ?? null), { logger: false });
app.enableShutdownHooks();
await app.listen(config.PORT);
logger.info({ port: config.PORT, adapters: config.ADAPTERS ?? "none", executor: Boolean(executor), dispatchRole: config.DISPATCH_ROLE ?? null }, "orchestrator listening");
