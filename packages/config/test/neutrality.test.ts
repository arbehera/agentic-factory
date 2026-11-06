import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWLIST_PATH,
  checkNeutrality,
  compileTerms,
  DENYLIST_PATH,
  NeutralityConfigError,
  parseListFile,
  scanText,
} from "../src/neutrality.js";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pkgDir, "../..");
const run = promisify(execFile);

async function write(root: string, rel: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content);
}

describe("FR-PCK-005 core-neutrality check", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "adlc-neutrality-"));
    for (const rel of [DENYLIST_PATH, ALLOWLIST_PATH]) {
      await mkdir(path.dirname(path.join(tmp, rel)), { recursive: true });
      await copyFile(path.join(repoRoot, rel), path.join(tmp, rel));
    }
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("AT-P0-07 fails on a seeded vendor/tool string in packages/", async () => {
    await write(tmp, "packages/domain/src/build.ts", 'export const cc = "arm-none-eabi-gcc";\n');
    const findings = await checkNeutrality(tmp);
    expect(findings.map((f) => f.term).sort()).toEqual(["arm-none-eabi", "gcc"]);
    expect(findings[0]).toMatchObject({ file: "packages/domain/src/build.ts", line: 1 });
  });

  it("AT-P0-07 CLI exits non-zero and reports file:line on a seeded string", async () => {
    await write(tmp, "packages/x/src/a.ts", "// line 1\n// uses FreeRTOS\n");
    const cli = path.join(pkgDir, "src/cli.ts");
    const err = await run(process.execPath, ["--import", "tsx", cli, tmp], { cwd: pkgDir }).then(
      () => null,
      (e: unknown) => e as { code: number; stderr: string },
    );
    expect(err?.code).toBe(1);
    expect(err?.stderr).toContain('packages/x/src/a.ts:2:9  denied term "freertos"');
  });

  it("FR-PCK-005 scans apps/ as well as packages/", async () => {
    await write(tmp, "apps/orchestrator/src/x.ts", "const t = 'Zephyr';\n");
    expect(await checkNeutrality(tmp)).toHaveLength(1);
  });

  it("FR-PCK-005 passes on neutral code and ignores paths outside apps/ and packages/", async () => {
    await write(tmp, "packages/domain/src/ok.ts", "export const ok = 'docker jira github';\n");
    await write(tmp, "packs/tech/some-pack/pack.yaml", "toolchain: gcc\n");
    expect(await checkNeutrality(tmp)).toEqual([]);
  });

  it("FR-PCK-005 exempts allow-listed test files and fixtures, but not other files", async () => {
    await write(tmp, "packages/a/test/x.test.ts", "'misra'\n");
    await write(tmp, "packages/a/test/fixtures/sample.c", "/* misra */\n");
    await write(tmp, "packages/a/test/helper.ts", "'misra'\n");
    const findings = await checkNeutrality(tmp);
    expect(findings.map((f) => f.file)).toEqual(["packages/a/test/helper.ts"]);
  });

  it("FR-PCK-005 skips build output, dependencies and binary files", async () => {
    await write(tmp, "packages/a/dist/x.js", "gcc\n");
    await write(tmp, "apps/a/dist-bundle/agent.mjs", "gcc\n");
    await write(tmp, "packages/a/node_modules/m/x.js", "gcc\n");
    await write(tmp, "packages/a/src/blob.bin", Buffer.from([0x67, 0x63, 0x63, 0x00]));
    expect(await checkNeutrality(tmp)).toEqual([]);
  });

  it("FR-PCK-005 fails fast when the deny-list is missing or empty", async () => {
    await writeFile(path.join(tmp, DENYLIST_PATH), "# only comments\n");
    await expect(checkNeutrality(tmp)).rejects.toBeInstanceOf(NeutralityConfigError);
    await rm(path.join(tmp, DENYLIST_PATH));
    await expect(checkNeutrality(tmp)).rejects.toThrow(/cannot read/);
  });

  it("FR-PCK-005 the repository itself passes the check", async () => {
    expect(await checkNeutrality(repoRoot)).toEqual([]);
  });
});

describe("FR-PCK-005 term matching", () => {
  const m = compileTerms(["gcc", "helix qac", "pc-lint"]);

  it("matches whole tokens case-insensitively, with any whitespace inside multi-word terms", () => {
    expect(scanText("f", "GCC; Helix   QAC; (pc-lint)", m).map((f) => f.term)).toEqual([
      "gcc",
      "helix qac",
      "pc-lint",
    ]);
  });

  it("does not match inside longer identifiers", () => {
    expect(scanText("f", "libgccx gcc2 xpc-lint", m)).toEqual([]);
  });

  it("reports 1-based line and column", () => {
    expect(scanText("f", "a\r\n  gcc", m)[0]).toMatchObject({ line: 2, column: 3 });
  });

  it("parses list files, dropping comments and blanks", () => {
    expect(parseListFile("# c\n\n a \nb # trailing\n")).toEqual(["a", "b"]);
  });
});
