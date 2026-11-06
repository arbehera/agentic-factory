import { ObjectStoreError } from "@adlc/adapters";
import { verifyAuditExport } from "@adlc/control-plane";
import { createDb, createPool } from "@adlc/db";
import { z } from "zod";
import { connectObjectStore } from "./object-store.js";

/**
 * Write-once export tooling (NFR-006, ADR-0015):
 *   verify       read-only check of the export against itself and the database; exit 1 on findings
 *   init-bucket  provisioning with admin credentials: create the locked bucket (idempotent)
 */
const command = process.argv[2];
if (command === "init-bucket") {
  const days = z.coerce.number().int().positive().max(36_500).parse(process.env.AUDIT_EXPORT_RETENTION_DAYS);
  const store = await connectObjectStore(process.env, { requireLock: false });
  // The store may still be starting (Compose one-shot): retry the idempotent create for a minute.
  for (let attempt = 1; ; attempt++) {
    try {
      await store.createLockedBucket(days);
      break;
    } catch (err) {
      if (attempt >= 60 || err instanceof ObjectStoreError) throw err;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  if (!(await store.lockEnabled())) throw new Error("the bucket was created but reports no Object Lock");
  console.log(JSON.stringify({ bucket: process.env.OBJECT_STORE_BUCKET, objectLock: "Enabled", defaultRetentionDays: days }));
} else if (command === "verify") {
  const databaseUrl = z.url().parse(process.env.DATABASE_URL);
  const store = await connectObjectStore(process.env);
  const pool = createPool(databaseUrl);
  try {
    const report = await verifyAuditExport(createDb(pool), store);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.findings.length === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
} else {
  console.error("usage: audit-export-cli <verify|init-bucket>");
  process.exitCode = 2;
}
