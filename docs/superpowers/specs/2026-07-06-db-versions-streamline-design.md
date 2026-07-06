# v1.2 — Database & Versions Streamline

**Date:** 2026-07-06
**Branch:** v-1.2
**Approved direction:** DB-centric workbench · default switch behavior `auto` · Odoo-version auto-detection from Postgres · single-prompt version creation · silent auto-migration of legacy data/settings.

## Problem

The database and versions features work but are convoluted:

- A database carries four overlapping notions of "which code runs against me": `versionId`, the legacy `odooVersion` string, a free-text `branchName` label, and `projectRepoBranches`.
- Two separate switch pipelines exist with different prompts: `handleDatabaseVersionSwitch` (+ `promptBranchSwitch`) in `dbs.ts` on DB selection, and `maybeSwitchBranchForActivatedVersion` in `extension.ts` on version activation.
- `odooDebugger.databaseSwitchBehavior` has four values (`ask`, `auto-both`, `auto-version-only`, `auto-branch-only`) and `ask` opens a blocking three-option quick-pick on every DB selection.
- DB creation is ~6 sequential prompts (method → modules → branch label → version → per-repo branch mapping → …). Connecting to an existing DB requires typing its name even though the code can list Postgres databases.
- Version creation is ~6 prompts (name, three path pickers with sub-menus, branch, activate) even though paths virtually always come from `odooDebugger.defaultVersion.*`.

## Design

### Mental model

**A database carries its full environment** — a Version (settings profile + core branch) and per-project-repo branches. **Selecting a database aligns the workbench to it** through one switch engine, with a single progress notification and summary. Creation flows only ask what cannot be inferred.

### 1. Unified switch engine — `src/services/environmentService.ts`

```ts
interface EnvironmentTarget {
    versionId?: string;                                // Version to activate
    coreBranch?: string;                               // branch for odoo/enterprise/design-themes
    repoAssignments?: ProjectRepoBranchAssignment[];   // project repos to checkout
}
alignEnvironment(target, { label }): Promise<AlignmentResult>
computeEnvironmentDiff(target): Promise<EnvironmentDiff>   // what would change; empty diff = no-op
```

- Computes the diff first (active version id, current branches via `getGitBranch`); no-ops produce no UI at all.
- Applies in order: activate version → checkout core repos (reusing the existing `checkoutBranch` hook pipeline in `dbs.ts`) → checkout project repos (existing `applyProjectRepoBranchAssignments` concurrency logic).
- One progress notification; one summary toast on success, one warning listing failures.
- Consumers: `selectDatabase`, `odoo.setActiveVersion`, `changeDatabaseVersion` ("switch now"), DB creation. The two legacy pipelines are deleted.

### 2. Switch behavior setting

`odooDebugger.databaseSwitchBehavior`: **`auto` (new default) | `ask` | `never`**.

- Legacy value normalization at read time: `auto-both`/`auto-version-only`/`auto-branch-only` → `auto`; `ask` → `ask`. Best-effort one-time write-back of the mapped value to whichever scope defined it.
- `auto`: align silently (git itself refuses dirty checkouts; failures surface in the summary warning).
- `ask`: when the diff is non-empty, one **non-modal** notification — "Database X targets version Y / branch Z — [Switch] [Keep]" — instead of a blocking quick-pick.
- `never`: selection only, no alignment.

### 3. Database model cleanup + one-time data migration

Kept fields: `versionId` (environment), `branchName` (pure display label), `projectRepoBranches`.

`migrateDebuggerData()` runs once at activation (after `VersionsService` init), edits `odoo-debugger-data.json` in place, saves once if anything changed:

- For each db with legacy `odooVersion` and no `versionId`: link to the Version whose `odooVersion` matches; otherwise move the string into `branchName` if empty. Delete the `odooVersion` field.
- `getEffectiveOdooVersion` fallback spaghetti shrinks to "version's branch via versionId".

### 4. `createDb` rewrite — 2–3 prompts

1. **Method** quick-pick (fresh / dump / template / existing) — the one real decision.
2. **Source** (method-dependent): dump picker / template picker / **live Postgres DB list** (via `queryPostgresDatabases`, excluding reserved + already-linked DBs, with a manual-entry row). Fresh: nothing. The module multi-pick is dropped — module install marking lives in the Modules view.
3. **Name**: one input box pre-filled with the generated identifier; the same string is the Postgres identifier and the display name (the "Project • Kind • Date • #hash" display format is retired; existing display names are kept as-is).

Everything else is inferred silently:

- **Version**: auto-detected from the database (see §5); fresh DBs get the active version.
- **Repo branches**: current branch of every project repo is captured automatically; editable later via the existing *Configure Project Repo Branches* command.
- The separate "branch/tag label" input is dropped (label defaults to the detected/active core branch).

### 5. Odoo version auto-detection — `detectOdooSeries(dbName)` in `services/database.ts`

`SELECT latest_version FROM ir_module_module WHERE name='base'` → parse `17.0.1.3` → `17.0`, `saas~17.4.1.2` → `saas-17.4`. Applied after dump import, template clone, and existing-DB connect.

- Match found among Versions (by `odooVersion`) → link silently.
- No match → non-blocking toast: "Detected Odoo 17.0 — no matching Version. [Create Version] [Ignore]"; Create makes a Version from defaults with that branch.
- Detection failure (no psql / not an Odoo DB) → fall back to active version, no error.

### 6. Version creation — 2 prompts

1. **Branch** quick-pick from the default `odooPath` repo (`getBranchesWithMetadata`, fallback `getGitBranches`, plus a manual-entry row).
2. **Name** input pre-filled `Odoo {branch}`.

Paths/ports come from `odooDebugger.defaultVersion.*` and remain editable in the Versions tree. The "Activate Now" offer stays.

### 7. Supporting cleanups (in scope)

- `extension.ts`: collapse the repeated `versionIdOrTreeItem` extraction boilerplate into one helper.
- Remove bogus runtime dependencies `install` and `npm` from `package.json`.
- Update `package.json` configuration enum, README, CHANGELOG.

### Out of scope

Modules/Testing views, Project Repos explorer, Odoo installer, checkout-hook mechanics (pipeline reused unchanged).

## Error handling

- Alignment failures never block DB selection: the DB is selected, the warning lists which repos failed and why.
- Detection queries are best-effort with silent fallbacks.
- Migration is wrapped and non-fatal; on failure the legacy fields keep working through the read-time fallbacks.

## Testing

- Pure logic (setting normalization, series parsing, migration transform) gets unit tests alongside the existing `src/test` suites.
- `npm run lint` + webpack compile + `tsc` test compile must pass.
