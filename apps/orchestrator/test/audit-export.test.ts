import { verifyAuditExport } from "@adlc/control-plane";
import { InMemoryObjectStore } from "@adlc/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { connectObjectStore, ObjectStoreConfigError } from "../src/object-store.js";
import { harness, skipIntegration, type Harness } from "./helpers.js";

describe("NFR-006 write-once export configuration", () => {
  it("NFR-006 an object store needs an explicit retention (an ISMS decision, no default)", () => {
    const base = { DATABASE_URL: "postgres://h/d", OBJECT_STORE_ENDPOINT: "http://store:8333" };
    expect(() => loadConfig(base)).toThrow(/AUDIT_EXPORT_RETENTION_DAYS/);
    expect(loadConfig({ ...base, AUDIT_EXPORT_RETENTION_DAYS: "7" })).toMatchObject({ AUDIT_EXPORT_RETENTION_DAYS: 7, AUDIT_EXPORT_EVERY_MS: 86_400_000 });
    expect(loadConfig({ DATABASE_URL: "postgres://h/d" }).OBJECT_STORE_ENDPOINT).toBeUndefined();
  });

  it("NFR-006 incomplete store credentials are refused before any request", async () => {
    await expect(connectObjectStore({ OBJECT_STORE_ENDPOINT: "http://store:8333", OBJECT_STORE_BUCKET: "adlc-audit" })).rejects.toBeInstanceOf(ObjectStoreConfigError);
  });

  it("NFR-006 the export refuses a bucket without Object Lock; provisioning may skip the check", async () => {
    const env = { OBJECT_STORE_ENDPOINT: "http://store:8333", OBJECT_STORE_BUCKET: "adlc-audit", OBJECT_STORE_ACCESS_KEY_ID: "exporter", OBJECT_STORE_SECRET_ACCESS_KEY: "s".repeat(32) };
    const lock = (enabled: boolean) => vi.fn(() => Promise.resolve(new Response(`<ObjectLockConfiguration><ObjectLockEnabled>${enabled ? "Enabled" : "Disabled"}</ObjectLockEnabled></ObjectLockConfiguration>`)));
    try {
      vi.stubGlobal("fetch", lock(false));
      await expect(connectObjectStore(env)).rejects.toThrow(/no Object Lock; refusing a write-once export/);
      const unchecked = lock(false);
      vi.stubGlobal("fetch", unchecked);
      await expect(connectObjectStore(env, { requireLock: false })).resolves.toBeDefined();
      expect(unchecked).not.toHaveBeenCalled();
      vi.stubGlobal("fetch", lock(true));
      await expect(connectObjectStore(env)).resolves.toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe.skipIf(skipIntegration)("NFR-006 the leader runs the export", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("NFR-006 with an object store the orchestrator exports the chain; without one there is no exporter", async () => {
    const store = new InMemoryObjectStore();
    const t = await harness({ OBJECT_STORE_ENDPOINT: "http://store:8333", AUDIT_EXPORT_RETENTION_DAYS: "7" }, undefined, undefined, { objectStore: store });
    h = t;
    await t.orch.killSwitch.engage({ kind: "human", id: "lead" }, "drill"); // any audited change
    expect(await t.orch.auditExporter?.exportIfDue()).toMatchObject({ index: 1 });
    expect((await verifyAuditExport(t.orch.db, store)).findings).toEqual([]);
    const plain = await harness();
    expect(plain.orch.auditExporter).toBeNull();
    await plain.close();
  });
});
