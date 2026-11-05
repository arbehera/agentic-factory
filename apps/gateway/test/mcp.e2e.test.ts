import "reflect-metadata";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayModule } from "../src/http/app.module.js";
import { gatewayHarness, skipIntegration, type GatewayHarness } from "./helpers.js";

describe.skipIf(skipIntegration)("P0-WP5 MCP over HTTP", () => {
  let h: GatewayHarness;
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    h = await gatewayHarness();
    app = await NestFactory.create(GatewayModule.forRoot(h.gateway), { logger: false });
    await app.listen(0);
    base = (await app.getUrl()).replace("[::1]", "localhost");
  });
  afterAll(async () => {
    await app.close();
    await h.close();
  });

  async function client(server: string, token = h.token): Promise<Client> {
    const c = new Client({ name: "agent-runtime-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp/${server}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    // The SDK's own types disagree under exactOptionalPropertyTypes (sessionId?: string vs string); runtime is fine.
    await c.connect(transport as unknown as Transport);
    return c;
  }

  it("lists only the role's tools, with JSON Schemas, per server", async () => {
    const c = await client("jira");
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["comment", "read_issue", "transition"]);
    expect(tools.find((t) => t.name === "read_issue")?.inputSchema).toMatchObject({ type: "object", properties: { key: { type: "string" } } });
    await c.close();
  });

  it("calls a tool and returns its result as data", async () => {
    const c = await client("jira");
    const r = await c.callTool({ name: "read_issue", arguments: { key: "PILOT-1" } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse((r.content as { text: string }[])[0]?.text ?? "")).toMatchObject({ key: "PILOT-1" });
    await c.close();
  });

  it("AT-P0-04 refusals come back as tool errors with the reason, and nothing reaches Jira or GitHub", async () => {
    const jira = await client("jira");
    const done = await jira.callTool({ name: "transition", arguments: { key: "PILOT-1", to: "Done" } });
    expect(done).toMatchObject({ isError: true, content: [{ type: "text", text: "denied: only adlc-orchestrator may set Done" }] });
    const gate = await jira.callTool({ name: "comment", arguments: { key: "PILOT-2", body: "approve" } });
    expect(gate).toMatchObject({ isError: true, content: [{ text: "denied: agents may not comment on Gate issues" }] });
    const hidden = await jira.callTool({ name: "create_issue", arguments: { type: "Bug", summary: "s", description: "" } });
    expect(hidden).toMatchObject({ isError: true, content: [{ text: "denied: role engineer may not call jira.create_issue" }] });

    const gh = await client("github");
    const main = await gh.callTool({ name: "commit_files", arguments: { repo: "org/product", branch: "main", message: "m", parentSha: "abcdef1", files: [{ path: "src/a.c", content: "x" }] } });
    expect(main).toMatchObject({ isError: true, content: [{ text: "denied: agents never write main" }] });
    const merge = await gh.callTool({ name: "merge_pull_request", arguments: { number: 1 } });
    expect(merge).toMatchObject({ isError: true, content: [{ text: "denied: unknown tool github.merge_pull_request" }] });
    expect(h.jira.calls.some((x) => x.startsWith("transition") || x.startsWith("addComment"))).toBe(false);
    expect(h.github.calls.some((x) => x.startsWith("commit"))).toBe(false);
    await jira.close();
    await gh.close();
  });

  it("rejects missing or forged tokens with 401, unknown servers with 404 and GET with 405", async () => {
    const post = (server: string, headers: Record<string, string>) =>
      fetch(`${base}/mcp/${server}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect((await post("jira", {})).status).toBe(401);
    expect((await post("jira", { authorization: "Bearer forged" })).status).toBe(401);
    expect((await post("jenkins", { authorization: `Bearer ${h.token}` })).status).toBe(404);
    expect((await fetch(`${base}/mcp/jira`)).status).toBe(405);
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: "ok" });
  });

  it("hides internal error details from the agent", async () => {
    const c = await client("jira");
    h.jira.issues.delete("PILOT-1");
    const r = await c.callTool({ name: "read_issue", arguments: { key: "PILOT-1" } });
    expect(r).toMatchObject({ isError: true, content: [{ text: "tool failed (IssueNotFoundError)" }] });
    await c.close();
  });
});
