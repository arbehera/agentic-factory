import { Controller, Get, HttpException, HttpStatus, Inject, Injectable, Module, type DynamicModule, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import type { Orchestrator } from "../orchestrator.js";

export const ORCHESTRATOR = Symbol("ORCHESTRATOR");

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
  static forRoot(orch: Orchestrator): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [{ provide: ORCHESTRATOR, useValue: orch }, Lifecycle],
    };
  }
}
