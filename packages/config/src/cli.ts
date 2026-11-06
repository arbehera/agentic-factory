import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkNeutrality, NeutralityConfigError } from "./neutrality.js";

// Usage: tsx packages/config/src/cli.ts [repoRoot]   (default: the repo containing this file)
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const repoRoot = path.resolve(process.argv[2] ?? defaultRoot);

try {
  const findings = await checkNeutrality(repoRoot);
  if (findings.length === 0) {
    console.log("core-neutrality check passed (FR-PCK-005)");
  } else {
    for (const f of findings) console.error(`${f.file}:${f.line}:${f.column}  denied term "${f.term}"`);
    console.error(`core-neutrality check FAILED: ${findings.length} finding(s) (FR-PCK-005)`);
    process.exitCode = 1;
  }
} catch (err) {
  if (err instanceof NeutralityConfigError) {
    console.error(`core-neutrality check could not run: ${err.message}`);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
