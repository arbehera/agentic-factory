import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jsonSchemas, renderJsonSchema } from "./json-schema.js";

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../json-schema");
await mkdir(outDir, { recursive: true });
for (const [file, schema] of Object.entries(jsonSchemas())) {
  await writeFile(path.join(outDir, file), renderJsonSchema(schema));
  console.log(`wrote json-schema/${file}`);
}
