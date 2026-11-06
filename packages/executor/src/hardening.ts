import type Docker from "dockerode";
import type { RunSpec } from "./backend.js";

/**
 * The container security baseline (hard rule 6, FR-ORC-013). Every agent container is built from
 * `hardenedContainerConfig`, and every RunSpec must pass `assertHardenedRunSpec` first — there is
 * no option to relax any of this.
 */

/** Unprivileged numeric user; never root, even inside the user namespace. */
export const AGENT_USER = "65532:65532";
export const RUN_ID_LABEL = "adlc.run-id";
export const MANAGED_LABEL = "adlc.managed";

const DIGEST_IMAGE_RE = /^(?:[a-z0-9]+(?:[._/:-][a-z0-9]+)*@)?sha256:[0-9a-f]{64}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
/** Names that suggest a credential; the per-run gateway session token is the only exception. */
const SECRET_LIKE_RE = /(SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL|ACCESS_KEY|AUTH_TOKEN)/;
export const GATEWAY_TOKEN_ENV = "ADLC_GATEWAY_TOKEN";
const RESERVED_NETWORKS = new Set(["host", "bridge", "default", "none"]);

export class UnsafeRunSpecError extends Error {
  override name = "UnsafeRunSpecError";
}

export function assertHardenedRunSpec(spec: RunSpec): void {
  const problems: string[] = [];
  if (!/^[0-9a-f-]{36}$/.test(spec.runId)) problems.push(`runId must be a UUID, got "${spec.runId}"`);
  if (!DIGEST_IMAGE_RE.test(spec.image)) problems.push(`image must be referenced by sha256 digest, got "${spec.image}"`);
  for (const [name, value] of Object.entries(spec.env)) {
    if (!ENV_NAME_RE.test(name)) problems.push(`invalid env name "${name}"`);
    else if (name !== GATEWAY_TOKEN_ENV && SECRET_LIKE_RE.test(name)) problems.push(`env "${name}" looks like a credential; secrets never enter agent containers (hard rule 9)`);
    if (value.includes("\0")) problems.push(`env "${name}" contains a NUL byte`);
  }
  const l = spec.limits;
  const positive = (n: number, what: string) => {
    if (!Number.isFinite(n) || n <= 0) problems.push(`${what} must be a positive number`);
  };
  positive(l.cpus, "limits.cpus");
  positive(l.memoryMb, "limits.memoryMb");
  positive(l.scratchMb, "limits.scratchMb");
  if (!Number.isInteger(l.pidsLimit) || l.pidsLimit <= 0) problems.push("limits.pidsLimit must be a positive integer");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(spec.network) || RESERVED_NETWORKS.has(spec.network)) {
    problems.push(`network must be the internal agent network, not "${spec.network}"`);
  }
  if (problems.length > 0) throw new UnsafeRunSpecError(`unsafe run spec: ${problems.join("; ")}`);
}

/** Docker Engine API container-create body for a run (dockerode `ContainerCreateOptions`). */
export function hardenedContainerConfig(spec: RunSpec): Docker.ContainerCreateOptions & { HostConfig: Docker.HostConfig } {
  assertHardenedRunSpec(spec);
  const mb = 1024 * 1024;
  // Scratch space is split 3:1 between the workspace and /tmp; both are in-memory and size-capped.
  const workspaceMb = Math.max(1, Math.floor((spec.limits.scratchMb * 3) / 4));
  const tmpMb = Math.max(1, spec.limits.scratchMb - workspaceMb);
  return {
    name: `adlc-run-${spec.runId}`,
    Image: spec.image,
    Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    ...(spec.command ? { Cmd: [...spec.command] } : {}),
    User: AGENT_USER,
    WorkingDir: "/workspace",
    Labels: { [RUN_ID_LABEL]: spec.runId, [MANAGED_LABEL]: "true" },
    NetworkDisabled: false,
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd: [],
      // The daemon's default seccomp profile applies because no seccomp option is given.
      SecurityOpt: ["no-new-privileges:true"],
      Binds: [],
      Mounts: [],
      Tmpfs: {
        "/workspace": `rw,nosuid,nodev,size=${workspaceMb}m,uid=65532,gid=65532,mode=0700`,
        "/tmp": `rw,noexec,nosuid,nodev,size=${tmpMb}m,uid=65532,gid=65532,mode=0700`,
      },
      Memory: spec.limits.memoryMb * mb,
      MemorySwap: spec.limits.memoryMb * mb, // no swap beyond the memory limit
      NanoCpus: Math.round(spec.limits.cpus * 1e9),
      PidsLimit: spec.limits.pidsLimit,
      NetworkMode: spec.network,
      IpcMode: "private",
      Init: true,
      RestartPolicy: { Name: "no" },
      AutoRemove: false,
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
  };
}
