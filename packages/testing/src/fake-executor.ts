import { randomUUID } from "node:crypto";
import { assertHardenedRunSpec, type ExecutorBackend, type LogLine, type RunHandle, type RunSpec, type RunStatus } from "@adlc/executor";

interface FakeContainer {
  spec: RunSpec;
  state: RunStatus["state"];
  exitCode: number | null;
  oomKilled: boolean;
  logs: LogLine[];
}

/**
 * In-memory ExecutorBackend (CLAUDE.md §7). It applies the same run-spec checks as the real
 * backend, so tests cannot pass with a spec Docker would refuse. Tests drive container exits.
 */
export class FakeExecutorBackend implements ExecutorBackend {
  readonly containers = new Map<string, FakeContainer>();
  readonly stops: { containerId: string; reason: string }[] = [];
  /** Set to make the next create() fail. */
  failNextCreate: Error | null = null;

  create(spec: RunSpec): Promise<RunHandle> {
    assertHardenedRunSpec(spec);
    if (this.failNextCreate) {
      const err = this.failNextCreate;
      this.failNextCreate = null;
      return Promise.reject(err);
    }
    const containerId = randomUUID().replace(/-/g, "");
    this.containers.set(containerId, { spec, state: "created", exitCode: null, oomKilled: false, logs: [] });
    return Promise.resolve({ runId: spec.runId, containerId });
  }

  start(h: RunHandle): Promise<void> {
    const c = this.containers.get(h.containerId);
    if (c?.state === "created") c.state = "running";
    return Promise.resolve();
  }

  stop(h: RunHandle, reason: string): Promise<void> {
    this.stops.push({ containerId: h.containerId, reason });
    this.exit(h.containerId, 143);
    return Promise.resolve();
  }

  status(h: RunHandle): Promise<RunStatus> {
    const c = this.containers.get(h.containerId);
    if (!c) return Promise.resolve({ state: "missing", exitCode: null, oomKilled: false, startedAt: null, finishedAt: null });
    return Promise.resolve({ state: c.state, exitCode: c.exitCode, oomKilled: c.oomKilled, startedAt: null, finishedAt: null });
  }

  async *logs(h: RunHandle): AsyncIterable<LogLine> {
    for (const l of this.containers.get(h.containerId)?.logs ?? []) {
      await Promise.resolve();
      yield l;
    }
  }

  delete(h: RunHandle): Promise<void> {
    this.containers.delete(h.containerId);
    return Promise.resolve();
  }

  /** Test control: the container's process exits with `code`. */
  exit(containerId: string, code: number, opts: { oomKilled?: boolean } = {}): void {
    const c = this.containers.get(containerId);
    if (!c) return;
    c.state = "exited";
    c.exitCode = code;
    c.oomKilled = opts.oomKilled ?? false;
  }

  /** Test control: the container vanishes (e.g. removed outside the platform). */
  vanish(containerId: string): void {
    this.containers.delete(containerId);
  }

  byRun(runId: string): { containerId: string; container: FakeContainer } | undefined {
    for (const [containerId, container] of this.containers) if (container.spec.runId === runId) return { containerId, container };
    return undefined;
  }
}
