import { verifyAuditExport } from "@adlc/control-plane";
import { InMemoryObjectStore } from "@adlc/testing";
import { afterEach, describe, expect, it } from "vitest";
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
