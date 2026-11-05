import { VERDICTS, type Actor } from "@adlc/domain";
import { VerdictExistsError } from "@adlc/db";
import { z } from "zod";
import { assertRepo } from "./policy.js";
import { defineTool, deny, type ToolDef } from "./tool.js";

/**
 * `evidence` MCP server (SDD §11.1): reviewer roles record verdicts into the write-once evidence
 * store under the `adlc-reviewer` identity (FR-EVD-001). The reviewer role is the run's own role
 * — never an argument — the session is bound to the one PR head it reviews, and the cited model
 * call must be one this run made through the gateway and has not cited before.
 */

export const REVIEWER_IDENTITY: Actor = { kind: "service", id: "adlc-reviewer" };

export const evidenceTools: ToolDef[] = [
  defineTool({
    server: "evidence",
    name: "write_verdict",
    description: "Record your verdict on a pull request head, citing the model call that produced it.",
    input: z.strictObject({
      repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      prNumber: z.number().int().positive(),
      headSha: z.string().regex(/^[0-9a-f]{40}$/, "expected the full 40-character head SHA"),
      verdict: z.enum(VERDICTS),
      summary: z.string().min(1).max(8000),
      modelCallId: z.string().min(1).max(200),
    }),
    // Not lease-fenced: a reviewer run does not hold the author's task lease.
    taskWrite: false,
    handle: async (ctx, a, d) => {
      assertRepo(ctx, a.repo);
      const target = ctx.run.reviewTarget;
      if (!target) deny("this session is not a review session");
      if (target.repo !== a.repo || target.prNumber !== a.prNumber || target.headSha !== a.headSha) {
        deny(`this review session may only record a verdict on ${target.repo}#${target.prNumber}@${target.headSha}`);
      }
      const [call] = await d.modelCalls.getMany([a.modelCallId]);
      if (call?.runId !== ctx.run.runId) deny("modelCallId must be a model call this run made through the gateway");
      try {
        return await d.evidence.writeVerdict(
          { projectId: ctx.run.projectId, repo: a.repo, prNumber: a.prNumber, headSha: a.headSha, reviewerRole: ctx.policy.role, reviewerRunId: ctx.run.runId, verdict: a.verdict, summary: a.summary, modelCallId: a.modelCallId },
          REVIEWER_IDENTITY,
          ctx.now,
        );
      } catch (err) {
        if (err instanceof VerdictExistsError) deny(err.message);
        if ((err as { cause?: { constraint?: string } }).cause?.constraint === "reviewer_verdict_model_call_uq") deny("this model call already backs another verdict");
        throw err;
      }
    },
  }),
];
