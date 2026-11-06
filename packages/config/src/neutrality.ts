import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";

/** FR-PCK-005: core-neutrality check over `apps/` and `packages/`. */

export const SCAN_ROOTS = ["apps", "packages"] as const;
export const DENYLIST_PATH = "packages/config/neutrality-denylist.txt";
export const ALLOWLIST_PATH = "packages/config/neutrality-allowlist.txt";

const SKIPPED_DIRS = new Set(["node_modules", "dist", "dist-bundle", "coverage", ".turbo"]);

export interface NeutralityFinding {
  /** Repo-relative path with forward slashes. */
  file: string;
  line: number;
  column: number;
  term: string;
}

export class NeutralityConfigError extends Error {
  override name = "NeutralityConfigError";
}

/** Parses a list file: one entry per line, `#` starts a comment, blank lines ignored. */
export function parseListFile(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter((l) => l.length > 0);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds one case-insensitive matcher per term. A term matches only as a whole token:
 * the characters around it must not be letters or digits, so `foo` does not match `libfoox`.
 * Inner whitespace in a term matches any run of whitespace.
 */
export function compileTerms(terms: readonly string[]): { term: string; re: RegExp }[] {
  return terms.map((term) => {
    const body = term.split(/\s+/).map(escapeRegExp).join("\\s+");
    return { term, re: new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, "gi") };
  });
}

export function scanText(
  file: string,
  text: string,
  matchers: readonly { term: string; re: RegExp }[],
): NeutralityFinding[] {
  const findings: NeutralityFinding[] = [];
  text.split(/\r?\n/).forEach((lineText, idx) => {
    for (const { term, re } of matchers) {
      re.lastIndex = 0;
      for (const m of lineText.matchAll(re)) {
        findings.push({ file, line: idx + 1, column: m.index + 1, term });
      }
    }
  });
  return findings;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIPPED_DIRS.has(e.name)) yield* walk(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

export async function checkNeutrality(repoRoot: string): Promise<NeutralityFinding[]> {
  const readList = async (rel: string): Promise<string[]> => {
    try {
      return parseListFile(await readFile(path.join(repoRoot, rel), "utf8"));
    } catch (err) {
      throw new NeutralityConfigError(`cannot read ${rel}: ${(err as Error).message}`);
    }
  };
  const terms = await readList(DENYLIST_PATH);
  if (terms.length === 0) throw new NeutralityConfigError(`${DENYLIST_PATH} has no terms`);
  const allow = picomatch(await readList(ALLOWLIST_PATH), { dot: true });
  const matchers = compileTerms(terms);

  const findings: NeutralityFinding[] = [];
  for (const root of SCAN_ROOTS) {
    for await (const full of walk(path.join(repoRoot, root))) {
      const rel = path.relative(repoRoot, full).split(path.sep).join("/");
      if (rel === DENYLIST_PATH || rel === ALLOWLIST_PATH || allow(rel)) continue;
      const buf = await readFile(full);
      if (isBinary(buf)) continue;
      findings.push(...scanText(rel, buf.toString("utf8"), matchers));
    }
  }
  return findings;
}
