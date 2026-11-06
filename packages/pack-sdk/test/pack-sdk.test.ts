import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  loadProcessPackManifest,
  loadProductProfile,
  parsePackRef,
  readProductProfile,
  readTechPack,
  routeTask,
  UnroutableTaskError,
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const profileYaml = `
apiVersion: adlc.pioneer/v1
kind: ProductProfile
metadata: { name: cam-ecu, version: 1.0.0, owner: program-lead }
spec:
  processPack: proc-pack@1.0
  components:
    - { name: ecu-firmware, pack: ind880-c@1.2, paths: [firmware/] }
    - { name: fleet-service, pack: cloud-pack@1.0.2, paths: [service/, tools/service/] }
  thresholds:
    ecu-firmware: { coverage: { statement: 90, branch: 85 } }
  hardware: true
  testTargets: { ecu-firmware: [bench-a] }
`;

function configError(fn: () => unknown): ConfigValidationError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigValidationError) return err;
    throw err;
  }
  throw new Error("expected ConfigValidationError");
}

describe("FR-PCK-001 product profile loader", () => {
  it("FR-PCK-001 loads and validates a product profile", () => {
    const p = loadProductProfile(profileYaml);
    expect(p.spec.components.map((c) => c.name)).toEqual(["ecu-firmware", "fleet-service"]);
  });

  it("FR-PCK-001 fails fast listing every issue with its field path", () => {
    const bad = profileYaml.replace("pack: ind880-c@1.2", "pack: ind880-c").replace("hardware: true", "hardware: maybe");
    const err = configError(() => loadProductProfile(bad));
    expect(err.issues.map((i) => i.path)).toEqual(["spec.components[0].pack", "spec.hardware"]);
    expect(err.message).toMatch(/^\.adlc\/product-profile\.yaml is invalid:\n {2}spec\.components\[0\]\.pack: /);
  });

  it("hard rule 10: rejects YAML aliases (expansion attacks), duplicate keys and malformed YAML", () => {
    expect(configError(() => loadProductProfile(`a: &x [1]\nb: *x\n`)).message).toMatch(/YAML:/);
    expect(configError(() => loadProductProfile(`kind: A\nkind: B\n`)).message).toMatch(/YAML:/);
    expect(configError(() => loadProductProfile(`spec: [unclosed`)).message).toMatch(/YAML:/);
  });

  it("FR-PCK-001 reads .adlc/product-profile.yaml from a product repository", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "adlc-profile-"));
    try {
      await mkdir(path.join(dir, ".adlc"));
      await writeFile(path.join(dir, ".adlc/product-profile.yaml"), profileYaml);
      expect((await readProductProfile(dir)).metadata.name).toBe("cam-ecu");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("FR-PCK-001 pack manifests", () => {
  it("FR-PCK-001 the ind880-c reference pack manifest is valid", async () => {
    const m = await readTechPack(path.join(repoRoot, "packs/tech/ind880-c"));
    expect(m).toMatchObject({ id: "ind880-c", image: { digest: null }, dodThresholds: { coverage: { statement: 90, branch: 80 }, complexity: 15 } });
  });

  describe("pack directory checks", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "adlc-pack-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("rejects a manifest whose id does not match its directory", async () => {
      const packDir = path.join(dir, "other-name");
      await mkdir(packDir);
      await writeFile(path.join(packDir, "pack.yaml"), await readFile(path.join(repoRoot, "packs/tech/ind880-c/pack.yaml")));
      await expect(readTechPack(packDir)).rejects.toThrow(/does not match directory "other-name"/);
    });
  });

  it("FR-PCK-001 loads a process pack manifest", () => {
    const m = loadProcessPackManifest(
      "id: proc-pack\nversion: 1.0.0\nprocesses: [{ id: P1, name: Req }]\ninformationItems: []\ngateMapping: { G1: [P1] }\ntemplates: []\nconstitutionArticles: []\n",
    );
    expect(m.gateMapping.G1).toEqual(["P1"]);
  });
});

describe("FR-PCK-001 task routing to the component's pack", () => {
  const profile = loadProductProfile(profileYaml);

  it("FR-PCK-001 routes by profile component name", () => {
    expect(routeTask(profile, { component: "fleet-service", paths: [] })).toMatchObject({
      name: "fleet-service",
      packRef: { id: "cloud-pack", version: "1.0.2" },
    });
  });

  it("FR-PCK-001 routes by the paths a task touches when {comp:} names a module, not a profile component", () => {
    const r = routeTask(profile, { component: "ExposureCtrl", paths: ["firmware/src/ExposureCtrl/ae.c"] });
    expect(r).toMatchObject({ name: "ecu-firmware", packRef: { id: "ind880-c", version: "1.2" } });
    expect(routeTask(profile, { component: null, paths: ["service/a.ts", "tools/service/b.ts"] }).name).toBe("fleet-service");
  });

  it("FR-PCK-001 refuses tasks that span packs, touch unowned paths, or cannot be placed", () => {
    expect(() => routeTask(profile, { component: null, paths: ["firmware/a.c", "service/b.ts"] })).toThrow(/span components ecu-firmware, fleet-service/);
    expect(() => routeTask(profile, { component: null, paths: ["docs/x.md"] })).toThrow(/not owned by any component: docs\/x\.md/);
    expect(() => routeTask(profile, { component: "ExposureCtrl", paths: [] })).toThrow(UnroutableTaskError);
    expect(() => routeTask(profile, { component: "ecu-firmware", paths: ["service/b.ts"] })).toThrow(/outside component "ecu-firmware"/);
  });

  it("parses pack refs", () => {
    expect(parsePackRef("a-b@1.2")).toEqual({ id: "a-b", version: "1.2" });
    expect(() => parsePackRef("a-b")).toThrow(UnroutableTaskError);
  });
});
