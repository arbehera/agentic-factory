import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Controller, Get, HttpException, HttpStatus, Inject, Injectable, Module, Param, Req, Res, type DynamicModule, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import type { Orchestrator } from "../orchestrator.js";

export const ORCHESTRATOR = Symbol("ORCHESTRATOR");
export const INTERNAL_TOKEN = Symbol("INTERNAL_TOKEN");

/** Constant-time bearer check; compares digests so differing lengths leak nothing either. */
function bearerMatches(header: string | undefined, token: string): boolean {
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${token}`));
}

/**
 * Health and readiness (NFR-009). Readiness requires a working database connection; the
 * response also reports whether this replica is the dispatcher leader.
 * Explicit @Inject tokens are used throughout: no reliance on emitted decorator metadata.
 */
@Controller()
export class HealthController {
  constructor(@Inject(ORCHESTRATOR) private readonly orch: Orchestrator) {}

  @Get("health")
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<{ status: "ready"; leader: boolean }> {
    try {
      await this.orch.pool.query("select 1");
    } catch {
      throw new HttpException({ status: "not-ready", reason: "database unreachable" }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: "ready", leader: this.orch.elector.isLeader };
  }
}

/**
 * Internal routes for other platform services, not for people or agents. Live logs: the portal
 * API reads a run's container log here, so only the executor host talks to Docker (ADR-0014).
 * Off unless INTERNAL_API_TOKEN is set; the run's container is looked up here, never taken from
 * the caller.
 */
@Controller("internal")
export class InternalController {
  constructor(
    @Inject(ORCHESTRATOR) private readonly orch: Orchestrator,
    @Inject(INTERNAL_TOKEN) private readonly token: string | null,
  ) {}

  @Get("runs/:id/logs")
  async logs(@Param("id") id: string, @Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (!this.token) return void json(404, { error: "internal routes are disabled" });
    if (!bearerMatches(req.headers.authorization, this.token)) return void json(401, { error: "invalid service token" });
    if (!/^[0-9a-f-]{36}$/.test(id)) return void json(400, { error: "invalid run id" });
    const lines = await this.orch.runLogs(id);
    if (!lines) return void json(404, { error: `run ${id} has no container on this executor host` });
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    const disconnected = new AbortController();
    req.on("close", () => {
      disconnected.abort();
    });
    for await (const line of lines) {
      if (disconnected.signal.aborted) break;
      res.write(`${JSON.stringify(line)}\n`);
    }
    res.end();
  }
}

/** Starts the leader runtime with the app and stops it (and the pool) on shutdown. */
@Injectable()
class Lifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(ORCHESTRATOR) private readonly orch: Orchestrator) {}
  onModuleInit(): void {
    this.orch.start();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.orch.close();
  }
}

@Module({})
// NestJS dynamic modules are classes with a static factory by convention.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AppModule {
  static forRoot(orch: Orchestrator, internalToken: string | null = null): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, InternalController],
      providers: [{ provide: ORCHESTRATOR, useValue: orch }, { provide: INTERNAL_TOKEN, useValue: internalToken }, Lifecycle],
    };
  }
}
