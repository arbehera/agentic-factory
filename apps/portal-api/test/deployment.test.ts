import { describe, expect, it } from "vitest";
import { jwksUrl, loadPortalConfig, NotFoundError, OrchestratorLogSource, PortalStartupError } from "../src/index.js";

const ndjson = (...chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    }),
  );

async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("P0-WP11 portal API deployment", () => {
  it("reads its configuration; live logs need the internal token; the JWKS URL defaults to the issuer's", () => {
    const base = { DATABASE_URL: "postgres://u@db/adlc", OIDC_ISSUER: "http://localhost:8080/realms/adlc" };
    const c = loadPortalConfig(base);
    expect(c).toMatchObject({ PORT: 3002, OIDC_AUDIENCE: "adlc-portal", ORCHESTRATOR_URLS: [] });
    expect(jwksUrl(c)).toBe("http://localhost:8080/realms/adlc/protocol/openid-connect/certs");
    expect(jwksUrl(loadPortalConfig({ ...base, OIDC_JWKS_URL: "http://keycloak:8080/realms/adlc/protocol/openid-connect/certs" }))).toContain("keycloak:8080");
    expect(loadPortalConfig({ ...base, ORCHESTRATOR_URLS: "http://orch-a:3000, http://orch-b:3000", INTERNAL_API_TOKEN: "x".repeat(32) }).ORCHESTRATOR_URLS).toEqual(["http://orch-a:3000", "http://orch-b:3000"]);
    expect(() => loadPortalConfig({ ...base, ORCHESTRATOR_URLS: "http://orch-a:3000" })).toThrow(/INTERNAL_API_TOKEN/);
    expect(() => loadPortalConfig({ ...base, ORCHESTRATOR_URLS: "not a url", INTERNAL_API_TOKEN: "x".repeat(32) })).toThrow(PortalStartupError);
    expect(() => loadPortalConfig({})).toThrow(PortalStartupError);
  });

  it("FR-POR-001 live logs come from the first orchestrator replica that has them, as validated NDJSON lines", async () => {
    const seen: string[] = [];
    const fetchImpl = ((url: string, init?: RequestInit) => {
      seen.push(`${url} ${new Headers(init?.headers).get("authorization") ?? ""}`);
      if (url.startsWith("http://down")) return Promise.reject(new Error("ECONNREFUSED"));
      if (url.startsWith("http://other")) return Promise.resolve(new Response("{}", { status: 404 }));
      return Promise.resolve(ndjson('{"stream":"stdout","line":"one"}\n{"stream":"std', 'err","line":"two"}\nnot json\n{"stream":"evil","line":"x"}\n{"stream":"stdout","line":"last"}'));
    }) as unknown as typeof fetch;
    const source = new OrchestratorLogSource(["http://down:3000", "http://other:3000/", "http://orch:3000"], "svc-token", fetchImpl);
    expect(await collect(await source.follow("run-1"))).toEqual([
      { stream: "stdout", line: "one" },
      { stream: "stderr", line: "two" },
      { stream: "stdout", line: "last" },
    ]);
    expect(seen).toEqual([
      "http://down:3000/internal/runs/run-1/logs Bearer svc-token",
      "http://other:3000/internal/runs/run-1/logs Bearer svc-token",
      "http://orch:3000/internal/runs/run-1/logs Bearer svc-token",
    ]);
  });

  it("no replica has the log: NotFoundError", async () => {
    const source = new OrchestratorLogSource(["http://other:3000"], "t", () => Promise.resolve(new Response(null, { status: 404 })));
    await expect(source.follow("run-1")).rejects.toBeInstanceOf(NotFoundError);
  });
});
