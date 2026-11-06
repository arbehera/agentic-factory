import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { ImportSourceError, parseTasksMarkdown, renderTasksImport, TasksFormatError } from "./parse-tasks.js";

// Usage: adlc-import <specs/NNN-slug/tasks.md> --sha <commit> [--repo-root <dir>] [--out <file>]
// Writes tasks.import.json next to tasks.md unless --out is given. Exit 1 = format errors, 2 = usage.
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { sha: { type: "string" }, "repo-root": { type: "string" }, out: { type: "string" } },
});
const file = positionals[0];
if (!file || !values.sha || positionals.length > 1) {
  console.error("usage: adlc-import <specs/NNN-slug/tasks.md> --sha <commit> [--repo-root <dir>] [--out <file>]");
  process.exit(2);
}
const repoRoot = path.resolve(values["repo-root"] ?? ".");
const abs = path.resolve(repoRoot, file);
const rel = path.relative(repoRoot, abs).split(path.sep).join("/");

try {
  const tasks = parseTasksMarkdown(await readFile(abs, "utf8"), { path: rel, sha: values.sha });
  const out = values.out ?? path.join(path.dirname(abs), "tasks.import.json");
  await writeFile(out, renderTasksImport(tasks));
  console.log(`imported ${tasks.length} task(s) from ${rel} -> ${path.relative(repoRoot, out)}`);
} catch (err) {
  if (err instanceof TasksFormatError) {
    console.error(err.message);
    process.exitCode = 1;
  } else if (err instanceof ImportSourceError) {
    console.error(err.message);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
