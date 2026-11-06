import { FEATURE_RE, REQUIREMENT_ID_RE, SPEC_TASK_ID_RE, TASK_COMPLEXITIES, type TaskComplexity } from "@adlc/domain";
import { tasksImportFileSchema, type TaskImport } from "@adlc/schemas";

/**
 * FR-IMP-001: parses a Spec Kit 1.2.6 `tasks.md` with the Pioneer tokens into the
 * `tasks.import.json` contract. Deterministic, no I/O. Grammar (ADR-0007):
 *
 *   - [ ] T014 [P] [US2] [SWR-233,SWR-234] {comp:Name} {cx:M} {flag} Description
 *         depends: T010, T012
 *         AC1: binary pass criterion
 *
 * `depends:` and `ACn:` lines follow their task directly; a blank line ends the task block.
 * Every checkbox list item must be a well-formed task; any malformed task, token, `depends:` or
 * `ACn:` line is reported with its line number. Fenced code blocks are skipped (Spec Kit quotes
 * task text in "Parallel Example" sections). Absent Pioneer tokens yield null/[] for DoR to judge.
 */

export interface TasksSource {
  /** Repo-relative path, `specs/NNN-slug/tasks.md`. */
  path: string;
  /** Commit SHA the file was read at. */
  sha: string;
}

export interface TasksFormatIssue {
  line: number;
  message: string;
}

export class TasksFormatError extends Error {
  override name = "TasksFormatError";
  constructor(
    readonly path: string,
    readonly issues: readonly TasksFormatIssue[],
  ) {
    super(issues.map((i) => `${path}:${i.line}: ${i.message}`).join("\n"));
  }
}

export class ImportSourceError extends Error {
  override name = "ImportSourceError";
}

const FENCE = /^\s*(```|~~~)/;
/** Any checkbox list item, well-formed or not: all of them must be tasks. */
const CHECKBOX_ITEM = /^\s*[-*+]\s*\[[ xX]?\]/;
/** A task ID in a list item without a checkbox. */
const BARE_TASK = /^\s*[-*+]\s+T\d{3,}\b/;
const TASK_LINE = /^- \[([ xX])\] (\S+)(?: (.*))?$/;
const DEPENDS_LINE = /^[ \t]+depends:(.*)$/;
const AC_LINE = /^[ \t]+AC(\d+):(.*)$/;
const INDENTED = /^[ \t]+\S/;
const COMPONENT_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const FLAG_RE = /^[a-z][a-z0-9-]*$/;
const SPEC_PATH_RE = /^specs\/([^/]+)\/tasks\.md$/;

interface Draft {
  task: Omit<TaskImport, "specRef">;
  line: number;
  dependsLine: number | null;
}

type Issue = (message: string) => void;

/** Parses the text after the task ID: ordered [..] tokens, then {..} tokens, then the title. */
function parseTokens(rest: string, issue: Issue): Omit<Draft["task"], "taskId" | "depends" | "acceptanceCriteria"> {
  const out = {
    title: "",
    userStory: null as string | null,
    parallel: false,
    requirementIds: [] as string[],
    component: null as string | null,
    complexity: null as TaskComplexity | null,
    flags: [] as string[],
  };
  let s = rest;
  // [P] (stage 0), [US#] (stage 1), [REQ-IDs] (stage 2), each at most once and in this order.
  let stage = -1;
  for (let m = /^\[([^\]]*)\]\s*/.exec(s); m; m = /^\[([^\]]*)\]\s*/.exec(s)) {
    const c = (m[1] ?? "").trim();
    s = s.slice(m[0].length);
    let tokenStage: number;
    if (c === "P") {
      tokenStage = 0;
      out.parallel = true;
    } else if (/^US\d+$/.test(c)) {
      tokenStage = 1;
      out.userStory = c;
    } else {
      tokenStage = 2;
      const ids = c.split(",").map((x) => x.trim());
      const bad = ids.filter((id) => !REQUIREMENT_ID_RE.test(id));
      if (bad.length > 0) {
        issue(`unknown token [${c}]: requirement IDs must be STK-n, SYS-n, HWR-n, CSR-n or SWR-n (bad: ${bad.join(", ")})`);
        continue;
      }
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (dup.length > 0) issue(`duplicate requirement ID ${dup.join(", ")}`);
      out.requirementIds = [...new Set(ids)];
    }
    if (tokenStage <= stage) issue(`token [${c}] out of order: expected [P] [US#] [REQ-IDs], each at most once`);
    stage = Math.max(stage, tokenStage);
  }
  for (let m = /^\{([^}]*)\}\s*/.exec(s); m; m = /^\{([^}]*)\}\s*/.exec(s)) {
    const c = (m[1] ?? "").trim();
    s = s.slice(m[0].length);
    const comp = /^comp:(.*)$/.exec(c);
    const cx = /^cx:(.*)$/.exec(c);
    if (comp) {
      const name = (comp[1] ?? "").trim();
      if (out.component !== null) issue("duplicate {comp:} token");
      else if (!COMPONENT_RE.test(name)) issue(`invalid component name "${name}"`);
      else out.component = name;
    } else if (cx) {
      const value = (cx[1] ?? "").trim();
      if (out.complexity !== null) issue("duplicate {cx:} token");
      else if (!(TASK_COMPLEXITIES as readonly string[]).includes(value)) {
        issue(`complexity must be S, M or L (got "${value}"); split larger tasks`);
      } else out.complexity = value as TaskComplexity;
    } else if (FLAG_RE.test(c)) {
      if (out.flags.includes(c)) issue(`duplicate flag {${c}}`);
      else out.flags.push(c);
    } else {
      issue(`unknown token {${c}}`);
    }
  }
  if (s.startsWith("[")) issue("[..] tokens must come before {..} tokens");
  out.title = s.trim();
  if (out.title === "") issue("missing task description");
  return out;
}

export function parseTasksMarkdown(content: string, source: TasksSource): TaskImport[] {
  const pathMatch = SPEC_PATH_RE.exec(source.path);
  const feature = pathMatch?.[1] ?? "";
  if (!pathMatch || !FEATURE_RE.test(feature)) {
    throw new ImportSourceError(`path must be specs/NNN-slug/tasks.md, got "${source.path}"`);
  }
  if (!/^[0-9a-f]{7,40}$/.test(source.sha)) throw new ImportSourceError(`invalid commit SHA "${source.sha}"`);

  const issues: TasksFormatIssue[] = [];
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  let inFence = false;

  content.split(/\r?\n/).forEach((text, idx) => {
    const line = idx + 1;
    const issue: Issue = (message) => issues.push({ line, message });

    if (FENCE.test(text)) {
      inFence = !inFence;
      current = null;
      return;
    }
    if (inFence) return;
    if (text.trim() === "") {
      current = null; // a blank line ends a task block: depends:/ACn: lines sit directly under the task
      return;
    }

    const task = TASK_LINE.exec(text);
    if (task) {
      const [, box, id = "", rest = ""] = task;
      if (!SPEC_TASK_ID_RE.test(id)) {
        issue(`invalid task ID "${id}": expected T followed by at least three digits`);
        current = null;
        return;
      }
      if (box !== " ") issue(`task ${id} is checked; planning tasks must be unchecked`);
      current = { task: { taskId: id, ...parseTokens(rest, issue), depends: [], acceptanceCriteria: [] }, line, dependsLine: null };
      drafts.push(current);
      return;
    }
    if (CHECKBOX_ITEM.test(text) || BARE_TASK.test(text)) {
      issue("malformed task line: expected `- [ ] T### [P] [US#] [REQ-IDs] {comp:..} {cx:S|M|L} {flags} description`");
      current = null;
      return;
    }

    const depends = DEPENDS_LINE.exec(text);
    const ac = AC_LINE.exec(text);
    if (depends || ac) {
      const draft: Draft | null = current;
      if (!draft) {
        issue(`${depends ? "depends:" : "AC"} line is not under a task`);
        return;
      }
      if (depends) {
        const items = (depends[1] ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "");
        if (draft.dependsLine !== null) issue(`duplicate depends: line for ${draft.task.taskId}`);
        else if (items.length === 0) issue("empty depends: line; omit it when there are no dependencies");
        else {
          const bad = items.filter((x) => !SPEC_TASK_ID_RE.test(x));
          if (bad.length > 0) issue(`invalid task ID in depends: ${bad.join(", ")}`);
          draft.task.depends = [...new Set(items)];
          draft.dependsLine = line;
        }
      } else if (ac) {
        const n = Number(ac[1]);
        const textValue = (ac[2] ?? "").trim();
        const expected = draft.task.acceptanceCriteria.length + 1;
        if (n !== expected) issue(`expected AC${expected}, got AC${n}`);
        else if (textValue === "") issue(`AC${n} has no criterion`);
        else draft.task.acceptanceCriteria.push(textValue);
      }
      return;
    }

    if (INDENTED.test(text)) {
      if (current) issue(`unexpected line under task ${current.task.taskId}: expected "depends:" or "ACn:"`);
      return;
    }
    current = null; // headings, prose and other list items end a task block
  });

  if (drafts.length === 0 && issues.length === 0) issues.push({ line: 1, message: "no tasks found" });

  const firstLine = new Map<string, number>();
  for (const d of drafts) {
    const seen = firstLine.get(d.task.taskId);
    if (seen !== undefined) issues.push({ line: d.line, message: `duplicate task ID ${d.task.taskId} (first on line ${seen})` });
    else firstLine.set(d.task.taskId, d.line);
  }
  for (const d of drafts) {
    for (const dep of d.task.depends) {
      const line = d.dependsLine ?? d.line;
      if (dep === d.task.taskId) issues.push({ line, message: `${dep} depends on itself` });
      else if (!firstLine.has(dep) && SPEC_TASK_ID_RE.test(dep)) issues.push({ line, message: `depends on unknown task ${dep}` });
    }
  }

  if (issues.length > 0) {
    throw new TasksFormatError(source.path, [...issues].sort((a, b) => a.line - b.line));
  }
  // Re-validate against the published contract; a failure here is a parser bug, not input error.
  return tasksImportFileSchema.parse(
    drafts.map((d) => ({ ...d.task, specRef: { feature, taskId: d.task.taskId, path: source.path, sha: source.sha } })),
  );
}

/** Deterministic serialisation, so re-running the importer on the same input is byte-identical. */
export function renderTasksImport(tasks: readonly TaskImport[]): string {
  return `${JSON.stringify(tasks, null, 2)}\n`;
}
