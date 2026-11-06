import { S3ObjectStore, s3SettingsSchema } from "@adlc/adapters";

export class ObjectStoreConfigError extends Error {
  override name = "ObjectStoreConfigError";
}

/** Builds the S3 client from the environment and checks the bucket is locked (ADR-0015). */
export async function connectObjectStore(env: Record<string, unknown>, options: { requireLock?: boolean } = {}): Promise<S3ObjectStore> {
  const parsed = s3SettingsSchema.safeParse(env);
  if (!parsed.success) throw new ObjectStoreConfigError(`invalid object store configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const store = new S3ObjectStore(parsed.data);
  if ((options.requireLock ?? true) && !(await store.lockEnabled())) {
    throw new ObjectStoreConfigError(`bucket ${parsed.data.OBJECT_STORE_BUCKET} has no Object Lock; refusing a write-once export to it`);
  }
  return store;
}
