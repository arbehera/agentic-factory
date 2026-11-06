import { RUN_EXIT_CODES } from "@adlc/executor/contract";
import type { Logger } from "@adlc/telemetry";
import { z } from "zod";
import { GatewayClient } from "./gateway-client.js";
import { Heartbeater } from "./heartbeat.js";
import { runDummy } from "./roles/dummy.js";
import { runDummyReviewer } from "./roles/dummy-reviewer.js";

/** Container environment set by the orchestrator's RunLauncher. */
export const agentEnvSchema = z.object({
  ADLC_GATEWAY_URL: z.url(),
  ADLC_GATEWAY_TOKEN: z.string().min(20),
  ADLC_RUN_ID: z.uuid(),
  ADLC_TASK_KEY: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/),
  ADLC_ROLE: z.string().regex(/^[a-z][a-z0-9-]*$/),
  ADLC_REPO: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  /** Model ID from the agent definition (roles that call a model). */
  ADLC_MODEL: z.string().min(1).max(200).optional(),
  /** Review runs: the pull request and the exact head commit under review. */
  ADLC_PR_NUMBER: z.coerce.number().int().positive().optional(),
  ADLC_HEAD_SHA: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  /** FR-ORC-008: 5 minutes, i.e. three beats per 15-minute lease. */
  ADLC_HEARTBEAT_MS: z.coerce.number().int().positive().default(300_000),
});

/**
 * Runs one agent (C3) and returns the exit code agreed with the supervisor (RUN_EXIT_CODES).
 * Phase 0 has one role, the deterministic dummy agent; model-driven roles arrive with the agent
 * SDK in Phase 1.
 */
export async function runAgent(env: Record<string, string | undefined>, logger: Logger): Promise<number> {
  const parsed = agentEnvSchema.safeParse(env);
  if (!parsed.success) {
    // Report which variables are wrong, never their values (one of them is a credential).
    logger.error({ invalid: parsed.error.issues.map((i) => i.path.join(".")) }, "invalid agent environment");
    return RUN_EXIT_CODES.failed;
  }
  const e = parsed.data;
  const log = logger.child({ runId: e.ADLC_RUN_ID, taskKey: e.ADLC_TASK_KEY, role: e.ADLC_ROLE });
  if (e.ADLC_ROLE === "dummy-reviewer") return review(e, log);
  if (e.ADLC_ROLE !== "dummy") {
    log.error("role not available in this runtime version");
    return RUN_EXIT_CODES.failed;
  }

  const gateway = new GatewayClient(e.ADLC_GATEWAY_URL, e.ADLC_GATEWAY_TOKEN);
  const heart = new Heartbeater(gateway, log);
  try {
    await heart.beat(); // learn about a kill switch or a lost lease before doing anything
    heart.start(e.ADLC_HEARTBEAT_MS);
    if (heart.leaseLost()) {
      log.error("lease is not held; not starting");
      return RUN_EXIT_CODES.failed;
    }
    const outcome = await runDummy(gateway, { runId: e.ADLC_RUN_ID, taskKey: e.ADLC_TASK_KEY, repo: e.ADLC_REPO, shouldStop: () => heart.stopRequested(), logger: log });
    if (outcome.status === "stopped") {
      log.warn({ afterStep: outcome.afterStep, leaseLost: heart.leaseLost() }, "stopped on directive");
      return heart.leaseLost() ? RUN_EXIT_CODES.failed : RUN_EXIT_CODES.stoppedByDirective;
    }
    log.info({ pr: outcome.pr }, "run complete");
    return RUN_EXIT_CODES.succeeded;
  } catch (err) {
    log.error({ err: (err as Error).message, kind: (err as Error).name }, "run failed");
    return RUN_EXIT_CODES.failed;
  } finally {
    heart.stop();
    await gateway.close();
  }
}

/**
 * A review run (P0-WP7). It holds no task lease — the author's run does — so it does not
 * heartbeat; its gateway session expires on its own.
 */
async function review(e: z.infer<typeof agentEnvSchema>, log: Logger): Promise<number> {
  if (e.ADLC_PR_NUMBER === undefined || e.ADLC_HEAD_SHA === undefined || e.ADLC_MODEL === undefined) {
    log.error({ missing: ["ADLC_PR_NUMBER", "ADLC_HEAD_SHA", "ADLC_MODEL"].filter((k) => e[k as keyof typeof e] === undefined) }, "review run needs a PR, a head SHA and a model");
    return RUN_EXIT_CODES.failed;
  }
  const gateway = new GatewayClient(e.ADLC_GATEWAY_URL, e.ADLC_GATEWAY_TOKEN);
  try {
    await runDummyReviewer(gateway, { runId: e.ADLC_RUN_ID, repo: e.ADLC_REPO, prNumber: e.ADLC_PR_NUMBER, headSha: e.ADLC_HEAD_SHA, model: e.ADLC_MODEL, logger: log });
    return RUN_EXIT_CODES.succeeded;
  } catch (err) {
    log.error({ err: (err as Error).message, kind: (err as Error).name }, "review failed");
    return RUN_EXIT_CODES.failed;
  } finally {
    await gateway.close();
  }
}
