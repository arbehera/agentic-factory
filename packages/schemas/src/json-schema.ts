import { z } from "zod";
import { processPackManifestSchema, productProfileSchema, techPackManifestSchema } from "./packs.js";
import { reviewerSetsSchema } from "./reviewer-sets.js";
import { rolePolicySchema } from "./role-policy.js";
import { rotaSchema } from "./rota.js";
import { workingCalendarSchema } from "./working-calendar.js";
import { tasksImportFileSchema } from "./tasks-import.js";

/**
 * JSON Schemas exported for file contracts (CLAUDE.md §6), written to `packages/schemas/json-schema/`
 * by `pnpm --filter @adlc/schemas gen:json-schema`. A test fails if the committed files are stale.
 */
export function jsonSchemas(): Record<string, unknown> {
  return {
    "tasks.import.schema.json": z.toJSONSchema(tasksImportFileSchema),
    "product-profile.schema.json": z.toJSONSchema(productProfileSchema, { io: "input" }),
    "tech-pack.schema.json": z.toJSONSchema(techPackManifestSchema),
    "process-pack.schema.json": z.toJSONSchema(processPackManifestSchema),
    "role-policy.schema.json": z.toJSONSchema(rolePolicySchema, { io: "input" }),
    "reviewer-sets.schema.json": z.toJSONSchema(reviewerSetsSchema),
    "rota.schema.json": z.toJSONSchema(rotaSchema, { io: "input" }),
    "working-calendar.schema.json": z.toJSONSchema(workingCalendarSchema, { io: "input" }),
  };
}

export function renderJsonSchema(schema: unknown): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
