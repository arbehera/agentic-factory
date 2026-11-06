import { readFile } from "node:fs/promises";
import { systemClock } from "@adlc/control-plane";
import { loadYamlContract } from "@adlc/pack-sdk";
import { reviewerSetsSchema } from "@adlc/schemas";
import { createLogger } from "@adlc/telemetry";
import { buildSigner, signerConfigSchema } from "./bootstrap.js";

const config = signerConfigSchema.parse(process.env);
const logger = createLogger("signer", { level: config.LOG_LEVEL });
const reviewerSets = loadYamlContract(reviewerSetsSchema, await readFile(config.REVIEWER_SETS_FILE, "utf8"), config.REVIEWER_SETS_FILE);
const { worker, publicKeyPem, keyId, pool } = buildSigner(config, { reviewerSets, clock: systemClock, logger });
worker.start();
// The public key is not secret: verifiers need it (dev key; the pilot key lives in an HSM/KMS, OPEN-07).
logger.info({ keyId, publicKeyPem, environment: config.SIGNER_ENVIRONMENT }, "signer worker running");
process.on("SIGTERM", () => {
  worker.stop();
  void pool.end();
});
