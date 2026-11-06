import { describe, expect, it } from "vitest";
import { ImportSourceError, parseTasksMarkdown, TasksFormatError, type TasksFormatIssue } from "../src/index.js";

const src = { path: "specs/005-demo/tasks.md", sha: "abc1234" };

function issues(md: string): TasksFormatIssue[] {
  try {
    parseTasksMarkdown(md, src);
  } catch (err) {
    if (err instanceof TasksFormatError) return [...err.issues];
    throw err;
  }
  throw new Error("expected a TasksFormatError");
}

describe("FR-IMP-001 tasks.md parsing", () => {
  it("parses all Pioneer tokens, depends and AC lines", () => {
    const tasks = parseTasksMarkdown(
      [
        "- [ ] T001 {cx:S} Base",
        "- [ ] T014 [P] [US2] [SWR-233, SWR-234] {comp:Ctrl} {cx:M} {hil} {security} Do the thing [with brackets]",
        "      depends: T001",
        "      AC1: first",
        "\tAC2:   second  ",
      ].join("\n"),
      src,
    );
    expect(tasks[1]).toEqual({
      taskId: "T014",
      title: "Do the thing [with brackets]",
      userStory: "US2",
      parallel: true,
      requirementIds: ["SWR-233", "SWR-234"],
      component: "Ctrl",
      complexity: "M",
      flags: ["hil", "security"],
      depends: ["T001"],
      acceptanceCriteria: ["first", "second"],
      specRef: { feature: "005-demo", taskId: "T014", path: "specs/005-demo/tasks.md", sha: "abc1234" },
    });
  });

  it("yields null/[] for absent Pioneer tokens (DoR judges readiness) and accepts CRLF", () => {
    const [t] = parseTasksMarkdown("# Tasks\r\n\r\n- [ ] T001 Create project structure\r\n", src);
    expect(t).toMatchObject({
      userStory: null,
      parallel: false,
      requirementIds: [],
      component: null,
      complexity: null,
      flags: [],
      depends: [],
    });
  });
});

describe("AT-P0-08 malformed input is rejected with line numbers", () => {
  const cases: [string, string, number, RegExp][] = [
    ["missing checkbox", "intro\n- T001 Do it", 2, /malformed task line/],
    ["broken checkbox", "- [] T001 Do it", 1, /malformed task line/],
    ["no task ID", "- [ ] Do it without an ID", 1, /invalid task ID "Do"/],
    ["short task ID", "- [ ] T01 Do it", 1, /invalid task ID "T01"/],
    ["checked task", "- [x] T001 Done already", 1, /checked/],
    ["Spec Kit FR ID", "- [ ] T001 [FR-001] Do it", 1, /requirement IDs must be/],
    ["unknown brace token", "- [ ] T001 {owner:me} Do it", 1, /unknown token \{owner:me\}/],
    ["XL complexity", "- [ ] T001 {cx:XL} Do it", 1, /complexity must be S, M or L/],
    ["bad component", "- [ ] T001 {comp:1bad} Do it", 1, /invalid component name/],
    ["duplicate comp", "- [ ] T001 {comp:A} {comp:B} Do it", 1, /duplicate \{comp:\}/],
    ["duplicate cx", "- [ ] T001 {cx:S} {cx:M} Do it", 1, /duplicate \{cx:\}/],
    ["duplicate flag", "- [ ] T001 {hil} {hil} Do it", 1, /duplicate flag/],
    ["token order", "- [ ] T001 [US1] [P] Do it", 1, /out of order/],
    ["bracket after brace", "- [ ] T001 {cx:S} [P] Do it", 1, /must come before/],
    ["duplicate requirement", "- [ ] T001 [SWR-1,SWR-1] Do it", 1, /duplicate requirement ID SWR-1/],
    ["missing description", "- [ ] T001 [P] {cx:S}", 1, /missing task description/],
    ["orphan depends", "## Phase\n  depends: T001", 2, /not under a task/],
    ["depends after blank line", "- [ ] T001 A\n- [ ] T002 B\n\n  depends: T001", 4, /not under a task/],
    ["orphan AC", "  AC1: x", 1, /AC line is not under a task/],
    ["AC numbering", "- [ ] T001 A\n  AC2: skipped one", 2, /expected AC1, got AC2/],
    ["empty AC", "- [ ] T001 A\n  AC1:   ", 2, /AC1 has no criterion/],
    ["empty depends", "- [ ] T001 A\n  depends:", 2, /empty depends/],
    ["bad depends ID", "- [ ] T001 A\n  depends: T1, X", 2, /invalid task ID in depends: T1, X/],
    ["duplicate depends", "- [ ] T001 A\n- [ ] T002 B\n  depends: T001\n  depends: T001", 4, /duplicate depends/],
    ["unexpected indented line", "- [ ] T001 A\n  note: hello", 2, /unexpected line under task T001/],
    ["nested checkbox", "- [ ] T001 A\n  - [ ] sub-step", 2, /malformed task line/],
    ["duplicate task ID", "- [ ] T001 A\n- [ ] T001 B", 2, /duplicate task ID T001 \(first on line 1\)/],
    ["unknown dependency", "- [ ] T001 A\n  depends: T404", 2, /unknown task T404/],
    ["self dependency", "- [ ] T001 A\n  depends: T001", 2, /depends on itself/],
    ["no tasks", "# Tasks\n\nNothing yet.", 1, /no tasks found/],
  ];

  it.each(cases)("AT-P0-08 %s", (_name, md, line, message) => {
    const found = issues(md);
    expect(
      found.some((i) => i.line === line && message.test(i.message)),
      JSON.stringify(found),
    ).toBe(true);
  });

  it("AT-P0-08 reports every issue in the file, sorted by line, formatted as path:line", () => {
    const err: unknown = (() => {
      try {
        parseTasksMarkdown("- [ ] T001 {cx:XL} A\nok\n- T002 B\n- [ ] T003 {foo:1} C", src);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(TasksFormatError);
    const e = err as TasksFormatError;
    expect(e.issues.map((i) => i.line)).toEqual([1, 3, 4]);
    expect(e.message.split("\n")[0]).toMatch(/^specs\/005-demo\/tasks\.md:1: complexity/);
  });

  it("ignores task-shaped lines in fenced code blocks and Spec Kit notes", () => {
    const md = "- [ ] T001 A\n```\n- [ ] broken inside fence\n```\n## Notes\n- [P] tasks = different files\n- **[P]**: parallel";
    expect(parseTasksMarkdown(md, src).map((t) => t.taskId)).toEqual(["T001"]);
  });

  it("rejects a source path outside specs/NNN-slug/tasks.md or a non-hex SHA", () => {
    expect(() => parseTasksMarkdown("- [ ] T001 A", { ...src, path: "tasks.md" })).toThrow(ImportSourceError);
    expect(() => parseTasksMarkdown("- [ ] T001 A", { ...src, path: "specs/demo/tasks.md" })).toThrow(ImportSourceError);
    expect(() => parseTasksMarkdown("- [ ] T001 A", { ...src, sha: "main" })).toThrow(/invalid commit SHA/);
  });
});
