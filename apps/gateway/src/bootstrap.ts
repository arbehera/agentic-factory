import { createAdapters, EnvSecretProvider, type SecretProvider } from "@adlc/adapters";
import { HeartbeatService, KillSwitch, type Clock } from "@adlc/control-plane";
import { ControlFlagRepository, createDb, createPool, LeaseRepository, ModelCallRepository } from "@adlc/db";
import { allTools } from "@adlc/mcp-servers";
import type { Logger } from "@adlc/telemetry";
import type pg from "pg";
import type { GatewayConfig } from "./config.js";
import { Gateway } from "./gateway.js";
import { ModelProxy } from "./model-proxy.js";
import { loadRolePolicies } from "./policies.js";

export interface GatewayService {
  gateway: Gateway;
  models: ModelProxy | null;
  pool: pg.Pool;
}

/**
 * Composition root of the gateway (P0-WP11). Credentials come only from the SecretProvider and go
 * only into the adapters and the model proxy (hard rule 9). Dev reads `ADLC_SECRET_*` variables;
 * the vault backend replaces it with the production deployment.
 */
export async function buildGateway(
  config: GatewayConfig,
  deps: { clock: Clock; logger: Logger; secrets?: SecretProvider; fetchImpl?: typeof fetch; env?: Record<string, string | undefined> },
): Promise<GatewayService> {
  const policies = await loadRolePolicies(config.AGENTS_DIR);
  const adapters = createAdapters(config, deps.fetchImpl);
  const secrets = deps.secrets ?? new EnvSecretProvider(deps.env ?? {});
  const pool = createPool(config.DATABASE_URL, { onIdleError: (err) => deps.logger.warn({ err: err.message }, "idle database connection closed") });
  const db = createDb(pool);
  const heartbeats = new HeartbeatService(new LeaseRepository(db), new KillSwitch(new ControlFlagRepository(db), deps.clock), deps.clock);
  const gateway = new Gateway({ db, tools: allTools, policies, adapters: { jira: adapters.issues, github: adapters.scm }, secrets, heartbeats, clock: deps.clock, logger: deps.logger });
  const models = config.MODEL_UPSTREAM_URL
    ? new ModelProxy({ upstreamUrl: config.MODEL_UPSTREAM_URL.replace(/\/$/, ""), apiKeySecret: config.MODEL_API_KEY_SECRET, maxTokensCap: config.MODEL_MAX_TOKENS_CAP }, secrets, new ModelCallRepository(db), deps.clock, deps.logger)
    : null;
  deps.logger.info({ roles: [...policies.keys()], adapters: config.ADAPTERS, modelProxy: Boolean(models) }, "gateway configured");
  return { gateway, models, pool };
}
