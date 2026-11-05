# 0008 — Pack manifests, product profile, registry and task routing
Status: Proposed (confirm at Phase 0 review)   Date: 2026-11-05   Requirements: FR-PCK-001, FR-PCK-003

## Context
spec.md §6 lists the manifest fields without types. SDD §5.5 shows a profile example, and SDD §5.7 the lifecycle. Several points are left open.

## Decision
1. **Contracts** live in `@adlc/schemas` with strict keys. JSON Schemas are exported to `packages/schemas/json-schema/`.
   - **Tech pack:** the §6 fields, plus:
     - `image {name, digest|null}`. A digest is required to qualify (hard rule 6).
     - `budgetSchema.fields[{name, unit, automated}]`.
     - `dodThresholds {coverage{statement, branch}, complexity?}`.
     - Every SDD §5.3 mandatory element must be present and non-empty. Adapter and skill paths must stay inside the pack directory.
   - **Process pack:** the §6 fields. `gateMapping` may only reference declared processes.
   - **Profile:** the SDD §5.5 shape, plus a required `metadata.version` (plan Q-12).
     - Component names are unique.
     - `thresholds` and `testTargets` keys must be known components.
     - **Component paths may not overlap**, so routing by path is never ambiguous.
2. **YAML loading.** Profiles and manifests are untrusted input (hard rule 10). Aliases (`maxAliasCount: 0`) and duplicate keys are rejected, and all issues are reported with field paths.
3. **Pack refs.** `id@X.Y.Z` pins one version. `id@X.Y` (the form in SDD §5.5) resolves to the highest X.Y.* patch that may take new dispatches in the environment.
4. **Lifecycle** (`@adlc/domain`):
   - Transitions: Draft → Qualified | Retired; Qualified → Restricted | Retired; Restricted → Qualified | Retired.
   - Reaching Qualified needs a sha256 image digest and two distinct human approvers (Pack Owner + Process/QMS Owner), with no automated actor. Role checks come with Keycloak RBAC (P0-WP6).
   - New dispatch: Qualified in any environment; Draft in the sandbox only; never Restricted or Retired.
5. **Registry.** `PackVersionRepository` treats a registered `packId@semver` as immutable (content hash). Re-registering identical content is a no-op; different content is a conflict. Each status change is written atomically with an audit event that names all approvers.
6. **Routing** (plan Q-11). A task goes to the profile component named by `{comp:}` if that is a profile component name; otherwise to the single component that owns all of its paths. Tasks spanning components, or touching paths no component owns, are refused.

## Consequences
The orchestrator (P0-WP3) gets one call for "which pack, and may we dispatch": `routeTask` + `resolveForDispatch`. Adapter contract-test suites are written with the first adapter implementation.
