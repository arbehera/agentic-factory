import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import {
  assertHardenedRunSpec,
  DaemonBaselineError,
  demuxDockerLogs,
  DockerExecutorBackend,
  hardenedContainerConfig,
  UnsafeRunSpecError,
  UntrustedImageError,
  type RunSpec,
} from "../src/index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const spec: RunSpec = {
  runId: "11111111-2222-3333-4444-555555555555",
  image: `registry.local/adlc/agent@${DIGEST}`,
  env: { ADLC_GATEWAY_URL: "http://adlc-gateway:3001", ADLC_GATEWAY_TOKEN: "per-run-token", ADLC_TASK_KEY: "PILOT-1" },
  limits: { cpus: 1.5, memoryMb: 512, pidsLimit: 256, scratchMb: 400 },
  network: "adlc-agents",
};

describe("FR-ORC-013 container security baseline (hard rule 6)", () => {
  it("FR-ORC-013 builds containers that are read-only, unprivileged, capability-free and limited", () => {
    const c = hardenedContainerConfig(spec);
    expect(c.User).toBe("65532:65532");
    expect(c.HostConfig).toMatchObject({
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd: [],
      SecurityOpt: ["no-new-privileges:true"],
      Binds: [],
      Mounts: [],
      Memory: 512 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,
      NanoCpus: 1_500_000_000,
      PidsLimit: 256,
      NetworkMode: "adlc-agents",
      IpcMode: "private",
      RestartPolicy: { Name: "no" },
    });
    expect(Object.keys(c.HostConfig.Tmpfs ?? {}).sort()).toEqual(["/tmp", "/workspace"]);
    expect(c.HostConfig.Tmpfs?.["/workspace"]).toContain("size=300m");
    expect(c.HostConfig.Tmpfs?.["/tmp"]).toMatch(/noexec.*size=100m/);
    expect(c.Env).toContain("ADLC_TASK_KEY=PILOT-1");
    expect(c.Labels).toEqual({ "adlc.run-id": spec.runId, "adlc.managed": "true" });
  });

  it("FR-ORC-013 never disables seccomp, adds capabilities or mounts the host", () => {
    const text = JSON.stringify(hardenedContainerConfig(spec));
    expect(text).not.toMatch(/seccomp|unconfined|docker\.sock|SYS_ADMIN|"Privileged":true/);
  });

  it("FR-ORC-013 rejects images not pinned by digest", () => {
    for (const image of ["registry.local/adlc/agent:latest", "agent", `agent@sha256:${"a".repeat(10)}`]) {
      expect(() => { assertHardenedRunSpec({ ...spec, image }); }).toThrow(/sha256 digest/);
    }
    expect(() => { assertHardenedRunSpec({ ...spec, image: DIGEST }); }).not.toThrow(); // local image ID
  });

  it("hard rule 9: rejects credential-like env vars; only the per-run gateway token is allowed", () => {
    for (const name of ["ANTHROPIC_API_KEY", "JIRA_PASSWORD", "GITHUB_PRIVATE_KEY", "DB_SECRET", "AWS_ACCESS_KEY_ID"]) {
      expect(() => { assertHardenedRunSpec({ ...spec, env: { [name]: "x" } }); }).toThrow(/looks like a credential/);
    }
    expect(() => { assertHardenedRunSpec({ ...spec, env: { "bad-name": "x" } }); }).toThrow(/invalid env name/);
    expect(() => { assertHardenedRunSpec({ ...spec, env: { OK: "a\0b" } }); }).toThrow(/NUL/);
  });

  it("FR-ORC-013 rejects host/bridge networks, missing limits and non-UUID run IDs, listing every problem", () => {
    for (const network of ["host", "bridge", "none", "default", ""]) {
      expect(() => { assertHardenedRunSpec({ ...spec, network }); }).toThrow(/internal agent network/);
    }
    const bad = { ...spec, runId: "x", limits: { cpus: 0, memoryMb: -1, pidsLimit: 1.5, scratchMb: Number.NaN } };
    expect(() => { assertHardenedRunSpec(bad); }).toThrow(UnsafeRunSpecError);
    try {
      assertHardenedRunSpec(bad);
    } catch (e) {
      expect((e as Error).message.split("; ")).toHaveLength(5);
    }
  });
});

describe("Docker log demultiplexing", () => {
  const frame = (type: 1 | 2, text: string) => {
    const payload = Buffer.from(text, "utf8");
    const header = Buffer.alloc(8);
    header[0] = type;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };
  async function* chunks(...parts: Buffer[]) {
    for (const p of parts) {
      await Promise.resolve(); // arrive asynchronously, like a socket
      yield p;
    }
  }
  const collect = async (it: AsyncIterable<unknown>) => {
    const out: unknown[] = [];
    for await (const x of it) out.push(x);
    return out;
  };

  it("splits frames into stdout/stderr lines, across chunk and line boundaries", async () => {
    const all = Buffer.concat([frame(1, "hel"), frame(1, "lo\nwor"), frame(2, "oops\r\n"), frame(1, "ld\nlast")]);
    const lines = await collect(demuxDockerLogs(chunks(all.subarray(0, 5), all.subarray(5, 20), all.subarray(20))));
    expect(lines).toEqual([
      { stream: "stdout", line: "hello" },
      { stream: "stderr", line: "oops" },
      { stream: "stdout", line: "world" },
      { stream: "stdout", line: "last" },
    ]);
  });
});

describe("FR-ORC-013 Docker backend refusals", () => {
  type Stub = Partial<Record<"info" | "getNetwork" | "createNetwork" | "createContainer" | "getContainer", unknown>>;
  const docker = (stub: Stub) => stub as unknown as Docker;
  const info = (SecurityOptions: string[], CgroupVersion = "2") => () => Promise.resolve({ SecurityOptions, CgroupVersion });
  const network = (Internal: boolean | null) => () => ({
    inspect: () => (Internal === null ? Promise.reject(Object.assign(new Error("no such network"), { statusCode: 404 })) : Promise.resolve({ Internal })),
  });
  const rootless = ["name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"];

  it("FR-ORC-013 refuses a daemon that is not rootless, has no seccomp, or uses cgroup v1", async () => {
    const trustedImages = new Set<string>();
    await expect(DockerExecutorBackend.connect({ docker: docker({ info: info(["name=seccomp,profile=builtin"]) }), trustedImages })).rejects.toThrow(/missing rootless mode/);
    await expect(DockerExecutorBackend.connect({ docker: docker({ info: info(["name=rootless"]) }), trustedImages })).rejects.toThrow(/missing seccomp/);
    await expect(DockerExecutorBackend.connect({ docker: docker({ info: info(rootless, "1") }), trustedImages })).rejects.toBeInstanceOf(DaemonBaselineError);
    await expect(DockerExecutorBackend.connect({ docker: docker({ info: info(rootless) }), trustedImages })).resolves.toBeInstanceOf(DockerExecutorBackend);
  });

  it("FR-ORC-013 refuses untrusted images and non-internal networks before creating anything", async () => {
    const created: unknown[] = [];
    const createContainer = (o: unknown) => {
      created.push(o);
      return Promise.resolve({ id: "c1" });
    };
    const trusted = await DockerExecutorBackend.connect({ docker: docker({ info: info(rootless), getNetwork: network(true), createContainer }), trustedImages: new Set([spec.image]) });
    await expect(trusted.create({ ...spec, image: `other@${DIGEST}` })).rejects.toBeInstanceOf(UntrustedImageError);
    const open = await DockerExecutorBackend.connect({ docker: docker({ info: info(rootless), getNetwork: network(false), createContainer }), trustedImages: new Set([spec.image]) });
    await expect(open.create(spec)).rejects.toThrow(/not internal/);
    await expect(open.ensureInternalNetwork("adlc-agents")).rejects.toThrow(/exists but is not internal/);
    expect(created).toEqual([]);
    await expect(trusted.create(spec)).resolves.toEqual({ runId: spec.runId, containerId: "c1" });
  });

  it("creates the agent network as internal when it does not exist", async () => {
    const nets: unknown[] = [];
    const b = await DockerExecutorBackend.connect({
      docker: docker({ info: info(rootless), getNetwork: network(null), createNetwork: (o: unknown) => { nets.push(o); return Promise.resolve({}); } }),
      trustedImages: new Set(),
    });
    await b.ensureInternalNetwork("adlc-agents");
    expect(nets).toEqual([{ Name: "adlc-agents", Driver: "bridge", Internal: true, Labels: { "adlc.managed": "true" } }]);
  });

  it("stop, start and delete are idempotent; a missing container reports state missing", async () => {
    const err = (statusCode: number) => Promise.reject(Object.assign(new Error(String(statusCode)), { statusCode }));
    const container = { stop: () => err(304), start: () => err(304), remove: () => err(404), inspect: () => err(404) };
    const b = await DockerExecutorBackend.connect({ docker: docker({ info: info(rootless), getContainer: () => container }), trustedImages: new Set() });
    const h = { runId: spec.runId, containerId: "gone" };
    await expect(b.stop(h, "kill switch")).resolves.toBeUndefined();
    await expect(b.start(h)).resolves.toBeUndefined();
    await expect(b.delete(h)).resolves.toBeUndefined();
    await expect(b.status(h)).resolves.toMatchObject({ state: "missing", exitCode: null });
  });
});
