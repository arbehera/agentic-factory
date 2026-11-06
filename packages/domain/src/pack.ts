import { InvalidTransitionError } from "./errors.js";
import { defineMachine } from "./state-machine.js";
import type { Actor, PackStatus } from "./vocabulary.js";

/**
 * Pack lifecycle (FR-PCK-003, SDD §5.7):
 *  Draft       being built — sandbox use only
 *  Qualified   validated and approved — production projects
 *  Restricted  a qualification item lapsed — running tasks finish, no new dispatch until re-qualified
 *  Retired     read-only evidence
 */
export const packStatusMachine = defineMachine<PackStatus>("pack-status", {
  Draft: ["Qualified", "Retired"],
  Qualified: ["Restricted", "Retired"],
  Restricted: ["Qualified", "Retired"],
  Retired: [],
});

export const DISPATCH_ENVIRONMENTS = ["sandbox", "production"] as const;
export type DispatchEnvironment = (typeof DISPATCH_ENVIRONMENTS)[number];

/** Whether a task may be newly dispatched on a pack in this status (FR-PCK-003). */
export function packAllowsNewDispatch(status: PackStatus, env: DispatchEnvironment): boolean {
  return status === "Qualified" || (status === "Draft" && env === "sandbox");
}

/** Qualification needs the Pack Owner and the Process/QMS Owner: two distinct humans (SDD §5.7). */
export const PACK_QUALIFICATION_APPROVALS = 2;

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function assertPackTransition(
  from: PackStatus,
  to: PackStatus,
  ctx: { actors: readonly Actor[]; imageDigest: string | null },
): void {
  packStatusMachine.assertTransition(from, to);
  if (ctx.actors.length === 0) throw new InvalidTransitionError("pack-status", from, to, "an actor is required");
  if (to !== "Qualified") return;
  if (ctx.imageDigest === null || !DIGEST_RE.test(ctx.imageDigest)) {
    throw new InvalidTransitionError("pack-status", from, to, "toolchain image must be referenced by sha256 digest");
  }
  const humans = new Set(ctx.actors.filter((a) => a.kind === "human").map((a) => a.id));
  if (humans.size < PACK_QUALIFICATION_APPROVALS || ctx.actors.some((a) => a.kind !== "human")) {
    throw new InvalidTransitionError(
      "pack-status",
      from,
      to,
      `qualification needs ${PACK_QUALIFICATION_APPROVALS} distinct human approvers and no automated actor`,
    );
  }
}
