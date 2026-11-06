// Bundles the agent runtime into one ESM file for the agent image (no node_modules in the image).
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist-bundle/agent.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Some dependencies are CommonJS and call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __adlcCreateRequire } from 'node:module'; const require = __adlcCreateRequire(import.meta.url);" },
  legalComments: "linked",
  metafile: false,
  logLevel: "warning",
});
// Guard: the agent image must never carry a container-engine client (hard rule 6).
const { readFile } = await import("node:fs/promises");
const text = await readFile("dist-bundle/agent.mjs", "utf8");
for (const banned of ["dockerode", "docker-modem", "ssh2"]) {
  if (text.includes(`node_modules/${banned}/`) || text.includes(`/${banned}@`)) {
    console.error(`bundle contains ${banned}; the agent runtime must not include a Docker client`);
    process.exit(1);
  }
}
console.log("wrote dist-bundle/agent.mjs");
