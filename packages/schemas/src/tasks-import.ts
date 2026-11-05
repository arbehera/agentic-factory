import { FEATURE_RE, REQUIREMENT_ID_RE, SPEC_TASK_ID_RE, TASK_COMPLEXITIES } from "@adlc/domain";
import { z } from "zod";

/**
 * `specs/NNN-*\/tasks.import.json` (spec.md §6, FR-IMP-001). Produced by the importer from
 * tasks.md; consumed by DoR, the G4 pack and Jira creation. Absent Pioneer tokens are `null` or
 * `[]` here — DoR Stage A (FR-DOR-001) decides whether a task is ready (ADR-0007).
 */
const taskId = z.string().regex(SPEC_TASK_ID_RE);

export const specRefSchema = z.strictObject({
  feature: z.string().regex(FEATURE_RE),
  taskId,
  path: z.string().regex(/^specs\/\d{3}-[a-z0-9-]+\/tasks\.md$/),
  sha: z.string().regex(/^[0-9a-f]{7,40}$/),
});

export const taskImportSchema = z.strictObject({
  taskId,
  title: z.string().min(1),
  userStory: z.string().regex(/^US\d+$/).nullable(),
  parallel: z.boolean(),
  requirementIds: z.array(z.string().regex(REQUIREMENT_ID_RE)),
  component: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/).nullable(),
  complexity: z.enum(TASK_COMPLEXITIES).nullable(),
  flags: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)),
  depends: z.array(taskId),
  acceptanceCriteria: z.array(z.string().min(1)),
  specRef: specRefSchema,
});
export type TaskImport = z.infer<typeof taskImportSchema>;

export const tasksImportFileSchema = z.array(taskImportSchema);
export type TasksImportFile = z.infer<typeof tasksImportFileSchema>;
