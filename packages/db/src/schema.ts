import {
  AGENT_RUN_KINDS,
  AGENT_RUN_STATES,
  DISPATCH_ENVIRONMENTS,
  BUDGET_SCOPES,
  COMPONENT_LOCK_STATES,
  DECISION_CLASSES,
  DECISION_ROUTES,
  DECISION_STATUSES,
  GATE_IDS,
  GATE_STATUSES,
  MODEL_TIERS,
  PACK_KINDS,
  PACK_STATUSES,
  PIPELINE_STEPS,
  STEP_STATUSES,
  VERDICTS,
} from "@adlc/domain";
import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Tables for the spec.md §5 entities. Only what Jira and Git must not hold is stored (hard
 * rule 4): Jira task content is never copied, and Git-held definitions are stored as
 * references (source SHA + content hash). All times are UTC `timestamptz`.
 *
 * `audit_event` is range-partitioned, which drizzle-kit cannot express, so it is defined in
 * `audit-table.ts` and created by a hand-written migration (see ADR-0005).
 */

function oneOf(col: AnyPgColumn, values: readonly string[]): SQL {
  const list = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
  return sql`${col} in (${sql.raw(list)})`;
}

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

/** Monotonic across all tasks, so a re-acquired lease can never reuse an older token (FR-ORC-008). */
export const fencingTokenSeq = pgSequence("fencing_token_seq");
/** Source of `DEC-nnnn` numbers; the format is owned by `@adlc/domain` (formatDecisionId). */
export const decisionNumberSeq = pgSequence("decision_number_seq");

export const project = pgTable(
  "project",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    jiraProjectKey: text("jira_project_key").notNull().unique(),
    repos: jsonb("repos").$type<string[]>().notNull().default([]),
    productProfileRef: text("product_profile_ref"),
    status: text("status").notNull(),
    /** Sandbox projects use at most the sandbox slot quota and Draft packs (FR-ORC-014, FR-PCK-003). */
    environment: text("environment").notNull().default("production"),
    createdAt: createdAt(),
  },
  (t) => [check("project_environment_chk", oneOf(t.environment, DISPATCH_ENVIRONMENTS))],
);

export const productProfile = pgTable(
  "product_profile",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => project.id),
    version: text("version").notNull(),
    sourceRepo: text("source_repo").notNull(),
    sourceSha: text("source_sha").notNull(),
    contentHash: text("content_hash").notNull(),
    approvedGateId: uuid("approved_gate_id"),
    loadedAt: createdAt(),
  },
  (t) => [unique("product_profile_version_uq").on(t.projectId, t.version)],
);

export const packVersion = pgTable(
  "pack_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packId: text("pack_id").notNull(),
    kind: text("kind").notNull(),
    semver: text("semver").notNull(),
    status: text("status").notNull().default("Draft"),
    imageDigest: text("image_digest"),
    /** Hash of the canonical manifest; a released pack version is immutable. */
    contentHash: text("content_hash").notNull(),
    ownerId: text("owner_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("pack_version_uq").on(t.packId, t.semver),
    check("pack_version_kind_chk", oneOf(t.kind, PACK_KINDS)),
    check("pack_version_status_chk", oneOf(t.status, PACK_STATUSES)),
    check("pack_version_digest_chk", sql`${t.imageDigest} is null or ${t.imageDigest} ~ '^sha256:[0-9a-f]{64}$'`),
  ],
);

export const agentDefinition = pgTable(
  "agent_definition",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    role: text("role").notNull(),
    tier: text("tier").notNull(),
    modelId: text("model_id").notNull(),
    autonomyLevel: integer("autonomy_level").notNull(),
    ownerRole: text("owner_role").notNull(),
    release: text("release").notNull(),
    sourceSha: text("source_sha").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("agent_definition_version_uq").on(t.name, t.version),
    check("agent_definition_tier_chk", oneOf(t.tier, MODEL_TIERS)),
  ],
);

export const agentRun = pgTable(
  "agent_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentDefinitionId: uuid("agent_definition_id").notNull().references(() => agentDefinition.id),
    projectId: uuid("project_id").notNull().references(() => project.id),
    kind: text("kind").notNull(),
    taskKey: text("task_key"),
    componentPack: text("component_pack"),
    step: text("step"),
    state: text("state").notNull().default("queued"),
    containerId: text("container_id"),
    startedAt: ts("started_at"),
    heartbeatAt: ts("heartbeat_at"),
    endedAt: ts("ended_at"),
    tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
    tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 14, scale: 4 }).notNull().default("0"),
    exitReason: text("exit_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    check("agent_run_kind_chk", oneOf(t.kind, AGENT_RUN_KINDS)),
    check("agent_run_state_chk", oneOf(t.state, AGENT_RUN_STATES)),
    index("agent_run_task_idx").on(t.taskKey),
    index("agent_run_project_state_idx").on(t.projectId, t.state),
  ],
);

export const lease = pgTable(
  "lease",
  {
    taskKey: text("task_key").primaryKey(),
    runId: uuid("run_id").notNull().references(() => agentRun.id),
    fencingToken: bigint("fencing_token", { mode: "bigint" }).notNull().default(sql`nextval('fencing_token_seq')`),
    acquiredAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
    /** Wall-clock cap from the task budget (S 1 h, M 4 h, L 8 h); renewals never pass it. */
    deadlineAt: ts("deadline_at").notNull(),
  },
  (t) => [
    check("lease_expiry_chk", sql`${t.expiresAt} <= ${t.deadlineAt}`),
    index("lease_expires_idx").on(t.expiresAt),
  ],
);

export const componentLock = pgTable(
  "component_lock",
  {
    projectId: uuid("project_id").notNull().references(() => project.id),
    component: text("component").notNull(),
    state: text("state").notNull(),
    taskKey: text("task_key").notNull(),
    acquiredAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "component_lock_pk", columns: [t.projectId, t.component] }),
    check("component_lock_state_chk", oneOf(t.state, COMPONENT_LOCK_STATES)),
  ],
);

export const stepRecord = pgTable(
  "step_record",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id").notNull().references(() => agentRun.id),
    step: text("step").notNull(),
    status: text("status").notNull(),
    startedAt: ts("started_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
    wipCommitSha: text("wip_commit_sha"),
    errorSignature: text("error_signature"),
  },
  (t) => [
    check("step_record_status_chk", oneOf(t.status, STEP_STATUSES)),
    // Pipeline steps S0–S12 or a Spec Kit command name (spec.md §5).
    check("step_record_step_chk", sql`${oneOf(t.step, PIPELINE_STEPS)} or ${t.step} ~ '^[a-z][a-z0-9.-]*$'`),
    index("step_record_run_idx").on(t.runId),
    index("step_record_error_idx").on(t.errorSignature),
  ],
);

export const decision = pgTable(
  "decision",
  {
    /** `DEC-nnnn`, formatted by `formatDecisionId(nextval('decision_number_seq'))` in code. */
    id: text("id").primaryKey(),
    projectId: uuid("project_id").notNull().references(() => project.id),
    taskKey: text("task_key"),
    class: text("class").notNull(),
    route: text("route").notNull(),
    question: text("question").notNull(),
    options: jsonb("options").$type<string[]>().notNull().default([]),
    owner: text("owner").notNull(),
    /** `<actor kind>:<id>` of whoever raised it; a run may never answer its own Decision. */
    raisedBy: text("raised_by").notNull(),
    timeboxMinutes: integer("timebox_minutes").notNull(),
    dueAt: ts("due_at").notNull(),
    reversible: boolean("reversible").notNull(),
    autoResolve: boolean("auto_resolve").notNull().default(false),
    status: text("status").notNull().default("open"),
    escalationLevel: integer("escalation_level").notNull().default(0),
    outcome: text("outcome"),
    decidedBy: text("decided_by"),
    decidedAt: ts("decided_at"),
    jiraKey: text("jira_key"),
    createdAt: createdAt(),
  },
  (t) => [
    check("decision_class_chk", oneOf(t.class, DECISION_CLASSES)),
    check("decision_route_chk", oneOf(t.route, DECISION_ROUTES)),
    check("decision_id_chk", sql`${t.id} ~ '^DEC-[0-9]{4,}$'`),
    check("decision_status_chk", oneOf(t.status, DECISION_STATUSES)),
    // spec.md §5 invariants, enforced again in the database (defence in depth for hard rule 2).
    check("decision_gate_chk", sql`${t.class} <> 'gate' or (not ${t.reversible} and not ${t.autoResolve})`),
    check("decision_auto_resolve_chk", sql`not ${t.autoResolve} or ${t.class} = 'consult'`),
    index("decision_open_due_idx").on(t.status, t.dueAt),
  ],
);

export const gate = pgTable(
  "gate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => project.id),
    gate: text("gate").notNull(),
    scope: text("scope").notNull(),
    jiraGateKey: text("jira_gate_key"),
    prRef: text("pr_ref"),
    readinessReportRef: text("readiness_report_ref"),
    status: text("status").notNull().default("Open"),
    approvedBy: jsonb("approved_by").$type<string[]>().notNull().default([]),
    approvedAt: ts("approved_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("gate_scope_uq").on(t.projectId, t.gate, t.scope),
    check("gate_id_chk", oneOf(t.gate, GATE_IDS)),
    check("gate_status_chk", oneOf(t.status, GATE_STATUSES)),
  ],
);

export interface ReviewerVerdictRef {
  role: string;
  tier: string;
  verdictHash: string;
  modelCallId: string;
}

/**
 * Model calls the gateway proxied, one row per provider response (FR-EVD-002 condition c).
 * Append-only (migration 0010). Only hashes of the request and response are kept here.
 */
export const modelCall = pgTable(
  "model_call",
  {
    id: text("id").primaryKey(),
    runId: uuid("run_id").notNull().references(() => agentRun.id),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    requestHash: text("request_hash").notNull(),
    responseHash: text("response_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("model_call_run_idx").on(t.runId)],
);

/**
 * Reviewer verdicts (FR-EVD-001), written through the gateway under the adlc-reviewer identity.
 * Write-once (migration 0010): one verdict per reviewer role per PR head; a new push needs new
 * verdicts on the new head.
 */
export const reviewerVerdict = pgTable(
  "reviewer_verdict",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => project.id),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    reviewerRole: text("reviewer_role").notNull(),
    reviewerRunId: uuid("reviewer_run_id").notNull().references(() => agentRun.id),
    verdict: text("verdict").notNull(),
    summary: text("summary").notNull(),
    modelCallId: text("model_call_id").notNull().references(() => modelCall.id),
    verdictHash: text("verdict_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("reviewer_verdict_head_role_uq").on(t.repo, t.prNumber, t.headSha, t.reviewerRole),
    // A model call backs at most one verdict (FR-EVD-002 c): no reusing one call for many reviews.
    unique("reviewer_verdict_model_call_uq").on(t.modelCallId),
    check("reviewer_verdict_value_chk", oneOf(t.verdict, VERDICTS)),
    check("reviewer_verdict_sha_chk", sql`${t.headSha} ~ '^[0-9a-f]{40}$'`),
  ],
);

/** Signed review evidence (FR-EVD-002). Write-once (migration 0010). */
export const evidenceRecord = pgTable(
  "evidence_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => project.id),
    repo: text("repo").notNull(),
    authorRole: text("author_role").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    mergeGroupSha: text("merge_group_sha"),
    patchId: text("patch_id").notNull(),
    reviewerVerdicts: jsonb("reviewer_verdicts").$type<ReviewerVerdictRef[]>().notNull().default([]),
    checkResults: jsonb("check_results").$type<unknown[]>().notNull().default([]),
    /** DSSE envelope; moves to the object store with the WORM export (ADR-0006). */
    envelope: jsonb("envelope").$type<Record<string, unknown>>().notNull(),
    envelopeRef: text("envelope_ref"),
    status: text("status").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("evidence_pr_head_idx").on(t.projectId, t.prNumber, t.headSha),
    uniqueIndex("evidence_head_uq").on(t.repo, t.prNumber, t.headSha).where(sql`${t.mergeGroupSha} is null`),
  ],
);

export const traceNode = pgTable(
  "trace_node",
  {
    projectId: uuid("project_id").notNull().references(() => project.id),
    id: text("id").notNull(),
    type: text("type").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    supersedes: jsonb("supersedes").$type<string[]>().notNull().default([]),
  },
  (t) => [primaryKey({ name: "trace_node_pk", columns: [t.projectId, t.id] })],
);

export const traceLink = pgTable(
  "trace_link",
  {
    projectId: uuid("project_id").notNull().references(() => project.id),
    fromId: text("from_id").notNull(),
    rel: text("rel").notNull(),
    toId: text("to_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "trace_link_pk", columns: [t.projectId, t.fromId, t.rel, t.toId] }),
    index("trace_link_to_idx").on(t.projectId, t.toId),
  ],
);

/**
 * Notifications for manual intervention (FR-NOT-001/002, SDD §16.3). Producers insert an event with
 * an audience (outbox); the notifier resolves recipients from the rota, sets the deadline, delivers
 * (portal inbox + email) and escalates until someone acknowledges. Duplicates of an unacknowledged
 * event merge on the dedupe key.
 */
export const notification = pgTable(
  "notification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").references(() => project.id),
    event: text("event").notNull(),
    severity: text("severity").notNull(),
    /** Who must act, resolved through the rota: `role:<role>` or `gate:<gate>`. */
    audience: text("audience").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    link: text("link").notNull(),
    /** Current recipients (the escalation level's people); empty until routed. */
    recipients: jsonb("recipients").$type<string[]>().notNull().default([]),
    channel: text("channel").notNull().default("inbox+email"),
    dedupeKey: text("dedupe_key"),
    routedAt: ts("routed_at"),
    dueAt: ts("due_at"),
    sentAt: ts("sent_at"),
    /** Highest escalation level that has been delivered; -1 before the first delivery. */
    sentLevel: integer("sent_level").notNull().default(-1),
    ackBy: text("ack_by"),
    ackAt: ts("ack_at"),
    escalationLevel: integer("escalation_level").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("notification_unacked_idx").on(t.ackAt, t.createdAt),
    uniqueIndex("notification_open_dedupe_uq").on(t.dedupeKey).where(sql`${t.ackAt} is null`),
  ],
);

export const budgetLedger = pgTable(
  "budget_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    scopeKey: text("scope_key").notNull(),
    tokens: bigint("tokens", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 14, scale: 4 }).notNull().default("0"),
    capUsd: numeric("cap_usd", { precision: 14, scale: 4 }),
    capTokens: bigint("cap_tokens", { mode: "number" }),
    updatedAt: createdAt(),
  },
  (t) => [
    unique("budget_ledger_scope_uq").on(t.scope, t.scopeKey),
    check("budget_ledger_scope_chk", oneOf(t.scope, BUDGET_SCOPES)),
  ],
);

export const testTargetLease = pgTable(
  "test_target_lease",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetId: text("target_id").notNull(),
    pack: text("pack").notNull(),
    runId: uuid("run_id").notNull().references(() => agentRun.id),
    expiresAt: ts("expires_at").notNull(),
    health: text("health").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("test_target_lease_target_idx").on(t.targetId, t.expiresAt)],
);

/**
 * Orchestrator-wide switches shared by all replicas, e.g. the kill switch (FR-ORC-012).
 * Not a spec.md §5 entity: it holds control-plane state only (ADR-0009).
 */
export const controlFlag = pgTable("control_flag", {
  key: text("key").primaryKey(),
  enabled: boolean("enabled").notNull(),
  reason: text("reason").notNull(),
  setBy: text("set_by").notNull(),
  setAt: ts("set_at").notNull(),
});

/**
 * Per-run gateway credentials (ADR-0010). Only the SHA-256 of the bearer token is stored; the
 * token itself is handed to the run's container once and never logged.
 */
export const gatewaySession = pgTable(
  "gateway_session",
  {
    tokenHash: text("token_hash").primaryKey(),
    runId: uuid("run_id").notNull().references(() => agentRun.id),
    role: text("role").notNull(),
    projectId: uuid("project_id").notNull().references(() => project.id),
    taskKey: text("task_key"),
    fencingToken: bigint("fencing_token", { mode: "bigint" }),
    /** Review sessions are bound to the one PR head they review (all three set, or none). */
    reviewRepo: text("review_repo"),
    reviewPrNumber: integer("review_pr_number"),
    reviewHeadSha: text("review_head_sha"),
    issuedAt: ts("issued_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    index("gateway_session_run_idx").on(t.runId),
    check("gateway_session_fence_chk", sql`(${t.taskKey} is null) = (${t.fencingToken} is null)`),
    check(
      "gateway_session_review_chk",
      sql`(${t.reviewRepo} is null) = (${t.reviewPrNumber} is null) and (${t.reviewPrNumber} is null) = (${t.reviewHeadSha} is null)`,
    ),
  ],
);

/**
 * PostgreSQL job queue (hard rule 8: no broker). Workers claim with FOR UPDATE SKIP LOCKED and
 * hold a time-limited lock; a crashed worker's job becomes claimable again when the lock lapses.
 */
export const job = pgTable(
  "job",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** Enqueue is idempotent per key (e.g. `start-run:<runId>`). */
    dedupeKey: text("dedupe_key").unique(),
    runAfter: ts("run_after").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lockedBy: text("locked_by"),
    lockedUntil: ts("locked_until"),
    lastError: text("last_error"),
    doneAt: ts("done_at"),
    failedAt: ts("failed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("job_ready_idx").on(t.runAfter).where(sql`${t.doneAt} is null and ${t.failedAt} is null`)],
);
