import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsonSchemas, renderJsonSchema, taskImportSchema, tasksImportFileSchema } from "../src/index.js";

const task = {
  taskId: "T014",
  title: "Implement step response",
  userStory: "US2",
  parallel: true,
  requirementIds: ["SWR-233"],
  component: "ExposureCtrl",
  complexity: "M",
  flags: ["hil"],
  depends: ["T010"],
  acceptanceCriteria: ["Converges within 8 frames"],
  specRef: { feature: "012-auto-exposure", taskId: "T014", path: "specs/012-auto-exposure/tasks.md", sha: "9f3c2e1" },
};

describe("FR-IMP-001 tasks.import.json contract", () => {
  it("accepts a complete task and absent Pioneer tokens as null/[]", () => {
    expect(taskImportSchema.parse(task)).toEqual(task);
    const bare = { ...task, userStory: null, requirementIds: [], component: null, complexity: null, flags: [], depends: [] };
    expect(tasksImportFileSchema.parse([bare])).toHaveLength(1);
  });

  it("rejects XL complexity, Spec Kit FR-### IDs, bad SHAs and unknown fields", () => {
    expect(taskImportSchema.safeParse({ ...task, complexity: "XL" }).success).toBe(false);
    expect(taskImportSchema.safeParse({ ...task, requirementIds: ["FR-001"] }).success).toBe(false);
    expect(taskImportSchema.safeParse({ ...task, specRef: { ...task.specRef, sha: "main" } }).success).toBe(false);
    expect(taskImportSchema.safeParse({ ...task, owner: "x" }).success).toBe(false);
  });

  it("the committed JSON Schema files are up to date (run gen:json-schema)", async () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../json-schema");
    for (const [file, schema] of Object.entries(jsonSchemas())) {
      expect(await readFile(path.join(dir, file), "utf8")).toBe(renderJsonSchema(schema));
    }
  });
});
