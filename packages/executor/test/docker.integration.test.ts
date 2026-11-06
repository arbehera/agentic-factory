import { randomUUID } from "node:crypto";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaemonBaselineError, DockerExecutorBackend, type LogLine, type RunHandle, type RunSpec } from "../src/index.js";

/**
 * FR-ORC-013 on a real rootless Docker daemon (runbook docs/runbooks/wsl2-rootless-docker.md).
 * Skipped (and reported as skipped) where no rootless daemon exists, e.g. Docker Desktop on
 * Windows; ADLC_REQUIRE_ROOTLESS_DOCKER=1 turns that into a failure for the Linux runner and CI.
 */
const docker = new Docker();
const baseline: string | null = await DockerExecutorBackend.connect({ docker, trustedImages: new Set() }).then(
  () => null,
  (e: unknown) => (e instanceof Error ? e.message : String(e)),
);
if (baseline !== null && process.env.ADLC_REQUIRE_ROOTLESS_DOCKER === "1") {
  throw new DaemonBaselineError(`ADLC_REQUIRE_ROOTLESS_DOCKER=1 but the daemon is not usable: ${baseline}`);
}

const PROBE = [
  'echo "uid=$(id -u)"',
  "echo \"capeff=$(awk '/^CapEff/{print $2}' /proc/self/status)\"",
  "echo \"nnp=$(awk '/^NoNewPrivs/{print $2}' /proc/self/status)\"",
  "echo \"seccomp=$(awk '/^Seccomp:/{print $2}' /proc/self/status)\"",
  "(touch /rootfs-probe 2>/dev/null && echo rootfs=writable) || echo rootfs=readonly",
  "(touch /workspace/p 2>/dev/null && echo workspace=writable) || echo workspace=readonly",
  "(test -e /var/run/docker.sock && echo dockersock=present) || echo dockersock=absent",
  'echo "pids=$(cat /sys/fs/cgroup/pids.max)"',
  'echo "mem=$(cat /sys/fs/cgroup/memory.max)"',
  "(nc -w 3 1.1.1.1 80 </dev/null >/dev/null 2>&1 && echo egress=open) || echo egress=blocked",
  "(nc -w 3 gw 8080 </dev/null >/dev/null 2>&1 && echo gateway=reachable) || echo gateway=unreachable",
].join("; ");

async function pullDigest(image: string): Promise<string> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
  const info = await docker.getImage(image).inspect();
  const digest = info.RepoDigests[0];
  if (!digest) throw new Error(`no repo digest for ${image}`);
  return digest;
}

async function waitExit(backend: DockerExecutorBackend, h: RunHandle, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const s = await backend.status(h);
    if (s.state === "exited" || Date.now() > end) return s;
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.skipIf(baseline !== null)(`FR-ORC-013 Docker executor on rootless Docker${baseline ? ` (skipped: ${baseline})` : ""}`, () => {
  const network = `adlc-agents-test-${randomUUID().slice(0, 8)}`;
  let image: string;
  let backend: DockerExecutorBackend;
  let peer: Docker.Container | null = null;
  const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
    runId: randomUUID(),
    image,
    env: { ADLC_TASK_KEY: "PILOT-1" },
    limits: { cpus: 0.5, memoryMb: 64, pidsLimit: 64, scratchMb: 32 },
    network,
    command: ["sh", "-c", PROBE],
    ...over,
  });

  beforeAll(async () => {
    image = await pullDigest("alpine:3.20");
    backend = await DockerExecutorBackend.connect({ docker, trustedImages: new Set([image]) });
    await backend.ensureInternalNetwork(network);
    // A stand-in for the gateway: the one service agents may reach on the internal network.
    peer = await docker.createContainer({
      Image: image,
      Cmd: ["sh", "-c", "while true; do nc -l -p 8080 </dev/null; done"],
      User: "65532:65532",
      HostConfig: { NetworkMode: network, ReadonlyRootfs: true, CapDrop: ["ALL"] },
      NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: ["gw"] } } },
    });
    await peer.start();
  });

  afterAll(async () => {
    await peer?.remove({ force: true }).catch(() => undefined);
    await docker.getNetwork(network).remove().catch(() => undefined);
  });

  it("FR-ORC-013 an agent container is unprivileged, read-only, limited, socket-free and can reach only the gateway", async () => {
    const h = await backend.create(spec());
    expect((await backend.status(h)).state).toBe("created");
    await backend.start(h);
    const s = await waitExit(backend, h);
    expect(s).toMatchObject({ state: "exited", exitCode: 0, oomKilled: false });

    const lines: LogLine[] = [];
    for await (const l of backend.logs(h, { follow: false })) lines.push(l);
    const probe: Record<string, string> = {};
    for (const l of lines) {
      const i = l.line.indexOf("=");
      if (l.stream === "stdout" && i > 0) probe[l.line.slice(0, i)] = l.line.slice(i + 1);
    }
    expect(probe).toEqual({
      uid: "65532",
      capeff: "0000000000000000",
      nnp: "1",
      seccomp: "2",
      rootfs: "readonly",
      workspace: "writable",
      dockersock: "absent",
      pids: "64",
      mem: String(64 * 1024 * 1024),
      egress: "blocked",
      gateway: "reachable",
    });

    const inspected = await docker.getContainer(h.containerId).inspect();
    expect(inspected.HostConfig).toMatchObject({ ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], NetworkMode: network, PidsLimit: 64 });
    expect(inspected.Mounts).toEqual([]);

    await backend.delete(h);
    expect((await backend.status(h)).state).toBe("missing");
  });

  it("FR-ORC-013 stop ends a running container; follow-mode logs stream until it exits", async () => {
    const h = await backend.create(spec({ command: ["sh", "-c", "echo started; sleep 300"] }));
    await backend.start(h);
    const first = await (async () => {
      for await (const l of backend.logs(h, { follow: true })) return l;
      return null;
    })();
    expect(first).toEqual({ stream: "stdout", line: "started" });
    await backend.stop(h, "kill switch");
    expect((await backend.status(h)).state).toBe("exited");
    await backend.delete(h);
  });

  it("FR-ORC-013 refuses an image outside the trusted list on the real daemon", async () => {
    const other = await pullDigest("alpine:3.19");
    await expect(backend.create(spec({ image: other }))).rejects.toThrow(/not in the trusted image list/);
  });
});
