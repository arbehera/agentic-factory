import { createHash, createHmac } from "node:crypto";
import { z } from "zod";

/**
 * Object store port (ADR-0006): the write-once audit and evidence export (NFR-006, ADR-0015).
 * The interface has no operation that deletes, overwrites or shortens a retention: objects are
 * written once with a compliance-mode lock, and every version is visible to the verifier.
 */
export interface ObjectVersion {
  key: string;
  versionId: string;
  deleteMarker: boolean;
  isLatest: boolean;
  /** UTC ISO-8601. */
  lastModified: string;
}

export interface ObjectStore {
  /** Writes `body` under `key`, locked in compliance mode until `retainUntil`. */
  putLocked(key: string, body: string, retainUntil: Date): Promise<void>;
  /** The latest version (or the given one); null when there is none. */
  get(key: string, versionId?: string): Promise<string | null>;
  exists(key: string): Promise<boolean>;
  /** Current keys under `prefix`, in key order. */
  listKeys(prefix: string): Promise<string[]>;
  /** Every version and delete marker under `prefix`. */
  listVersions(prefix: string): Promise<ObjectVersion[]>;
}

export class ObjectStoreError extends Error {
  override name = "ObjectStoreError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const s3SettingsSchema = z.object({
  OBJECT_STORE_ENDPOINT: z.url(),
  OBJECT_STORE_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  OBJECT_STORE_REGION: z.string().min(1).default("us-east-1"),
  OBJECT_STORE_ACCESS_KEY_ID: z.string().min(3),
  OBJECT_STORE_SECRET_ACCESS_KEY: z.string().min(16),
});
export type S3Settings = z.infer<typeof s3SettingsSchema>;

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data, "utf8").digest();
/** RFC 3986 encoding, as SigV4 requires. */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * AWS Signature Version 4 for S3 (path-style). Returns the headers to send, including
 * `authorization`. Exported for its test vector.
 */
export function signV4(req: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  now: Date;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Record<string, string> {
  const amzDate = req.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: req.url.host, "x-amz-content-sha256": req.payloadHash, "x-amz-date": amzDate };
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((k) => `${k}:${String(headers[k]).trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...req.url.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [req.method, req.url.pathname, query, canonicalHeaders, signedHeaders, req.payloadHash].join("\n");
  const scope = `${date}/${req.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${req.secretAccessKey}`, date), req.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string) => s.replace(/&(#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => (e.startsWith("#") ? String.fromCharCode(Number(e.slice(1))) : (XML_ENTITIES[e] ?? "")));
const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m?.[1] === undefined ? null : unxml(m[1]);
};

/** S3-compatible object store client (SeaweedFS in Compose, ADR-0006). No SDK: SigV4 over fetch. */
export class S3ObjectStore implements ObjectStore {
  private readonly endpoint: URL;

  constructor(
    private readonly settings: S3Settings,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.endpoint = new URL(settings.OBJECT_STORE_ENDPOINT);
  }

  private url(key: string, query: Record<string, string> = {}): URL {
    const path = key === "" ? "" : `/${key.split("/").map(rfc3986).join("/")}`;
    const url = new URL(`${this.endpoint.origin}/${this.settings.OBJECT_STORE_BUCKET}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url;
  }

  private async send(method: string, url: URL, opts: { body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    const body = opts.body ?? "";
    const headers = signV4({
      method,
      url,
      headers: { ...(opts.body === undefined ? {} : { "content-md5": createHash("md5").update(body).digest("base64") }), ...opts.headers },
      payloadHash: sha256(body),
      now: this.now(),
      region: this.settings.OBJECT_STORE_REGION,
      accessKeyId: this.settings.OBJECT_STORE_ACCESS_KEY_ID,
      secretAccessKey: this.settings.OBJECT_STORE_SECRET_ACCESS_KEY,
    });
    delete headers.host; // fetch sets it
    return this.fetchImpl(url, { method, headers, ...(opts.body === undefined ? {} : { body }) });
  }

  private async fail(res: Response, what: string): Promise<never> {
    const text = await res.text();
    throw new ObjectStoreError(`${what}: HTTP ${res.status} ${tag(text, "Code") ?? ""}`.trim(), res.status);
  }

  async putLocked(key: string, body: string, retainUntil: Date): Promise<void> {
    const res = await this.send("PUT", this.url(key), {
      body,
      headers: {
        "content-type": "application/json",
        "x-amz-object-lock-mode": "COMPLIANCE",
        "x-amz-object-lock-retain-until-date": retainUntil.toISOString(),
      },
    });
    if (!res.ok) await this.fail(res, `put ${key}`);
    await res.arrayBuffer();
  }

  async get(key: string, versionId?: string): Promise<string | null> {
    const res = await this.send("GET", this.url(key, versionId ? { versionId } : {}));
    if (res.status === 404) {
      await res.arrayBuffer();
      return null;
    }
    if (!res.ok) await this.fail(res, `get ${key}`);
    return res.text();
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.send("HEAD", this.url(key));
    await res.arrayBuffer();
    if (res.status === 404) return false;
    if (!res.ok) throw new ObjectStoreError(`head ${key}: HTTP ${res.status}`, res.status);
    return true;
  }

  /**
   * From the version listing: SeaweedFS 3.97's ListObjectsV2 returns wrong keys (the prefix
   * doubled) on a versioned bucket, while ListObjectVersions is correct (ADR-0015).
   */
  async listKeys(prefix: string): Promise<string[]> {
    return (await this.listVersions(prefix)).filter((v) => v.isLatest && !v.deleteMarker).map((v) => v.key).sort();
  }

  async listVersions(prefix: string): Promise<ObjectVersion[]> {
    const out: ObjectVersion[] = [];
    let marker: { key: string; version: string } | null = null;
    do {
      const query: Record<string, string> = { versions: "", prefix, ...(marker ? { "key-marker": marker.key, "version-id-marker": marker.version } : {}) };
      const res = await this.send("GET", this.url("", query));
      if (!res.ok) await this.fail(res, `list versions ${prefix}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
        const body = m[2] ?? "";
        const key = tag(body, "Key");
        const versionId = tag(body, "VersionId");
        if (key === null || versionId === null) continue;
        out.push({ key, versionId, deleteMarker: m[1] === "DeleteMarker", isLatest: tag(body, "IsLatest") === "true", lastModified: tag(body, "LastModified") ?? "" });
      }
      const nextKey = tag(xml, "NextKeyMarker");
      const nextVersion = tag(xml, "NextVersionIdMarker");
      marker = tag(xml, "IsTruncated") === "true" && nextKey !== null && nextVersion !== null ? { key: nextKey, version: nextVersion } : null;
    } while (marker);
    return out;
  }

  /** Whether the bucket has Object Lock enabled; the exporter refuses an unlocked bucket. */
  async lockEnabled(): Promise<boolean> {
    const res = await this.send("GET", this.url("", { "object-lock": "" }));
    if (res.status === 404) {
      await res.arrayBuffer();
      return false;
    }
    if (!res.ok) await this.fail(res, "get object-lock configuration");
    return tag(await res.text(), "ObjectLockEnabled") === "Enabled";
  }

  /**
   * Provisioning (admin credentials only): creates the bucket with Object Lock and a default
   * compliance retention. Idempotent.
   */
  async createLockedBucket(defaultRetentionDays: number): Promise<void> {
    const create = await this.send("PUT", this.url(""), { headers: { "x-amz-bucket-object-lock-enabled": "true" } });
    const text = await create.text();
    if (!create.ok && !/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(text)) throw new ObjectStoreError(`create bucket: HTTP ${create.status} ${tag(text, "Code") ?? ""}`.trim(), create.status);
    const ns = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"';
    const config = `<ObjectLockConfiguration ${ns}><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>COMPLIANCE</Mode><Days>${defaultRetentionDays}</Days></DefaultRetention></Rule></ObjectLockConfiguration>`;
    const res = await this.send("PUT", this.url("", { "object-lock": "" }), { body: config, headers: { "content-type": "application/xml" } });
    if (!res.ok) await this.fail(res, "put object-lock configuration");
    await res.arrayBuffer();
  }
}
