import type { IncomingMessage, ServerResponse } from "node:http";
import { Body, Controller, Get, Inject, Module, Param, Post, Req, Res, type DynamicModule } from "@nestjs/common";
import { ForbiddenError, UnauthenticatedError, type PortalAuth, type Principal } from "../auth.js";
import { InvalidRequestError, NotFoundError, type PortalService } from "../portal-service.js";

export const PORTAL_SERVICE = Symbol("PORTAL_SERVICE");
export const PORTAL_AUTH = Symbol("PORTAL_AUTH");

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
}

function statusOf(err: unknown): number | null {
  if (err instanceof UnauthenticatedError) return 401;
  if (err instanceof ForbiddenError) return 403;
  if (err instanceof NotFoundError) return 404;
  if (err instanceof InvalidRequestError) return 400;
  if ((err as Error).name === "KillSwitchError") return 400;
  return null;
}

/**
 * Portal API (C9). Thin shell: authenticate, call PortalService, map errors. No route approves a
 * gate, merges, or edits packs or configuration (FR-POR-004).
 */
@Controller("api")
export class PortalController {
  constructor(
    @Inject(PORTAL_SERVICE) private readonly portal: PortalService,
    @Inject(PORTAL_AUTH) private readonly auth: PortalAuth,
  ) {}

  private async handle(req: IncomingMessage, res: ServerResponse, fn: (p: Principal) => Promise<unknown>): Promise<void> {
    try {
      send(res, 200, await fn(await this.auth.authenticate(req.headers.authorization)));
    } catch (err) {
      const status = statusOf(err);
      if (status === null) throw err;
      send(res, status, { error: (err as Error).message });
    }
  }

  @Get("health")
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("runs")
  fleet(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    return this.handle(req, res, (p) => this.portal.fleet(p));
  }

  @Get("runs/:id")
  run(@Param("id") id: string, @Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    return this.handle(req, res, (p) => this.portal.runDetail(p, id));
  }

  /** Live logs as newline-delimited JSON over a streamed response (read with fetch; headers carry auth). */
  @Get("runs/:id/logs")
  async logs(@Param("id") id: string, @Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    let lines: AsyncIterable<unknown>;
    try {
      lines = await this.portal.liveLogs(await this.auth.authenticate(req.headers.authorization), id);
    } catch (err) {
      const status = statusOf(err);
      if (status === null) throw err;
      send(res, status, { error: (err as Error).message });
      return;
    }
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
    // Stop streaming as soon as the client disconnects.
    const disconnected = new AbortController();
    req.on("close", () => {
      disconnected.abort();
    });
    try {
      for await (const line of lines) {
        if (disconnected.signal.aborted) break;
        res.write(`${JSON.stringify(line)}\n`);
      }
    } catch {
      // The source failed mid-stream (e.g. the executor host went away): end the stream cleanly.
    } finally {
      res.end();
    }
  }

  @Get("inbox")
  inbox(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    return this.handle(req, res, (p) => this.portal.inbox(p));
  }

  @Post("inbox/:id/ack")
  ack(@Param("id") id: string, @Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    return this.handle(req, res, (p) => this.portal.acknowledge(p, id));
  }

  @Get("kill-switch")
  killSwitch(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    return this.handle(req, res, (p) => this.portal.killSwitchState(p));
  }

  @Post("kill-switch/engage")
  engage(@Req() req: IncomingMessage, @Res() res: ServerResponse, @Body() body: unknown): Promise<void> {
    return this.handle(req, res, (p) => this.portal.engageKillSwitch(p, body));
  }

  @Post("kill-switch/release")
  release(@Req() req: IncomingMessage, @Res() res: ServerResponse, @Body() body: unknown): Promise<void> {
    return this.handle(req, res, (p) => this.portal.releaseKillSwitch(p, body));
  }
}

@Module({})
// NestJS dynamic modules are classes with a static factory by convention.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class PortalModule {
  static forRoot(portal: PortalService, auth: PortalAuth): DynamicModule {
    return {
      module: PortalModule,
      controllers: [PortalController],
      providers: [
        { provide: PORTAL_SERVICE, useValue: portal },
        { provide: PORTAL_AUTH, useValue: auth },
      ],
    };
  }
}
