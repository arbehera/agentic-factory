import type { IncomingMessage, ServerResponse } from "node:http";
import { InvalidSessionError, type GatewaySessionContext } from "@adlc/db";
import { PolicyDeniedError } from "@adlc/mcp-servers";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { InvalidArgumentsError, ToolNotPermittedError, UnknownToolError, type Gateway } from "./gateway.js";

export const MCP_SERVERS = ["jira", "github", "decisions", "evidence"] as const;

/** Errors whose message is safe to show the agent; anything else becomes a generic error. */
const AGENT_VISIBLE = [PolicyDeniedError, ToolNotPermittedError, UnknownToolError, InvalidArgumentsError];

function errorResult(err: unknown): CallToolResult {
  const visible = AGENT_VISIBLE.some((E) => err instanceof E);
  const text = visible ? `denied: ${(err as Error).message}` : `tool failed (${err instanceof Error ? err.name : "error"})`;
  return { isError: true, content: [{ type: "text", text }] };
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/**
 * Builds a per-request MCP server bound to one authenticated run and one tool server. Uses the
 * low-level `Server` on purpose: the tool list is computed per run from its role policy and every
 * call goes through the gateway's checks, which McpServer's static registration cannot express.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- low-level Server is the SDK's documented path for advanced use
function mcpServerFor(gateway: Gateway, run: GatewaySessionContext, server: string): Server {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
  const mcp = new Server({ name: `adlc-${server}`, version: "0.1.0" }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: gateway.listTools(run, server).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.input, { io: "input" }) as { type: "object"; [k: string]: unknown },
    })),
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    try {
      const result = await gateway.call(run, server, req.params.name, req.params.arguments ?? {});
      // Results are external content: data for the agent, never instructions (hard rule 10).
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err);
    }
  });
  return mcp;
}

/**
 * Handles `POST /mcp/<server>` (MCP Streamable HTTP, stateless). The bearer token is the run's
 * gateway session; it is checked before any MCP processing.
 */
export async function handleMcpRequest(gateway: Gateway, server: string, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  if (!(MCP_SERVERS as readonly string[]).includes(server)) {
    sendJson(res, 404, { error: `unknown MCP server ${server}` });
    return;
  }
  const token = bearer(req);
  let run: GatewaySessionContext;
  try {
    if (!token) throw new InvalidSessionError("missing bearer token");
    run = await gateway.authenticate(token);
  } catch (err) {
    if (!(err instanceof InvalidSessionError)) throw err;
    sendJson(res, 401, { error: "invalid gateway session" });
    return;
  }
  const mcp = mcpServerFor(gateway, run, server);
  // No sessionIdGenerator: stateless mode (one transport per request; the bearer token is the session).
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
}
