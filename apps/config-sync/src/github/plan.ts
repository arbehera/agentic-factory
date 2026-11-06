import { canonicalJson } from "@adlc/domain";
import type { GithubRepoConfig } from "@adlc/schemas";
import { renderCodeowners, renderRulesets, type AppIds, type RulesetBody } from "./rulesets.js";

export const MANAGED_PREFIX = "adlc-";
export const CODEOWNERS_PATH = ".github/CODEOWNERS";

/** What the repository looks like now (read live, or assumed for an offline plan). */
export interface GithubActualState {
  ownerType: "User" | "Organization";
  /** No commits yet, so there is no default branch to protect. */
  empty: boolean;
  rulesets: (RulesetBody & { id: number })[];
  /** CODEOWNERS on the default branch; null when absent. */
  codeowners: string | null;
}

export type GithubAction =
  | { kind: "bootstrap-default-branch"; branch: string; files: { path: string; content: string }[] }
  | { kind: "create-ruleset"; body: RulesetBody }
  | { kind: "update-ruleset"; id: number; body: RulesetBody; changed: string[] }
  | { kind: "delete-ruleset"; id: number; name: string };

export interface GithubPlan {
  repo: string;
  actions: GithubAction[];
  unchanged: string[];
  /** Rulesets this tool does not own; reported, never changed. */
  unmanaged: string[];
  /** Changes a human makes by PR because main is protected (the tool has no bypass either). */
  manual: string[];
  /** Must be resolved by a human before `apply`; apply refuses while any remain. */
  blockers: string[];
  warnings: string[];
}

/** A ruleset as the API returns it, reduced to the fields this tool manages. */
export function normalizeRuleset(r: Record<string, unknown>): RulesetBody & { id: number } {
  const ref = ((r.conditions as { ref_name?: { include?: string[]; exclude?: string[] } } | undefined)?.ref_name ?? {});
  return {
    id: Number(r.id),
    name: String(r.name),
    target: r.target as RulesetBody["target"],
    enforcement: r.enforcement as RulesetBody["enforcement"],
    bypass_actors: ((r.bypass_actors as RulesetBody["bypass_actors"] | undefined) ?? []).map(({ actor_id, actor_type, bypass_mode }) => ({ actor_id, actor_type, bypass_mode })),
    conditions: { ref_name: { include: ref.include ?? [], exclude: ref.exclude ?? [] } },
    rules: (r.rules as RulesetBody["rules"] | undefined) ?? [],
  };
}

/** Order-insensitive comparison form: rules by type, ref patterns and actors sorted. */
function comparable(b: RulesetBody): Record<string, string> {
  const sorted = <T>(xs: T[], key: (x: T) => string) => [...xs].sort((x, y) => key(x).localeCompare(key(y)));
  return {
    target: b.target,
    enforcement: b.enforcement,
    bypass_actors: canonicalJson(sorted(b.bypass_actors, (a) => `${a.actor_type}:${a.actor_id}`)),
    conditions: canonicalJson({ include: [...b.conditions.ref_name.include].sort(), exclude: [...b.conditions.ref_name.exclude].sort() }),
    rules: canonicalJson(sorted(b.rules, (x) => x.type).map((x) => ({ type: x.type, parameters: x.parameters ?? {} }))),
  };
}

export function planGithub(config: GithubRepoConfig, actual: GithubActualState, apps: AppIds): GithubPlan {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const manual: string[] = [];
  const mergeQueue = config.main.mergeQueue.required && actual.ownerType === "Organization";
  if (config.main.mergeQueue.required && !mergeQueue) {
    blockers.push(
      "main requires a merge queue (FR-GH-001), but GitHub offers merge queues only on organization-owned repositories (OPEN-14). Decide: move the repository into an organization, or accept main without a merge queue in the sandbox and record the deviation.",
    );
  }
  if (apps.ci === null) blockers.push("the CI App ID is unknown (ADLC_CI_APP_ID): required checks would accept a status from any identity");
  for (const p of config.main.pendingStatusChecks) warnings.push(`${p.context} is required by FR-GH-001 but not posted until ${p.postedFrom}; it is not required yet`);

  const desired = renderRulesets(config, apps, { mergeQueue });
  const actions: GithubAction[] = [];
  const codeowners = renderCodeowners(config);
  if (actual.empty) {
    // Before any ruleset: once main is protected, nobody (this tool included) can push to it.
    actions.push({ kind: "bootstrap-default-branch", branch: config.defaultBranch, files: [{ path: CODEOWNERS_PATH, content: codeowners }] });
  } else if (actual.codeowners !== codeowners) {
    manual.push(`${CODEOWNERS_PATH} differs from the manifest: open a PR with the rendered content (main is protected)`);
  }

  const unchanged: string[] = [];
  const byName = new Map(actual.rulesets.map((r) => [r.name, r]));
  for (const body of desired) {
    const current = byName.get(body.name);
    if (!current) {
      actions.push({ kind: "create-ruleset", body });
      continue;
    }
    const want = comparable(body);
    const have = comparable(current);
    const changed = Object.keys(want).filter((k) => want[k] !== have[k]);
    if (changed.length === 0) unchanged.push(body.name);
    else actions.push({ kind: "update-ruleset", id: current.id, body, changed });
  }
  const desiredNames = new Set(desired.map((d) => d.name));
  const unmanaged: string[] = [];
  for (const r of actual.rulesets) {
    if (desiredNames.has(r.name)) continue;
    if (r.name.startsWith(MANAGED_PREFIX)) actions.push({ kind: "delete-ruleset", id: r.id, name: r.name });
    else unmanaged.push(r.name);
  }
  if (unmanaged.length > 0) warnings.push(`rulesets not managed here (left as they are): ${unmanaged.join(", ")}`);
  return { repo: config.repo, actions, unchanged, unmanaged, manual, blockers, warnings };
}

/** Plain-text rendering of a plan for review (the "dry-run output" of CLAUDE.md §8). */
export function renderGithubPlan(plan: GithubPlan): string {
  const out = [`GitHub plan for ${plan.repo}`];
  if (plan.actions.length === 0) out.push("  no changes");
  for (const a of plan.actions) {
    if (a.kind === "bootstrap-default-branch") out.push(`  + create ${a.branch} with ${a.files.map((f) => f.path).join(", ")}`);
    else if (a.kind === "create-ruleset") out.push(`  + ruleset ${a.body.name} (${a.body.target}; rules: ${a.body.rules.map((r) => r.type).join(", ")}; bypass: ${a.body.bypass_actors.length === 0 ? "none" : "repository admin"})`);
    else if (a.kind === "update-ruleset") out.push(`  ~ ruleset ${a.body.name} #${a.id} (changed: ${a.changed.join(", ")})`);
    else out.push(`  - ruleset ${a.name} #${a.id} (managed, no longer in the manifest)`);
  }
  for (const n of plan.unchanged) out.push(`  = ruleset ${n}`);
  for (const m of plan.manual) out.push(`  MANUAL: ${m}`);
  for (const b of plan.blockers) out.push(`  BLOCKER: ${b}`);
  for (const w of plan.warnings) out.push(`  note: ${w}`);
  return `${out.join("\n")}\n`;
}
