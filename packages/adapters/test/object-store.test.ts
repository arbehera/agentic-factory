import { describe, expect, it } from "vitest";
import { ObjectStoreError, S3ObjectStore, s3SettingsSchema, signV4 } from "../src/index.js";

// AWS's published SigV4 examples for S3 (docs: "Signature Calculations for the Authorization Header").
const AWS = { region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", now: new Date("2013-05-24T00:00:00Z") };
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const sig = (h: Record<string, string>) => /Signature=([0-9a-f]+)/.exec(h.authorization ?? "")?.[1];

describe("ADR-0006 S3 object store client", () => {
  it("SigV4 matches AWS's published examples", () => {
    const get = signV4({ ...AWS, method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), headers: { Range: "bytes=0-9" }, payloadHash: EMPTY });
    expect(sig(get)).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    const lifecycle = signV4({ ...AWS, method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/?lifecycle"), headers: {}, payloadHash: EMPTY });
    expect(sig(lifecycle)).toBe("fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
    const list = signV4({ ...AWS, method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"), headers: {}, payloadHash: EMPTY });
    expect(sig(list)).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });

  const settings = s3SettingsSchema.parse({
    OBJECT_STORE_ENDPOINT: "http://store:8333",
    OBJECT_STORE_BUCKET: "adlc-audit",
    OBJECT_STORE_ACCESS_KEY_ID: "exporter",
    OBJECT_STORE_SECRET_ACCESS_KEY: "s".repeat(32),
  });
  function store(responses: (url: URL, init: RequestInit) => Response) {
    const calls: { method: string; url: URL; headers: Record<string, string>; body: unknown }[] = [];
    const fetchImpl = (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push({ method: init.method ?? "GET", url, headers: init.headers as Record<string, string>, body: init.body });
      return Promise.resolve(responses(url, init));
    };
    return { s: new S3ObjectStore(settings, fetchImpl, () => new Date("2026-11-06T00:00:00Z")), calls };
  }

  it("NFR-006 writes objects with a compliance lock, signed, path-style", async () => {
    const { s, calls } = store(() => new Response(null, { status: 200 }));
    await s.putLocked("audit/segment-0000000001.json", "{}", new Date("2026-12-06T00:00:00Z"));
    const [c] = calls;
    expect(c?.method).toBe("PUT");
    expect(c?.url.pathname).toBe("/adlc-audit/audit/segment-0000000001.json");
    expect(c?.headers).toMatchObject({
      "x-amz-object-lock-mode": "COMPLIANCE",
      "x-amz-object-lock-retain-until-date": "2026-12-06T00:00:00.000Z",
      "content-md5": "mZFLkyvTelC5g8XnyQrpOw==",
    });
    expect(c?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=exporter\/20261106\/us-east-1\/s3\/aws4_request, SignedHeaders=content-md5;content-type;host;/);
    expect(JSON.stringify(c?.headers)).not.toContain("s".repeat(32));
  });

  it("reads objects and versions; a missing object is null; errors are typed", async () => {
    const { s } = store((url) => {
      if (url.pathname.endsWith("/missing")) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      if (url.pathname.endsWith("/denied")) return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
      return new Response(`v=${url.searchParams.get("versionId") ?? "latest"}`);
    });
    expect(await s.get("a")).toBe("v=latest");
    expect(await s.get("a", "v1")).toBe("v=v1");
    expect(await s.get("missing")).toBeNull();
    expect(await s.exists("missing")).toBe(false);
    expect(await s.exists("a")).toBe(true);
    await expect(s.get("denied")).rejects.toEqual(expect.objectContaining({ name: "ObjectStoreError", status: 403, message: "get denied: HTTP 403 AccessDenied" }));
    await expect(s.exists("denied")).rejects.toBeInstanceOf(ObjectStoreError);
  });

  it("lists versions across pages, including delete markers; current keys come from the version listing", async () => {
    const { s, calls } = store((url) =>
      new Response(
        url.searchParams.get("key-marker")
          ? "<ListVersionsResult><IsTruncated>false</IsTruncated><DeleteMarker><Key>audit/k</Key><VersionId>v3</VersionId><IsLatest>true</IsLatest><LastModified>2026-11-06T02:00:00.000Z</LastModified></DeleteMarker><Version><Key>audit/b&amp;c</Key><VersionId>v1</VersionId><IsLatest>true</IsLatest><LastModified>2026-11-06T00:00:00.000Z</LastModified></Version></ListVersionsResult>"
          : "<ListVersionsResult><IsTruncated>true</IsTruncated><NextKeyMarker>audit/k</NextKeyMarker><NextVersionIdMarker>v2</NextVersionIdMarker><Version><Key>audit/k</Key><VersionId>v2</VersionId><IsLatest>false</IsLatest><LastModified>2026-11-06T01:00:00.000Z</LastModified></Version><Version><Key>audit/a</Key><VersionId>v0</VersionId><IsLatest>true</IsLatest><LastModified>2026-11-06T00:00:00.000Z</LastModified></Version></ListVersionsResult>",
      ),
    );
    expect(await s.listVersions("audit/")).toEqual([
      { key: "audit/k", versionId: "v2", deleteMarker: false, isLatest: false, lastModified: "2026-11-06T01:00:00.000Z" },
      { key: "audit/a", versionId: "v0", deleteMarker: false, isLatest: true, lastModified: "2026-11-06T00:00:00.000Z" },
      { key: "audit/k", versionId: "v3", deleteMarker: true, isLatest: true, lastModified: "2026-11-06T02:00:00.000Z" },
      { key: "audit/b&c", versionId: "v1", deleteMarker: false, isLatest: true, lastModified: "2026-11-06T00:00:00.000Z" },
    ]);
    expect(calls[1]?.url.searchParams.get("key-marker")).toBe("audit/k");
    expect(calls[1]?.url.searchParams.get("version-id-marker")).toBe("v2");
    // A deleted key (delete marker latest) is not current.
    expect(await s.listKeys("audit/")).toEqual(["audit/a", "audit/b&c"]);
  });

  it("NFR-006 provisioning creates a locked bucket with a default compliance retention, idempotently", async () => {
    const { s, calls } = store((url, init) => {
      if (init.method === "PUT" && !url.searchParams.has("object-lock")) return new Response("<Error><Code>BucketAlreadyOwnedByYou</Code></Error>", { status: 409 });
      if (init.method === "GET") return new Response("<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>");
      return new Response(null, { status: 200 });
    });
    await s.createLockedBucket(30);
    expect(calls[0]?.headers["x-amz-bucket-object-lock-enabled"]).toBe("true");
    expect(String(calls[1]?.body)).toContain("<Mode>COMPLIANCE</Mode><Days>30</Days>");
    expect(await s.lockEnabled()).toBe(true);
  });

  it("an unlocked or missing bucket reports no lock; other failures throw", async () => {
    expect(await store(() => new Response("<ObjectLockConfiguration></ObjectLockConfiguration>")).s.lockEnabled()).toBe(false);
    expect(await store(() => new Response("", { status: 404 })).s.lockEnabled()).toBe(false);
    await expect(store(() => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })).s.createLockedBucket(1)).rejects.toThrow(/create bucket: HTTP 403 AccessDenied/);
  });
});
