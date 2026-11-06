import { describe, expect, it } from "vitest";
import { processPackManifestSchema, productProfileSchema, techPackManifestSchema } from "../src/index.js";

export const profile = {
  apiVersion: "adlc.pioneer/v1",
  kind: "ProductProfile",
  metadata: { name: "demo-product", version: "1.0.0", owner: "program-lead" },
  spec: {
    processPack: "proc-pack@1.0",
    components: [
      { name: "firmware", pack: "tech-a@1.2", paths: ["firmware/"] },
      { name: "service", pack: "tech-b@1.0.3", paths: ["service/", "tools/service/"] },
    ],
    thresholds: { firmware: { coverage: { statement: 90, branch: 85 } } },
    hardware: true,
    testTargets: { firmware: ["bench-a"] },
  },
};

const techPack = {
  id: "tech-a",
  version: "1.2.0",
  languages: ["lang-x"],
  codingStandard: "standard-x",
  image: { name: "registry.local/adlc/tech-a", digest: null },
  adapters: { build: "adapters/build.ts", analysis: "adapters/analysis.ts", testTarget: "adapters/target.ts", release: "adapters/release.ts" },
  budgetSchema: { fields: [{ name: "stackBytes", unit: "bytes", automated: true }] },
  dodThresholds: { coverage: { statement: 90, branch: 80 }, complexity: 15 },
  humanLedCategories: ["boot"],
  humanExecutedVerification: ["environmental"],
  templateFragments: ["fragments/plan-budgets.md"],
  skills: ["skills/idioms.md"],
  evals: { goldenTasks: "evals/golden/", canaryCorpus: "evals/canaries/" },
};

const issueMessages = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  (r.error?.issues ?? []).map((i) => i.message).join("\n");

describe("FR-PCK-001 product profile contract", () => {
  it("FR-PCK-001 accepts a valid multi-component profile, defaulting optional maps", () => {
    expect(productProfileSchema.parse(profile).spec.components).toHaveLength(2);
    const minimal = { ...profile, spec: { ...profile.spec, thresholds: undefined, testTargets: undefined } };
    expect(productProfileSchema.parse(minimal).spec).toMatchObject({ thresholds: {}, testTargets: {} });
  });

  it("FR-PCK-001 rejects duplicate components and unknown component keys", () => {
    const dup = { ...profile, spec: { ...profile.spec, components: [profile.spec.components[0], { ...profile.spec.components[0], paths: ["other/"] }] } };
    expect(issueMessages(productProfileSchema.safeParse(dup))).toMatch(/duplicate component "firmware"/);
    const unknown = { ...profile, spec: { ...profile.spec, testTargets: { ghost: ["x"] } } };
    expect(issueMessages(productProfileSchema.safeParse(unknown))).toMatch(/unknown component "ghost"/);
  });

  it("FR-PCK-001 rejects overlapping component paths (routing must be unambiguous)", () => {
    const overlap = {
      ...profile,
      spec: { ...profile.spec, components: [profile.spec.components[0], { name: "nested", pack: "tech-b@1.0", paths: ["firmware/drivers/"] }], thresholds: {}, testTargets: {} },
    };
    expect(issueMessages(productProfileSchema.safeParse(overlap))).toMatch(/"firmware\/drivers\/" \(nested\) overlaps "firmware\/" \(firmware\)/);
  });

  it("FR-PCK-001 rejects bad pack refs, unsafe paths, wrong apiVersion and unknown keys", () => {
    const bad = (spec: object) => productProfileSchema.safeParse({ ...profile, spec: { ...profile.spec, ...spec } }).success;
    expect(bad({ processPack: "proc-pack" })).toBe(false);
    expect(bad({ components: [{ name: "a", pack: "x@1", paths: ["a/"] }] })).toBe(false);
    expect(bad({ components: [{ name: "a", pack: "x@1.0", paths: ["../a/"] }] })).toBe(false);
    expect(bad({ components: [{ name: "a", pack: "x@1.0", paths: ["/abs/"] }] })).toBe(false);
    expect(bad({ components: [{ name: "a", pack: "x@1.0", paths: ["no-slash"] }] })).toBe(false);
    expect(bad({ extra: true })).toBe(false);
    expect(productProfileSchema.safeParse({ ...profile, apiVersion: "v2" }).success).toBe(false);
  });
});

describe("FR-PCK-001 pack manifest contracts", () => {
  it("FR-PCK-001 accepts a complete technology pack manifest", () => {
    expect(techPackManifestSchema.parse(techPack).id).toBe("tech-a");
  });

  it("FR-PCK-001 every mandatory element must be present and non-empty (SDD §5.3)", () => {
    for (const key of ["humanLedCategories", "humanExecutedVerification", "templateFragments", "skills", "languages"] as const) {
      expect(techPackManifestSchema.safeParse({ ...techPack, [key]: [] }).success, key).toBe(false);
    }
    expect(techPackManifestSchema.safeParse({ ...techPack, budgetSchema: { fields: [] } }).success).toBe(false);
    const noAdapters: Record<string, unknown> = { ...techPack };
    delete noAdapters.adapters;
    expect(techPackManifestSchema.safeParse(noAdapters).success).toBe(false);
  });

  it("rejects a tag instead of a digest, adapters outside the pack, and coverage above 100", () => {
    expect(techPackManifestSchema.safeParse({ ...techPack, image: { name: techPack.image.name, digest: "latest" } }).success).toBe(false);
    expect(techPackManifestSchema.safeParse({ ...techPack, adapters: { ...techPack.adapters, build: "../core/x.ts" } }).success).toBe(false);
    expect(techPackManifestSchema.safeParse({ ...techPack, dodThresholds: { coverage: { statement: 101, branch: 80 } } }).success).toBe(false);
  });

  it("FR-PCK-001 process pack gate mapping must reference declared processes", () => {
    const proc = {
      id: "proc-pack",
      version: "1.0.0",
      processes: [{ id: "P1", name: "Requirements" }],
      informationItems: [{ id: "I1", name: "Spec" }],
      gateMapping: { G1: ["P1"] },
      templates: ["templates/spec.md"],
      constitutionArticles: ["constitution/a1.md"],
    };
    expect(processPackManifestSchema.parse(proc).id).toBe("proc-pack");
    expect(issueMessages(processPackManifestSchema.safeParse({ ...proc, gateMapping: { G1: ["P9"] } }))).toMatch(/unknown process "P9"/);
    expect(processPackManifestSchema.safeParse({ ...proc, gateMapping: { G9: ["P1"] } }).success).toBe(false);
  });
});
