import { stateHash, type Actor } from "@adlc/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuditRepository,
  PackNotDispatchableError,
  PackNotFoundError,
  PackVersionConflictError,
  PackVersionRepository,
  type PackRegistration,
} from "../src/index.js";
import { freshDatabase, skipIntegration, type TestDatabase } from "./helpers.js";

const owner: Actor = { kind: "human", id: "pack-owner" };
const qms: Actor = { kind: "human", id: "qms-owner" };
const canary: Actor = { kind: "service", id: "canary-runner" };
const digest = `sha256:${"b".repeat(64)}`;

const reg = (semver: string, extra: Partial<PackRegistration> = {}): PackRegistration => ({
  packId: "tech-a",
  kind: "tech",
  semver,
  imageDigest: digest,
  ownerId: "pack-owner",
  contentHash: stateHash({ semver }),
  ...extra,
});

describe.skipIf(skipIntegration)("FR-PCK-003 pack registry (PostgreSQL 16)", () => {
  let t: TestDatabase;
  let repo: PackVersionRepository;

  beforeAll(async () => {
    t = await freshDatabase();
    repo = new PackVersionRepository(t.db);
  });
  afterAll(async () => {
    await t.close();
  });

  it("FR-PCK-001 registers a version as Draft; identical re-registration is a no-op; changed content conflicts", async () => {
    const a = await repo.register(reg("1.2.0"), owner);
    expect(a.status).toBe("Draft");
    expect((await repo.register(reg("1.2.0"), owner)).id).toBe(a.id);
    await expect(repo.register(reg("1.2.0", { contentHash: stateHash("other") }), owner)).rejects.toBeInstanceOf(PackVersionConflictError);
  });

  it("FR-PCK-003 Draft is dispatchable in the sandbox only", async () => {
    await expect(repo.resolveForDispatch("tech-a@1.2", "tech", "sandbox")).resolves.toMatchObject({ semver: "1.2.0" });
    await expect(repo.resolveForDispatch("tech-a@1.2", "tech", "production")).rejects.toThrow(/1\.2\.0=Draft/);
  });

  it("FR-PCK-003 production dispatch only on Qualified; X.Y resolves to the highest dispatchable patch", async () => {
    await repo.transition("tech-a", "1.2.0", "Qualified", [owner, qms], "golden tasks and canaries passed");
    await repo.register(reg("1.2.1"), owner); // Draft
    await expect(repo.resolveForDispatch("tech-a@1.2", "tech", "production")).resolves.toMatchObject({ semver: "1.2.0" });
    await expect(repo.resolveForDispatch("tech-a@1.2", "tech", "sandbox")).resolves.toMatchObject({ semver: "1.2.1" });
    await expect(repo.resolveForDispatch("tech-a@1.2.1", "tech", "production")).rejects.toBeInstanceOf(PackNotDispatchableError);
  });

  it("FR-PCK-003 a Restricted pack takes no new dispatch anywhere until re-qualified", async () => {
    await repo.transition("tech-a", "1.2.0", "Restricted", [canary], "canary class failed");
    await repo.transition("tech-a", "1.2.1", "Retired", [owner], "superseded");
    await expect(repo.resolveForDispatch("tech-a@1.2", "tech", "production")).rejects.toThrow(/1\.2\.0=Restricted, 1\.2\.1=Retired/);
    await expect(repo.resolveForDispatch("tech-a@1.2", "tech", "sandbox")).rejects.toBeInstanceOf(PackNotDispatchableError);
    await repo.transition("tech-a", "1.2.0", "Qualified", [owner, qms], "re-qualified");
    await expect(repo.resolveForDispatch("tech-a@1.2.0", "tech", "production")).resolves.toMatchObject({ status: "Qualified" });
  });

  it("FR-PCK-003 rejects qualification without a digest or with one approver, and leaves no trace when rejected", async () => {
    await repo.register(reg("2.0.0", { imageDigest: null }), owner);
    const before = (await new AuditRepository(t.db).list()).length;
    await expect(repo.transition("tech-a", "2.0.0", "Qualified", [owner, qms], "x")).rejects.toThrow(/digest/);
    await repo.register(reg("2.1.0"), owner);
    await expect(repo.transition("tech-a", "2.1.0", "Qualified", [owner], "x")).rejects.toThrow(/2 distinct human/);
    expect((await new AuditRepository(t.db).list()).length).toBe(before + 1); // only the 2.1.0 registration
    await expect(repo.transition("ghost", "1.0.0", "Retired", [owner], "x")).rejects.toBeInstanceOf(PackNotFoundError);
  });

  it("hard rule 11: every registration and status change is audited with approvers, and the chain verifies", async () => {
    const audit = new AuditRepository(t.db);
    const events = (await audit.list()).filter((e) => e.target === "pack:tech-a@1.2.0");
    expect(events.map((e) => e.action)).toEqual(["pack.register", "pack.status", "pack.status", "pack.status"]);
    expect(events[1]?.reason).toBe("Draft -> Qualified: golden tasks and canaries passed (by human:pack-owner, human:qms-owner)");
    expect(events[1]?.beforeHash).toBe(events[0]?.afterHash);
    expect(await audit.verify()).toMatchObject({ ok: true });
  });

  it("rejects malformed refs and refs of the wrong kind", async () => {
    await expect(repo.resolveForDispatch("tech-a", "tech", "sandbox")).rejects.toThrow(/invalid pack ref/);
    await expect(repo.resolveForDispatch("tech-a@1.2", "process", "sandbox")).rejects.toThrow(/no process pack matches/);
  });
});
