import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type HeartbeatDirective = "continue" | "stop-after-step" | "stop";

/** A tool call the gateway refused or that failed; the message is what the gateway returned. */
export class ToolCallError extends Error {
  override name = "ToolCallError";
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(`${tool}: ${message}`);
  }
}

export class GatewayUnavailableError extends Error {
  override name = "GatewayUnavailableError";
}

/**
 * The agent's only connection to the outside (C3 → C4): MCP tool calls per server, and heartbeats.
 * The bearer token is the run's gateway session; it is never logged or passed to tools.
 */
export class GatewayClient {
  private readonly clients = new Map<string, Promise<Client>>();

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async tool<T = unknown>(server: string, name: string, args: Record<string, unknown>): Promise<T> {
    const client = await this.client(server);
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text ?? "";
    if (result.isError) throw new ToolCallError(`${server}.${name}`, text);
    return JSON.parse(text) as T;
  }

  /** Claude Messages API through the gateway proxy (non-streaming); the gateway holds the key. */
  async model(body: Record<string, unknown>): Promise<{ id: string; content: { type: string; text?: string }[] }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/model/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new GatewayUnavailableError(`model call failed: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as { id?: unknown; content?: unknown; error?: { message?: string } };
    if (!res.ok || typeof json.id !== "string" || !Array.isArray(json.content)) {
      throw new ToolCallError("model.messages", `HTTP ${res.status}: ${json.error?.message ?? "invalid response"}`);
    }
    return { id: json.id, content: json.content as { type: string; text?: string }[] };
  }

  async heartbeat(usage: { tokens: number; costUsd: number }): Promise<HeartbeatDirective> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/runtime/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ usage }),
      });
    } catch (err) {
      throw new GatewayUnavailableError(`heartbeat failed: ${(err as Error).message}`);
    }
    if (res.status === 409) return "stop"; // the lease is gone
    if (!res.ok) throw new GatewayUnavailableError(`heartbeat answered HTTP ${res.status}`);
    return ((await res.json()) as { directive: HeartbeatDirective }).directive;
  }

  async close(): Promise<void> {
    for (const c of this.clients.values()) await (await c.catch(() => null))?.close();
    this.clients.clear();
  }

  private client(server: string): Promise<Client> {
    let c = this.clients.get(server);
    if (!c) {
      c = (async () => {
        const client = new Client({ name: "adlc-agent-runtime", version: "0.1.0" });
        const transport = new StreamableHTTPClientTransport(new URL(`${this.baseUrl}/mcp/${server}`), {
          requestInit: { headers: { authorization: `Bearer ${this.token}` } },
        });
        try {
          // The SDK's own types disagree under exactOptionalPropertyTypes; runtime is fine.
          await client.connect(transport);
        } catch (err) {
          throw new GatewayUnavailableError(`cannot reach the gateway (${server}): ${(err as Error).message}`);
        }
        return client;
      })();
      this.clients.set(server, c);
    }
    return c;
  }
}
