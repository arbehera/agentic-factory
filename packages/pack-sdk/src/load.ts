import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  processPackManifestSchema,
  productProfileSchema,
  techPackManifestSchema,
  type ProcessPackManifest,
  type ProductProfile,
  type TechPackManifest,
} from "@adlc/schemas";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

/**
 * FR-PCK-001: loads and validates the product profile and pack manifests. All of them are
 * untrusted input (hard rule 10): YAML aliases and duplicate keys are rejected, and the content
 * must match the strict contract. Invalid config fails fast with every issue listed.
 */

export const PRODUCT_PROFILE_PATH = ".adlc/product-profile.yaml";

export interface ConfigIssue {
  path: string;
  message: string;
}

export class ConfigValidationError extends Error {
  override name = "ConfigValidationError";
  constructor(
    readonly source: string,
    readonly issues: readonly ConfigIssue[],
  ) {
    super(`${source} is invalid:\n${issues.map((i) => `  ${i.path || "(root)"}: ${i.message}`).join("\n")}`);
  }
}

function formatPath(p: readonly PropertyKey[]): string {
  return p.reduce<string>((acc, k) => (typeof k === "number" ? `${acc}[${k}]` : acc ? `${acc}.${String(k)}` : String(k)), "");
}

/** Parses untrusted YAML (no aliases, no duplicate keys) and validates it against `schema`. */
export function loadYamlContract<S extends z.ZodType>(schema: S, text: string, source: string): z.output<S> {
  let doc: unknown;
  try {
    doc = parseYaml(text, { maxAliasCount: 0, uniqueKeys: true, merge: false, prettyErrors: true });
  } catch (err) {
    throw new ConfigValidationError(source, [{ path: "", message: `YAML: ${(err as Error).message.split("\n")[0] ?? ""}` }]);
  }
  const r = schema.safeParse(doc);
  if (!r.success) {
    throw new ConfigValidationError(
      source,
      r.error.issues.map((i) => ({ path: formatPath(i.path), message: i.message })),
    );
  }
  return r.data;
}

export function loadProductProfile(text: string, source = PRODUCT_PROFILE_PATH): ProductProfile {
  return loadYamlContract(productProfileSchema, text, source);
}

export function loadTechPackManifest(text: string, source = "pack.yaml"): TechPackManifest {
  return loadYamlContract(techPackManifestSchema, text, source);
}

export function loadProcessPackManifest(text: string, source = "pack.yaml"): ProcessPackManifest {
  return loadYamlContract(processPackManifestSchema, text, source);
}

/** Reads `.adlc/product-profile.yaml` from a product repository checkout. */
export async function readProductProfile(repoDir: string): Promise<ProductProfile> {
  const file = path.join(repoDir, PRODUCT_PROFILE_PATH);
  return loadProductProfile(await readFile(file, "utf8"), PRODUCT_PROFILE_PATH);
}

/** Reads `pack.yaml` from a pack directory and checks the directory name matches the pack id. */
export async function readTechPack(packDir: string): Promise<TechPackManifest> {
  const source = `${path.basename(packDir)}/pack.yaml`;
  const manifest = loadTechPackManifest(await readFile(path.join(packDir, "pack.yaml"), "utf8"), source);
  if (manifest.id !== path.basename(packDir)) {
    throw new ConfigValidationError(source, [{ path: "id", message: `id "${manifest.id}" does not match directory "${path.basename(packDir)}"` }]);
  }
  return manifest;
}
