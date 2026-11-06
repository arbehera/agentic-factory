import { z } from "zod";
import { tasksImportFileSchema } from "./tasks-import.js";

/**
 * JSON Schemas exported for file contracts (CLAUDE.md §6), written to `packages/schemas/json-schema/`
 * by `pnpm --filter @adlc/schemas gen:json-schema`. A test fails if the committed files are stale.
 */
export function jsonSchemas(): Record<string, unknown> {
  return {
    "tasks.import.schema.json": z.toJSONSchema(tasksImportFileSchema),
  };
}

export function renderJsonSchema(schema: unknown): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
