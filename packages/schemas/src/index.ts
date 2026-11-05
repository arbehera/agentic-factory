import {
  ACTOR_KINDS,
  DECISION_CLASSES,
  DECISION_ROUTES,
  decisionInvariantViolation,
  type AuditEventContent,
} from "@adlc/domain";
import { z } from "zod";

/** Boundary schemas (CLAUDE.md §6). Vocabularies come from `@adlc/domain`; never redeclare them. */

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase SHA-256 hex digest");

export const actorSchema = z.strictObject({
  kind: z.enum(ACTOR_KINDS),
  id: z.string().min(1).max(200),
});

export const correlationSchema = z.strictObject({
  projectId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  taskKey: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
});

/** Input to the audit writer (hard rule 11): actor, reason and before/after hash are mandatory. */
export const auditEventInputSchema = z.strictObject({
  actor: actorSchema,
  action: z.string().min(1).max(200),
  target: z.string().min(1).max(500),
  reason: z.string().min(1).max(4000),
  beforeHash: sha256HexSchema.nullable(),
  afterHash: sha256HexSchema.nullable(),
  correlation: correlationSchema,
}) satisfies z.ZodType<AuditEventContent>;

/** A Decision as raised through the `decisions` MCP server or by the orchestrator (spec.md §5). */
export const decisionInputSchema = z
  .strictObject({
    class: z.enum(DECISION_CLASSES),
    route: z.enum(DECISION_ROUTES),
    question: z.string().min(1).max(8000),
    options: z.array(z.string().min(1).max(2000)).max(20),
    owner: z.string().min(1).max(200),
    timeboxMinutes: z.number().int().positive().max(60 * 24 * 30),
    reversible: z.boolean(),
    autoResolve: z.boolean(),
    projectId: z.string().min(1),
    taskKey: z.string().min(1).optional(),
  })
  .superRefine((d, ctx) => {
    const violation = decisionInvariantViolation(d);
    if (violation) ctx.addIssue({ code: "custom", message: violation, path: ["class"] });
  });
export type DecisionInput = z.infer<typeof decisionInputSchema>;

export * from "./json-schema.js";
export * from "./tasks-import.js";
export * from "./packs.js";
