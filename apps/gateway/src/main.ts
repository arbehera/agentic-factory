import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { systemClock } from "@adlc/control-plane";
import { createLogger } from "@adlc/telemetry";
import { buildGateway } from "./bootstrap.js";
import { loadGatewayConfig } from "./config.js";
import { GatewayModule } from "./http/app.module.js";

const config = loadGatewayConfig(process.env);
const logger = createLogger("gateway", { level: config.LOG_LEVEL });
const { gateway, models, pool } = await buildGateway(config, { clock: systemClock, logger, env: process.env });
const app = await NestFactory.create(GatewayModule.forRoot(gateway, models), { logger: false });
app.enableShutdownHooks();
process.on("SIGTERM", () => {
  void app.close().then(() => pool.end());
});
await app.listen(config.PORT);
logger.info({ port: config.PORT }, "gateway listening");
