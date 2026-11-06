import type { IncomingMessage, ServerResponse } from "node:http";
import { All, Body, Controller, Get, Inject, Module, Param, Post, Req, Res, type DynamicModule } from "@nestjs/common";
import type { Gateway } from "../gateway.js";
import { handleMcpRequest } from "../mcp-http.js";

export const GATEWAY = Symbol("GATEWAY");

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
