import { Readable } from "node:stream";
import Docker from "dockerode";
import type { ExecutorBackend, LogLine, RunHandle, RunSpec, RunStatus } from "./backend.js";
import { hardenedContainerConfig, MANAGED_LABEL } from "./hardening.js";
import { demuxDockerLogs } from "./log-demux.js";

export class DaemonBaselineError extends Error {
  override name = "DaemonBaselineError";
}
export class UntrustedImageError extends Error {
  override name = "UntrustedImageError";
}

export interface DockerBackendOptions {
  /** Defaults to DOCKER_HOST. */
  docker?: Docker;
  /**
   * Image digests allowed to run. Until image signing exists (OPEN-23) this allow-list is the
   * trust anchor: a digest is trusted only if it is listed (from the agent/pack image registry).
   */
  trustedImages: ReadonlySet<string>;
  stopGraceSeconds?: number;
}

const isNotFound = (err: unknown) => (err as { statusCode?: number }).statusCode === 404;
const isNotModified = (err: unknown) => (err as { statusCode?: number }).statusCode === 304;

/**
 * Docker executor backend (FR-ORC-013). Refuses to work against a daemon that is not rootless or
 * has no seccomp (hard rule 6), refuses untrusted images, and only creates containers from
 * `hardenedContainerConfig`.
 */
export class DockerExecutorBackend implements ExecutorBackend {
  private readonly docker: Docker;
  private readonly grace: number;

  private constructor(private readonly opts: DockerBackendOptions) {
    this.docker = opts.docker ?? new Docker();
    this.grace = opts.stopGraceSeconds ?? 30;
  }

  /** Connects and checks the daemon baseline; throws DaemonBaselineError if it is not met. */
  static async connect(opts: DockerBackendOptions): Promise<DockerExecutorBackend> {
    const backend = new DockerExecutorBackend(opts);
    const info = (await backend.docker.info()) as { SecurityOptions?: string[]; CgroupVersion?: string };
    const sec = info.SecurityOptions ?? [];
    const missing = [
      sec.some((s) => s.includes("name=rootless")) ? null : "rootless mode",
      sec.some((s) => s.includes("name=seccomp")) ? null : "seccomp",
      info.CgroupVersion === "2" ? null : "cgroup v2 (needed for CPU/memory/PID limits)",
    ].filter((x): x is string => x !== null);
    if (missing.length > 0) throw new DaemonBaselineError(`Docker daemon does not meet hard rule 6: missing ${missing.join(", ")}`);
    return backend;
  }

  /**
   * Ensures the agent network exists and is internal (no route out). An existing network that is
   * not internal is refused rather than reconfigured.
   */
  async ensureInternalNetwork(name: string): Promise<void> {
    try {
      const net = (await this.docker.getNetwork(name).inspect()) as { Internal?: boolean };
      if (!net.Internal) throw new DaemonBaselineError(`network ${name} exists but is not internal; agents must have no egress`);
      return;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    await this.docker.createNetwork({ Name: name, Driver: "bridge", Internal: true, Labels: { [MANAGED_LABEL]: "true" } });
  }

  async create(spec: RunSpec): Promise<RunHandle> {
    if (!this.opts.trustedImages.has(spec.image)) throw new UntrustedImageError(`image ${spec.image} is not in the trusted image list`);
    const net = (await this.docker.getNetwork(spec.network).inspect()) as { Internal?: boolean };
    if (!net.Internal) throw new DaemonBaselineError(`network ${spec.network} is not internal`);
    const container = await this.docker.createContainer(hardenedContainerConfig(spec));
    return { runId: spec.runId, containerId: container.id };
  }

  async start(h: RunHandle): Promise<void> {
    try {
      await this.docker.getContainer(h.containerId).start();
    } catch (err) {
      if (!isNotModified(err)) throw err;
    }
  }

  async stop(h: RunHandle, _reason: string): Promise<void> {
    try {
      await this.docker.getContainer(h.containerId).stop({ t: this.grace });
    } catch (err) {
      if (!isNotModified(err) && !isNotFound(err)) throw err;
    }
  }

  async status(h: RunHandle): Promise<RunStatus> {
    try {
      const s = (await this.docker.getContainer(h.containerId).inspect()).State;
      const date = (v: string) => (v && !v.startsWith("0001-") ? new Date(v) : null);
      const state = s.Running ? "running" : s.Status === "created" ? "created" : "exited";
      return { state, exitCode: state === "exited" ? s.ExitCode : null, oomKilled: s.OOMKilled, startedAt: date(s.StartedAt), finishedAt: date(s.FinishedAt) };
    } catch (err) {
      if (isNotFound(err)) return { state: "missing", exitCode: null, oomKilled: false, startedAt: null, finishedAt: null };
      throw err;
    }
  }

  async *logs(h: RunHandle, opts: { follow: boolean }): AsyncIterable<LogLine> {
    const container = this.docker.getContainer(h.containerId);
    const raw: unknown = opts.follow
      ? await container.logs({ follow: true, stdout: true, stderr: true })
      : await container.logs({ follow: false, stdout: true, stderr: true });
    const stream = Buffer.isBuffer(raw) ? Readable.from([raw]) : (raw as Readable);
    yield* demuxDockerLogs(stream);
  }

  async delete(h: RunHandle): Promise<void> {
    try {
      await this.docker.getContainer(h.containerId).remove({ force: true, v: true });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}
