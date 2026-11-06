import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTasksMarkdown, renderTasksImport } from "../src/index.js";

/**
 * FR-IMP-002 contract test: every fixture directory of every allowed Spec Kit version is parsed and
 * compared with its reviewed golden output. Allowed versions: 1.2.6 (CLAUDE.md §5 rule 12).
 */
const fixturesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures");
const ALLOWED_SPECKIT_VERSIONS = ["1.2.6"];
const FIXTURE_SHA = "0000000";

const cases = (
  await Promise.all(
    ALLOWED_SPECKIT_VERSIONS.map(async (v) => {
      const dir = path.join(fixturesRoot, `speckit-${v}`);
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ version: v, feature: e.name, dir: path.join(dir, e.name) }));
    }),
  )
).flat();

describe("FR-IMP-002 importer contract against Spec Kit fixtures", () => {
  it("has at least one fixture per allowed Spec Kit version", () => {
    for (const v of ALLOWED_SPECKIT_VERSIONS) expect(cases.filter((c) => c.version === v).length).toBeGreaterThan(0);
  });

  it.each(cases)("AT-P0-08 parses speckit-$version/$feature to its golden tasks.import.json", async (c) => {
    const md = await readFile(path.join(c.dir, "tasks.md"), "utf8");
    const expected = await readFile(path.join(c.dir, "tasks.import.expected.json"), "utf8");
    const tasks = parseTasksMarkdown(md, { path: `specs/${c.feature}/tasks.md`, sha: FIXTURE_SHA });
    expect(renderTasksImport(tasks)).toBe(expected);
  });
});
