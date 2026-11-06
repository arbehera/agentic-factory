import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(pkgDir, "src/cli.ts");

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function invoke(args: string[]): Promise<Outcome> {
  try {
    const r = await run(process.execPath, ["--import", "tsx", cli, ...args], { cwd: pkgDir });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return e as Outcome;
  }
}

describe("FR-IMP-001 importer CLI", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "adlc-import-"));
    await mkdir(path.join(repo, "specs/003-x"), { recursive: true });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("writes tasks.import.json next to tasks.md, byte-identical on re-run", async () => {
    await writeFile(path.join(repo, "specs/003-x/tasks.md"), "- [ ] T001 {cx:S} A\n");
    const args = ["specs/003-x/tasks.md", "--sha", "abcdef1", "--repo-root", repo];
    expect((await invoke(args)).code).toBe(0);
    const out = path.join(repo, "specs/003-x/tasks.import.json");
    const first = await readFile(out, "utf8");
    expect(JSON.parse(first)).toMatchObject([{ taskId: "T001", specRef: { path: "specs/003-x/tasks.md", sha: "abcdef1" } }]);
    await invoke(args);
    expect(await readFile(out, "utf8")).toBe(first);
  });

  it("AT-P0-08 exits 1 and prints path:line for malformed input; exits 2 on usage errors", async () => {
    await writeFile(path.join(repo, "specs/003-x/tasks.md"), "ok\n- T001 A\n");
    const bad = await invoke(["specs/003-x/tasks.md", "--sha", "abcdef1", "--repo-root", repo]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("specs/003-x/tasks.md:2: malformed task line");
    expect((await invoke(["specs/003-x/tasks.md"])).code).toBe(2);
    expect((await invoke(["specs/003-x/tasks.md", "--sha", "nothex", "--repo-root", repo])).code).toBe(2);
  });
});
