/**
 * Pack interfaces (spec.md §7, SDD §5.4). Packs plug into the core only through these; the core
 * never calls a tool directly. Concrete types stay technology-neutral: a pack decides what a
 * "variant", "suite" or "target type" means.
 */

export type Sha = string;

export interface Component {
  name: string;
  /** Repo-relative directory prefixes owned by the component. */
  paths: readonly string[];
}

export type TestLevel = "unit" | "integration" | "system";

export interface Artifact {
  name: string;
  uri: string;
  sha256: string;
}

export interface BuildResult {
  ok: boolean;
  errors: number;
  warnings: number;
  logUri: string;
}

export interface TestResult {
  level: TestLevel;
  passed: number;
  failed: number;
  skipped: number;
  reportUri: string;
}

export interface Coverage {
  /** Percentages, 0–100. */
  statement: number;
  branch: number;
}

export type Severity = "info" | "minor" | "major" | "blocking";

export interface Finding {
  ruleId: string;
  severity: Severity;
  path: string;
  line: number;
  message: string;
  /** True when the finding is not present at the baseline commit. */
  isNew: boolean;
}

export interface BudgetField {
  name: string;
  unit: string;
  /** Measured automatically on every PR (the gate floor needs at least one, SDD §5.6). */
  automated: boolean;
}

export interface MeasureCtx {
  component: Component;
  commit: Sha;
  artifacts: readonly Artifact[];
}

export interface Measurement {
  field: string;
  value: number;
  unit: string;
  limit: number | null;
  withinBudget: boolean;
}

export interface TargetLease {
  leaseId: string;
  targetId: string;
  expiresAt: Date;
}

export interface SuiteResult {
  suite: string;
  passed: boolean;
  reportUri: string;
}

export interface Health {
  targetId: string;
  healthy: boolean;
  detail: string;
}

export interface Baseline {
  tag: string;
  commit: Sha;
}

export interface Signed {
  artifact: Artifact;
  signatureUri: string;
}

export interface ReleaseRef {
  uri: string;
}

export interface BuildAdapter {
  build(c: Component, variant: string): Promise<BuildResult>;
  test(level: TestLevel): Promise<TestResult>;
  coverage(): Promise<Coverage>;
  artifacts(): Promise<Artifact[]>;
}

export interface AnalysisAdapter {
  analyse(commit: Sha, baseline: Sha): Promise<Finding[]>;
  ruleSetVersion(): string;
}

export interface BudgetSchema {
  fields: BudgetField[];
  measure(field: string, ctx: MeasureCtx): Promise<Measurement>;
}

export interface TestTargetAdapter {
  lease(type: string, minutes: number): Promise<TargetLease>;
  deploy(l: TargetLease, a: Artifact): Promise<void>;
  run(l: TargetLease, suite: string): Promise<SuiteResult>;
  collect(l: TargetLease): Promise<Artifact[]>;
  release(l: TargetLease): Promise<void>;
  health(id: string): Promise<Health>;
}

export interface ReleaseAdapter {
  package(b: Baseline): Promise<Artifact[]>;
  /** Runs in a separate trust domain (SDD §5.4); never with build-agent credentials. */
  sign(a: Artifact[]): Promise<Signed[]>;
  publish(s: Signed[]): Promise<ReleaseRef>;
}

/** Agent skills and Spec Kit template fragments contributed by a pack (SDD §5.4). */
export interface SkillBundle {
  skills: readonly string[];
  templateFragments: readonly string[];
}
