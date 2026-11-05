import type { IncomingMessage, ServerResponse } from "node:http";
import { InvalidSessionError, LeaseExpiredError, StaleFencingTokenError } from "@adlc/db";
import { z } from "zod";
import { All, Body, Controller, Get, Inject, Module, Param, Post, Req, Res, type DynamicModule } from "@nestjs/common";
import { InvalidArgumentsError, type Gateway } from "../gateway.js";
import { handleMcpRequest } from "../mcp-http.js";

export const GATEWAY = Symbol("GATEWAY");

const heartbeatBody = z.strictObject({
  usage: z.strictObject({ tokens: z.number().int().min(0), costUsd: z.number().min(0) }).default({ tokens: 0, costUsd: 0 }),
});

/** Thin HTTP shell (CLAUDE.md §4): MCP endpoints and health. Explicit @Inject tokens throughout. */
@Controller()
export class GatewayController {
  constructor(@Inject(GATEWAY) private readonly gateway: Gateway) {}

  @Get("health")
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  @Post("mcp/:server")
  async mcp(@Param("server") server: string, @Req() req: IncomingMessage, @Res() res: ServerResponse, @Body() body: unknown): Promise<void> {
    await handleMcpRequest(this.gateway, server, req, res, body);
  }

  /**
   * Agent heartbeat (FR-ORC-008). 200 with the directive; 401 for a bad session; 400 for a session
   * without a task; 409 when the lease is gone — the agent must stop at once.
   */
  @Post("runtime/heartbeat")
  async heartbeat(@Req() req: IncomingMessage, @Res() res: ServerResponse, @Body() body: unknown): Promise<void> {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    };
    const parsed = heartbeatBody.safeParse(body ?? {});
    if (!parsed.success) {
      send(400, { error: "invalid heartbeat body" });
      return;
    }
    const auth = req.headers.authorization;
    try {
      const run = await this.gateway.authenticate(auth?.startsWith("Bearer ") ? auth.slice(7) : "");
      const reply = await this.gateway.heartbeat(run, parsed.data.usage);
      send(200, { expiresAt: reply.expiresAt.toISOString(), directive: reply.directive, budgets: reply.budgets });
    } catch (err) {
      if (err instanceof InvalidSessionError) send(401, { error: "invalid gateway session" });
      else if (err instanceof InvalidArgumentsError) send(400, { error: err.message });
      else if (err instanceof StaleFencingTokenError || err instanceof LeaseExpiredError) send(409, { directive: "stop", reason: "lease lost" });
      else throw err;
    }
  }

  /** Stateless MCP: no SSE stream (GET) and no session teardown (DELETE). */
  @All("mcp/:server")
  notAllowed(@Res() res: ServerResponse): void {
    res.writeHead(405, { allow: "POST" }).end();
  }
}

@Module({})
// NestJS dynamic modules are classes with a static factory by convention.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class GatewayModule {
  static forRoot(gateway: Gateway): DynamicModule {
    return { module: GatewayModule, controllers: [GatewayController], providers: [{ provide: GATEWAY, useValue: gateway }] };
  }
}
