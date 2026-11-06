import { GATE_IDS } from "@adlc/domain";
import { z } from "zod";

/**
 * Pack and product-profile contracts (spec.md §6, SDD §5.3–§5.5, FR-PCK-001). All of these
 * files come from repositories and are untrusted input: validated strictly, unknown keys rejected.
 */

const kebab = z.string().regex(/^[a-z][a-z0-9-]*$/, "expected lower-case kebab-case");
export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/, "expected MAJOR.MINOR.PATCH");
/** `id@MAJOR.MINOR[.PATCH]`; MAJOR.MINOR resolves to the highest dispatchable patch (ADR-0008). */
export const packRefSchema = z.string().regex(/^[a-z][a-z0-9-]*@\d+\.\d+(\.\d+)?$/, "expected <pack-id>@<MAJOR.MINOR[.PATCH]>");
/** Repo-relative directory prefix such as `firmware/` (no leading slash, no `..`). */
const repoDirSchema = z
  .string()
  .regex(/^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._/-]+\/$/, "expected a repo-relative directory ending in /");
/** File inside the pack directory (no leading slash, no `..`). */
const packFileSchema = z
  .string()
  .regex(/^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._/-]+$/, "expected a path inside the pack");
const percent = z.number().min(0).max(100);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const dodThresholdsSchema = z.strictObject({
  coverage: z.strictObject({ statement: percent, branch: percent }),
  complexity: z.number().int().positive().optional(),
});

/** Profile overrides may set any subset; tighten-only is enforced with the gate floor (FR-PCK-002). */
export const thresholdOverrideSchema = z.strictObject({
  coverage: z.strictObject({ statement: percent.optional(), branch: percent.optional() }).optional(),
  complexity: z.number().int().positive().optional(),
});

export const productProfileSchema = z
  .strictObject({
    apiVersion: z.literal("adlc.pioneer/v1"),
    kind: z.literal("ProductProfile"),
    metadata: z.strictObject({ name: kebab, version: semverSchema, owner: z.string().min(1) }),
    spec: z.strictObject({
      processPack: packRefSchema,
      components: z
        .array(z.strictObject({ name: kebab, pack: packRefSchema, paths: z.array(repoDirSchema).min(1) }))
        .min(1),
      thresholds: z.record(kebab, thresholdOverrideSchema).default({}),
      hardware: z.boolean(),
      testTargets: z.record(kebab, z.array(kebab)).default({}),
    }),
  })
  .superRefine((p, ctx) => {
    const names = p.spec.components.map((c) => c.name);
    names.forEach((n, i) => {
      if (names.indexOf(n) !== i) ctx.addIssue({ code: "custom", path: ["spec", "components", i, "name"], message: `duplicate component "${n}"` });
    });
    for (const key of ["thresholds", "testTargets"] as const) {
      for (const k of Object.keys(p.spec[key])) {
        if (!names.includes(k)) ctx.addIssue({ code: "custom", path: ["spec", key, k], message: `unknown component "${k}"` });
      }
    }
    // Routing by path must be unambiguous: no path may be a prefix of another (SDD §5.5).
    const all = p.spec.components.flatMap((c, ci) => c.paths.map((path, pi) => ({ path, ci, pi, name: c.name })));
    all.forEach((a, i) => {
      for (const b of all.slice(i + 1)) {
        if (a.path.startsWith(b.path) || b.path.startsWith(a.path)) {
          ctx.addIssue({
            code: "custom",
            path: ["spec", "components", b.ci, "paths", b.pi],
            message: `path "${b.path}" (${b.name}) overlaps "${a.path}" (${a.name})`,
          });
        }
      }
    });
  });
export type ProductProfile = z.infer<typeof productProfileSchema>;
export type ProfileComponent = ProductProfile["spec"]["components"][number];

export const techPackManifestSchema = z.strictObject({
  id: kebab,
  version: semverSchema,
  languages: z.array(z.string().min(1)).min(1),
  codingStandard: z.string().min(1),
  /** Toolchain image; `digest` is required before the pack can be Qualified (hard rule 6). */
  image: z.strictObject({ name: z.string().regex(/^[a-z0-9./_-]+$/), digest: digestSchema.nullable() }),
  adapters: z.strictObject({ build: packFileSchema, analysis: packFileSchema, testTarget: packFileSchema, release: packFileSchema }),
  budgetSchema: z.strictObject({
    fields: z.array(z.strictObject({ name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/), unit: z.string().min(1), automated: z.boolean() })).min(1),
  }),
  dodThresholds: dodThresholdsSchema,
  humanLedCategories: z.array(z.string().min(1)).min(1),
  humanExecutedVerification: z.array(z.string().min(1)).min(1),
  templateFragments: z.array(packFileSchema).min(1),
  skills: z.array(packFileSchema).min(1),
  evals: z.strictObject({ goldenTasks: packFileSchema, canaryCorpus: packFileSchema }),
});
export type TechPackManifest = z.infer<typeof techPackManifestSchema>;

export const processPackManifestSchema = z
  .strictObject({
    id: kebab,
    version: semverSchema,
    processes: z.array(z.strictObject({ id: z.string().min(1), name: z.string().min(1) })).min(1),
    informationItems: z.array(z.strictObject({ id: z.string().min(1), name: z.string().min(1) })),
    gateMapping: z.partialRecord(z.enum(GATE_IDS), z.array(z.string().min(1))),
    templates: z.array(packFileSchema),
    constitutionArticles: z.array(packFileSchema),
  })
  .superRefine((p, ctx) => {
    const ids = new Set(p.processes.map((x) => x.id));
    for (const [gate, procs] of Object.entries(p.gateMapping)) {
      for (const id of procs) {
        if (!ids.has(id)) ctx.addIssue({ code: "custom", path: ["gateMapping", gate], message: `unknown process "${id}"` });
      }
    }
  });
export type ProcessPackManifest = z.infer<typeof processPackManifestSchema>;
