import type { ProductProfile, ProfileComponent } from "@adlc/schemas";

/**
 * FR-PCK-001: routes a task to its profile component, and so to that component's pack.
 * SDD §5.5: "the Orchestrator routes each task to the pack of the component its paths belong to".
 * A task's `{comp:}` is used when it names a profile component; otherwise its paths decide
 * (ADR-0008, plan Q-11). All paths must belong to the chosen component — a task never spans packs.
 */

export class UnroutableTaskError extends Error {
  override name = "UnroutableTaskError";
}

export interface PackRef {
  id: string;
  version: string;
}

export function parsePackRef(ref: string): PackRef {
  const m = /^([a-z][a-z0-9-]*)@(\d+\.\d+(?:\.\d+)?)$/.exec(ref);
  if (!m?.[1] || !m[2]) throw new UnroutableTaskError(`invalid pack ref "${ref}"`);
  return { id: m[1], version: m[2] };
}

/** Component owning a repo-relative file path (profile paths never overlap, so at most one matches). */
export function componentForPath(profile: ProductProfile, filePath: string): ProfileComponent | null {
  return profile.spec.components.find((c) => c.paths.some((p) => filePath.startsWith(p))) ?? null;
}

export function routeTask(
  profile: ProductProfile,
  task: { component: string | null; paths: readonly string[] },
): ProfileComponent & { packRef: PackRef } {
  const owners = task.paths.map((p) => ({ path: p, owner: componentForPath(profile, p) }));
  const orphans = owners.filter((o) => o.owner === null).map((o) => o.path);
  if (orphans.length > 0) throw new UnroutableTaskError(`paths not owned by any component: ${orphans.join(", ")}`);

  const ownerNames = [...new Set(owners.map((o) => o.owner?.name))];
  const named = profile.spec.components.find((c) => c.name === task.component);
  const chosen = named ?? (ownerNames.length === 1 ? owners[0]?.owner : null);
  if (!chosen) {
    throw new UnroutableTaskError(
      ownerNames.length > 1
        ? `paths span components ${ownerNames.join(", ")}; split the task`
        : `component "${task.component ?? "(none)"}" is not in the product profile and the task names no paths`,
    );
  }
  const stray = owners.filter((o) => o.owner !== chosen).map((o) => o.path);
  if (stray.length > 0) throw new UnroutableTaskError(`paths outside component "${chosen.name}": ${stray.join(", ")}`);
  return { ...chosen, packRef: parsePackRef(chosen.pack) };
}
