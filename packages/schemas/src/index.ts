import {
  ACTOR_KINDS,
  DECISION_CLASSES,
  DECISION_ROUTES,
  decisionInvariantViolation,
  AUDIT_EXPORT_FORMAT,
  type AuditEventContent,
  type AuditExportSegment,
  type ExportedEvidence,
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

/** Objects read back from the write-once store are external input (CLAUDE.md §6; ADR-0015). */
const chainPointSchema = z.strictObject({ seq: z.number().int().min(0), hash: sha256HexSchema });

const exportedEventSchema = z.strictObject({
  seq: z.number().int().positive(),
  ts: z.iso.datetime(),
  actor: actorSchema,
  action: z.string().min(1),
  target: z.string().min(1),
  reason: z.string(),
  beforeHash: sha256HexSchema.nullable(),
  afterHash: sha256HexSchema.nullable(),
  correlation: correlationSchema,
  prevHash: sha256HexSchema,
  hash: sha256HexSchema,
});

export const auditExportSegmentSchema = z.strictObject({
  format: z.literal(AUDIT_EXPORT_FORMAT),
  index: z.number().int().positive(),
  anchor: chainPointSchema,
  last: chainPointSchema,
  exportedAt: z.iso.datetime(),
  events: z.array(exportedEventSchema).min(1),
}) satisfies z.ZodType<AuditExportSegment>;

export const exportedEvidenceSchema = z.looseObject({
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  envelope: z.unknown(),
}) satisfies z.ZodType<ExportedEvidence>;

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
export * from "./reviewer-sets.js";
export * from "./platform-config.js";
export * from "./rota.js";
export * from "./working-calendar.js";
export * from "./role-policy.js";
