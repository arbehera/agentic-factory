import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRunRepository, AuditRepository, createDb, grantAppRole, InvalidRoleNameError, WRITE_ONCE_TABLES } from "../src/index.js";
import { freshDatabase, seedProjectAndDefinition, skipIntegration, type TestDatabase } from "./helpers.js";

const svc = { kind: "service", id: "adlc-orchestrator" } as const;

describe.skipIf(skipIntegration)("P0-WP11 services run as an application role that cannot rewrite history", () => {
  let t: TestDatabase;
  let app: pg.Pool;
  const role = `adlc_app_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    t = await freshDatabase();
    await t.pool.query(`create role ${role} login password 'app-test-password'`);
    await grantAppRole(t.pool, role);
    await grantAppRole(t.pool, role); // repeatable
    const url = new URL(t.url);
    url.username = role;
    url.password = "app-test-password";
    app = new pg.Pool({ connectionString: url.toString() });
  });
  afterAll(async () => {
    await app.end();
    await t.close();
  });

  it("the role does the platform's normal work: runs, audit appends, new audit partitions", async () => {
    const db = createDb(app);
    const seed = await seedProjectAndDefinition(t.pool);
    const run = await new AgentRunRepository(db).create({ agentDefinitionId: seed.agentDefinitionId, projectId: seed.projectId, kind: "task-pipeline", taskKey: "PILOT-1" }, svc, new Date());
    await new AgentRunRepository(db).transition(run.id, "starting", svc, "container created", new Date());
    const audit = new AuditRepository(db);
    await audit.ensurePartitions(new Date("2027-03-15T00:00:00Z")); // owned by the table owner, via SECURITY DEFINER
    expect((await audit.list()).length).toBeGreaterThan(0);
    const { rows } = await t.pool.query<{ owner: string }>("select pg_get_userbyid(relowner) as owner from pg_class where relname = 'audit_event_2027_04'");
    expect(rows[0]?.owner).not.toBe(role);
  });

  it("hard rule 11: UPDATE, DELETE and TRUNCATE on every write-once table are refused by privilege", async () => {
    for (const table of WRITE_ONCE_TABLES) {
      const col = (await t.pool.query<{ c: string }>("select column_name as c from information_schema.columns where table_name = $1 order by ordinal_position limit 1", [table])).rows[0]?.c ?? "";
      await expect(app.query(`update ${table} set ${col} = ${col} where false`)).rejects.toMatchObject({ code: "42501" });
      await expect(app.query(`delete from ${table} where false`)).rejects.toMatchObject({ code: "42501" });
      await expect(app.query(`truncate ${table}`)).rejects.toMatchObject({ code: "42501" });
    }
    const [partition] = (await t.pool.query<{ name: string }>("select inhrelid::regclass::text as name from pg_inherits where inhparent = 'audit_event'::regclass limit 1")).rows;
    await expect(app.query(`delete from ${partition?.name ?? "x"} where false`)).rejects.toMatchObject({ code: "42501" });
  });

  it("the role owns nothing: it cannot drop the write-once triggers or alter tables", async () => {
    await expect(app.query('drop trigger "audit_event_no_update_delete" on audit_event')).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("alter table evidence_record disable trigger all")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("drop table lease")).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects a role name that is not a plain identifier", async () => {
    await expect(grantAppRole(t.pool, 'x"; drop table lease; --')).rejects.toBeInstanceOf(InvalidRoleNameError);
  });
});
