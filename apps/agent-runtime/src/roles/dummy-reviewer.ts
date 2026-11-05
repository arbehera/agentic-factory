import type { Logger } from "@adlc/telemetry";
import type { GatewayClient } from "../gateway-client.js";

/**
 * The Phase 0 dummy reviewer (P0-WP7): "one dummy reviewer verdict". It makes one model call
 * through the gateway's proxy — so the call is logged against this run — and records a verdict on
 * the exact PR head that cites that call (FR-EVD-001). The model's reply is untrusted data
 * (hard rule 10): it is mapped to a verdict by a fixed rule, never interpreted beyond that.
 */

export interface ReviewerContext {
  runId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  model: string;
  logger: Logger;
}

export interface ReviewOutcome {
  verdict: "approve" | "request-changes";
  modelCallId: string;
}

export async function runDummyReviewer(gw: GatewayClient, ctx: ReviewerContext): Promise<ReviewOutcome> {
  const reply = await gw.model({
    model: ctx.model,
    max_tokens: 64,
    messages: [{ role: "user", content: `Review commit ${ctx.headSha} of pull request ${ctx.repo}#${ctx.prNumber}. Answer LGTM or CHANGES.` }],
  });
  const text = reply.content.find((c) => c.type === "text")?.text ?? "";
  const verdict = /^\s*LGTM\b/.test(text) ? "approve" : "request-changes";
  await gw.tool("evidence", "write_verdict", {
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    headSha: ctx.headSha,
    verdict,
    summary: text.slice(0, 500) || "(empty reply)",
    modelCallId: reply.id,
  });
  ctx.logger.info({ verdict, modelCallId: reply.id }, "verdict recorded");
  return { verdict, modelCallId: reply.id };
}
