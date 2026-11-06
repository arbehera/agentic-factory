import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { createAdapters } from "@adlc/adapters";
import { connectObjectStore } from "./object-store.js";
import { systemClock } from "@adlc/control-plane";
import { DockerExecutorBackend } from "@adlc/executor";
import { readFile } from "node:fs/promises";
import { loadYamlContract } from "@adlc/pack-sdk";
import { reviewerSetsSchema } from "@adlc/schemas";
import { createLogger } from "@adlc/telemetry";
import { loadConfig } from "./config.js";
import { AppModule } from "./http/app.module.js";
import { buildOrchestrator } from "./orchestrator.js";

const config = loadConfig(process.env);
const logger = createLogger("orchestrator", { level: config.LOG_LEVEL });
const adapters = config.ADAPTERS ? createAdapters(config) : undefined;
const reviewerSets = config.REVIEWER_SETS_FILE ? loadYamlContract(reviewerSetsSchema, await readFile(config.REVIEWER_SETS_FILE, "utf8"), config.REVIEWER_SETS_FILE) : undefined;
// Executor host role: this replica starts agent containers on the rootless daemon (ADR-0011, ADR-0014).
const executor = config.AGENT_IMAGE ? await DockerExecutorBackend.connect({ trustedImages: new Set([config.AGENT_IMAGE]) }) : undefined;
// Write-once audit export (NFR-006): refuses to start against a bucket without Object Lock.
const objectStore = config.OBJECT_STORE_ENDPOINT ? await connectObjectStore(config) : undefined;
if (!objectStore) logger.warn("OBJECT_STORE_ENDPOINT unset: the write-once audit export (NFR-006) is off");
const orchestrator = buildOrchestrator(config, {
  clock: systemClock,
  logger,
  ...(adapters ? { issues: adapters.issues, scm: adapters.scm } : {}),
  ...(executor ? { executor } : {}),
  ...(reviewerSets ? { reviewerSets } : {}),
  ...(objectStore ? { objectStore } : {}),
});
const app = await NestFactory.create(AppModule.forRoot(orchestrator, config.INTERNAL_API_TOKEN ?? null), { logger: false });
app.enableShutdownHooks();
await app.listen(config.PORT);
logger.info({ port: config.PORT, adapters: config.ADAPTERS ?? "none", executor: Boolean(executor), dispatchRole: config.DISPATCH_ROLE ?? null, auditExport: Boolean(objectStore) }, "orchestrator listening");
