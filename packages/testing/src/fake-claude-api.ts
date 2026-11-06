import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedModelRequest {
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

/**
 * A local stand-in for the Claude Messages API (POST /v1/messages, non-streaming). Records every
 * request — tests check the gateway injected the API key and the agent never saw it.
 */
export class FakeClaudeApi {
  readonly requests: RecordedModelRequest[] = [];
  reply = "LGTM";
  /** When set, the next request gets this HTTP status and an error body. */
  failNext: number | null = null;
  private server: Server | null = null;
  private seq = 0;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
        this.requests.push({ headers: req.headers, body });
        if (req.url !== "/v1/messages" || req.method !== "POST") {
          res.writeHead(404).end();
          return;
        }
        if (this.failNext !== null) {
          const status = this.failNext;
          this.failNext = null;
          res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "fake failure" } }));
          return;
        }
        const id = `msg_fake_${String(++this.seq).padStart(4, "0")}`;
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id,
            type: "message",
            role: "assistant",
            model: typeof body.model === "string" ? body.model : "unknown",
            content: [{ type: "text", text: this.reply }],
            stop_reason: "end_turn",
            usage: { input_tokens: 12, output_tokens: 3 },
          }),
        );
      });
    });
    const server = this.server;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}
