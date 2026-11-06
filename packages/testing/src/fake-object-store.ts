import type { ObjectStore, ObjectVersion } from "@adlc/adapters";

interface StoredVersion extends ObjectVersion {
  body: string | null;
  retainUntil: Date | null;
}

/**
 * In-memory S3-compatible store with Object Lock semantics as measured on SeaweedFS 3.97
 * (ADR-0015): a write never replaces a version, it adds one; a plain delete adds a delete marker;
 * a locked version cannot be removed. `overwrite` and `deleteLatest` stand in for an attacker or
 * a mistaken operator and exist only on the fake.
 */
export class InMemoryObjectStore implements ObjectStore {
  private readonly versions = new Map<string, StoredVersion[]>();
  private counter = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private add(key: string, body: string | null, retainUntil: Date | null): void {
    const list = this.versions.get(key) ?? [];
    list.push({ key, versionId: `v${++this.counter}`, deleteMarker: body === null, isLatest: true, lastModified: new Date(this.now().getTime() + this.counter).toISOString(), body, retainUntil });
    this.versions.set(key, list);
  }

  putLocked(key: string, body: string, retainUntil: Date): Promise<void> {
    this.add(key, body, retainUntil);
    return Promise.resolve();
  }

  get(key: string, versionId?: string): Promise<string | null> {
    const list = this.versions.get(key) ?? [];
    const v = versionId ? list.find((x) => x.versionId === versionId) : list.at(-1);
    return Promise.resolve(v?.body ?? null);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  listKeys(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.versions.entries()].filter(([k, l]) => k.startsWith(prefix) && l.at(-1)?.deleteMarker === false).map(([k]) => k).sort());
  }

  listVersions(prefix: string): Promise<ObjectVersion[]> {
    return Promise.resolve(
      [...this.versions.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .flatMap(([, l]) => [...l].reverse().map(({ key, versionId, deleteMarker, lastModified }, i) => ({ key, versionId, deleteMarker, isLatest: i === 0, lastModified }))),
    );
  }

  /** Test control: an unlocked write over an existing key (adds a version, as S3 does). */
  overwrite(key: string, body: string): void {
    this.add(key, body, null);
  }

  /** Test control: a plain DELETE (adds a delete marker; locked versions stay). */
  deleteLatest(key: string): void {
    this.add(key, null, null);
  }

  /** Test control: removing a version is refused while it is locked, as in compliance mode. */
  removeVersion(key: string, versionId: string): void {
    const list = this.versions.get(key) ?? [];
    const v = list.find((x) => x.versionId === versionId);
    if (v?.retainUntil && v.retainUntil > this.now()) throw new Error("AccessDenied: object is locked");
    this.versions.set(key, list.filter((x) => x !== v));
  }

  /** Test control: an admin deleting the whole bucket, which SeaweedFS 3.97 allows despite the lock. */
  deleteBucket(): void {
    this.versions.clear();
  }

  retention(key: string): Date | null {
    return this.versions.get(key)?.[0]?.retainUntil ?? null;
  }
}
