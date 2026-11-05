import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DockerExecutorBackend, RUN_EXIT_CODES, type LogLine } from "@adlc/executor";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The real agent image under the real hardened executor (hard rule 6), on rootless Docker.
 * Skipped without a rootless daemon unless ADLC_REQUIRE_ROOTLESS_DOCKER=1 (see the executor tests).
 */
const run = promisify(execFile);
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docker = new Docker();
const baseline: string | null = await DockerExecutorBackend.connect({ docker, trustedImages: new Set() }).then(
  () => null,
  (e: unknown) => (e instanceof Error ? e.message : String(e)),
);
if (baseline !== null && process.env.ADLC_REQUIRE_ROOTLESS_DOCKER === "1") throw new Error(`rootless Docker required: ${baseline}`);

async function pullDigest(image: string): Promise<string> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
  const digest = (await docker.getImage(image).inspect()).RepoDigests[0];
  if (!digest) throw new Error(`no digest for ${image}`);
  return digest;
}

describe.skipIf(baseline !== null)(`P0-WP4 agent image on rootless Docker${baseline ? ` (skipped: ${baseline})` : ""}`, () => {
  const network = `adlc-agents-img-${randomUUID().slice(0, 8)}`;
  let imageId: string;
  let backend: DockerExecutorBackend;

  beforeAll(async () => {
    await run(process.execPath, ["scripts/bundle.mjs"], { cwd: pkgDir });
    const base = await pullDigest("node:22-alpine");
    const { stdout } = await run("docker", ["build", "--quiet", "--build-arg", `BASE_IMAGE=${base}`, pkgDir], { cwd: pkgDir, maxBuffer: 10_000_000 });
    imageId = stdout.trim();
    backend = await DockerExecutorBackend.connect({ docker, trustedImages: new Set([imageId]) });
    await backend.ensureInternalNetwork(network);
  }, 600_000);

  afterAll(async () => {
    await docker.getNetwork(network).remove().catch(() => undefined);
  });

  it("the Dockerfile refuses a base image that is not pinned by digest", async () => {
    await expect(run("docker", ["build", "--quiet", "--build-arg", "BASE_IMAGE=node:22-alpine", pkgDir], { cwd: pkgDir })).rejects.toThrow(/pinned by digest/);
  });

  it("FR-ORC-013 the agent image runs under the hardened executor and fails cleanly with no gateway on its network", async () => {
    expect(imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
    const runId = randomUUID();
    const h = await backend.create({
      runId,
      image: imageId,
      network,
      limits: { cpus: 0.5, memoryMb: 128, pidsLimit: 64, scratchMb: 32 },
      env: {
        ADLC_GATEWAY_URL: "http://adlc-gateway:3001",
        ADLC_GATEWAY_TOKEN: "test-session-token-not-a-secret",
        ADLC_RUN_ID: runId,
        ADLC_TASK_KEY: "PILOT-1",
        ADLC_ROLE: "dummy",
        ADLC_REPO: "org/product",
      },
    });
    await backend.start(h);
    let status = await backend.status(h);
    for (let i = 0; i < 300 && status.state !== "exited"; i++) {
      await new Promise((r) => setTimeout(r, 200));
      status = await backend.status(h);
    }
    const lines: LogLine[] = [];
    for await (const l of backend.logs(h, { follow: false })) lines.push(l);
    const log = lines.map((l) => l.line).join("\n");
    expect(status).toMatchObject({ state: "exited", exitCode: RUN_EXIT_CODES.failed, oomKilled: false });
    expect(log).toContain('"msg":"run failed"');
    expect(log).toContain("GatewayUnavailableError");
    expect(log).not.toContain("test-session-token-not-a-secret");
    await backend.delete(h);
  });
});
