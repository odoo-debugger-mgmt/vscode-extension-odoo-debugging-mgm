# Guided onboarding: design

**Status:** approved for implementation.
**Depends on:** `2026-09-01-first-run-setup-design.md` (setup state, detection),
`2026-09-01-custom-repo-worktrees-design.md` (repo branch modes),
`2026-08-27-native-version-provisioning-design.md` §2 (worktrees).

## Problem

First-run setup now records where Odoo lives, and provisioning builds an
environment per version. What neither addresses is the distance between those
two facts and a working upgrade workbench.

Counting the decisions between a cold install and "two versions running against
their own custom code": detect, confirm, *Create a Version*, branch, name,
provision-or-profile, then all four again for the second version, then create
project, add repos, create database, assign repo branches, and finally
right-click each repo in the explorer and toggle it into `worktree` mode.
Roughly fifteen, and the last one — the step that actually makes the upgrade
work — is reachable only from a context menu or a walkthrough step.

The cost is not just length. The user is asked to arrive independently at the
conclusion that per-branch repository copies are the mechanism for their
situation. `branchMode` is an implementation detail surfaced as a decision.

Two gaps sit underneath the length. Setup records where the Odoo repositories
live but not where the user's own code lives, so the first thing they try after
finishing setup — creating a project — throws (§7). And when any of this goes
wrong, the extension names the action needed without offering it: thirty-six
messages instruct rather than offer, one of them from a background refresh (§8).

Five defects in the current flow come from the same place:

1. **The first branch pick degrades to a free-text box.** `odoo.createVersion`
   passes the *active version's* `odooPath` to `pickOdooBranch`
   (`src/commands/versionCommands.ts:126`) — a worktree that does not exist on
   first run. Setup has just configured a repository full of branches, and the
   next prompt asks the user to type a branch name from memory.
2. **The clone fallback still asks the five questions the setup design
   deleted.** `runSetup`'s `cloneFallback` calls `cloneOdooRepositories`, which
   prompts for destination, targets, branch and depth
   (`src/odooInstaller.ts:365`). Asking *which branch to clone* is noise: the
   clone is only ever a worktree source, and `ensureWorktree` fetches any other
   branch on demand (`src/services/worktree.ts:172`).
3. **The branch list is hardcoded.** `BRANCH_OPTIONS`
   (`src/odooInstaller.ts:45`) names 19.0, 18.0, 17.0 and three saas releases.
   It is wrong the day 20.0 ships, and it is wrong now for anyone whose work is
   on a branch it does not list.
4. **Project creation dead-ends.** Repository discovery reads a
   `customAddonsPath` that setup never asks about and provisioning never writes,
   so `getRepo` throws after the project name has been typed.
5. **Old versions are migrated silently or not at all.** Only a `missing`
   version is ever surfaced unasked; the shape a v1.2 upgrader actually has is
   never mentioned, and one shape is described as safe when it is not.

## Design

### 1. Setup ends with a version multi-select

`odoo.setup` currently finishes with `showInfo('Odoo DevTools is set up.',
'Create a Version')`, handing off to a four-prompt command. It instead shows one
checkbox list and does the work:

```
Which Odoo versions do you want?          (space to toggle)
  [x] 19.0     latest stable
  [ ] 18.0     stable
  [ ] 17.0     psae-internal has 17.0-bunka
  [ ] master   development
  [ ] Custom branch…
```

Names are derived — `Odoo 19.0` — with no name prompt. The
provision-or-profile question does not appear on this path; every version
selected here is provisioned. *Profile only* remains in `odoo.createVersion`,
which is the flow for adopting an environment built by hand and is the right
place for it.

The list is skipped entirely when every candidate already exists, so re-running
setup on a configured machine does not nag.

**Cost is stated before the user commits.** The picker's title carries a fixed,
explicitly approximate estimate — `3 versions · ≈2 GB and a few minutes each` —
derived from a per-version constant, not measured. The point is to prevent a
user from casually ticking four boxes without knowing that each one is a
worktree, a virtualenv and a full `pip install -r requirements.txt`; a precise
number is neither available nor necessary for that.

### 2. Candidates come from a pure proposal function

```ts
// src/services/versionProposal.ts
interface VersionCandidate {
    branch: string;
    /** Shown as the row description: why this is being offered. */
    reason: string;
    picked: boolean;
}

function proposeVersions(
    repoBranches: string[],   // branches seen across the project's repositories
    seriesBranches: string[], // listSeriesBranches(sourceRepo), newest first
    existing: string[]        // branches of versions that already exist
): VersionCandidate[];
```

Ordering and rules:

- A repo branch maps to a series through the existing `parseOdooSeries`
  (`src/services/database.ts:177`), which already turns `17.0-bunka` into
  `17.0` and `saas-18.4-client` into `saas-18.4`. An exact `master` is
  special-cased; anything else that does not parse is ignored.
- Repo-derived candidates come first, each carrying the repository that
  suggested it as its `reason`, so the list explains itself.
- Remaining series from `seriesBranches` follow, already ranked newest-first by
  `rankBranches`, capped at four rows so the picker stays a glance.
- Branches in `existing` are dropped.
- `picked` is true for every repo-derived candidate, and for the newest series
  when there are none.

`BRANCH_OPTIONS` is deleted. The function is pure and is the single source of
candidates for both this picker and the upgrade flow in §4.

### 3. Provision the first, queue the rest

Provisioning three versions serially in one modal progress notification means
the user watches a bar for ten minutes before touching anything. Instead:

```ts
// src/services/provisionQueue.ts
interface QueuedVersion { branch: string; name: string }
```

The first selected version is provisioned in the foreground with today's
cancellable progress notification, so work can start as soon as it lands. The
rest are enqueued and built **one at a time** — concurrent `pip install`s
contend for the same wheel cache and finish no sooner than sequential ones.

The queue is persisted in `globalState` under `odt.provisionQueue` and drained
on activation, so a window reload resumes rather than silently dropping the
remaining versions. Each entry runs the existing `provisionAndCreateVersion`
machinery with its prompts suppressed; that flow already probes what exists and
builds only what is missing, so a resumed entry picks up where it stopped.

**State is visible on the version rows, not in a notification.**
`provisioningLabel` (`src/versionsTreeProvider.ts:18`) gains two states beside
`provisioned` / `not provisioned`: `building…` for the entry in flight and
`queued` for the rest.

**Failure does not stop the queue.** A failed entry is removed, its version left
in whatever state it reached, and reported through the mechanism that already
exists for exactly this: `diagnoseVersion` / `needsAttention`
(`src/services/versionMigration.ts`) mark it in the tree, and
`odoo.checkVersions` re-provisions it. A single summary notification at the end
of the drain names what succeeded and what did not — one message, not one per
version.

**Cancelling** is a `Stop Building` action on that summary and on the in-flight
progress notification; it clears the queue without touching versions already
built.

### 4. "Set Up an Upgrade" is its own command

Setup stays a short infrastructure question. Upgrading a client is something a
user does later and repeatedly, per project, so it gets its own entry point:
`odoo.setUpUpgrade`, in the Versions view title menu and the Repos view context
menu.

It is also **offered once, in context**: when `proposeVersions` finds a
repository with branches on two different series while only one version exists,
a dismissible notification points at the command. Dismissal is remembered in
`globalState`, per the extension's existing rule that automated prompts must be
silenceable.

The command asks for the repositories and the two series — all pre-filled from
detection, so the common case is three confirmations — then shows one plan:

```
Upgrade psae-internal: 17.0 → 19.0
  Versions      Odoo 17.0 (queued), Odoo 19.0 (exists)
  Custom code   psae-internal — one copy per branch
  Branches      17.0-bunka → Odoo 17.0     19.0-bunka → Odoo 19.0
  [Use these]  [Change…]  [Cancel]
```

Accepting it does three things:

1. Creates any missing versions, through the §3 queue.
2. Flips the named repositories to `branchMode: 'worktree'`.
3. Writes the `projectRepoBranches` assignments on the databases that match each
   version.

It **reuses the existing machinery rather than reimplementing it**. In
particular, the mode change still runs the modal confirmation naming the
directory that will be created, and still routes a branch held by the source
checkout through `classifySourceConflict` / `describeSourceConflict`
(`src/services/sourceConflict.ts`) so the user chooses between moving the source
to another branch and detaching it. Freeing a branch modifies a directory the
user owns; a wizard is not a reason to do that silently. A repository whose
source checkout is dirty stops that repository's step with the existing refusal
message, and the rest of the plan continues.

The plan is shown before anything is written, and *Change…* opens the individual
pickers, matching the pattern `runSetup` already establishes.

### 5. Defects 1-3

Defect 4 is answered by §7 and defect 5 by §6; the first three are one-line
corrections with no design behind them.

- `odoo.createVersion` passes `readSetupState().sourceRepo` to `pickOdooBranch`,
  not the active version's `odooPath`, so the first branch pick is a real list.
- `cloneOdooRepositories` stops asking for branch and depth. It clones the
  newest series shallow, because a source repository's branch is immaterial —
  every version worktree fetches what it needs. Destination and targets keep
  their prompts; they are genuine choices.
- `BRANCH_OPTIONS` is deleted with §2.

### 6. Versions that predate provisioning are offered a migration

`diagnoseVersion` (`src/services/versionMigration.ts:37`) already classifies an
existing version as `missing`, `unprovisioned`, `relocated` or `healthy`. Only
`missing` is ever surfaced without being asked for: `promptStaleVersions`
(`src/extension.ts:267`) filters on it alone. The shape a v1.2 upgrader
actually has — a hand-built `./odoo` and `./venv` that both still exist — is
`relocated`, and is silent. Those versions keep running the pre-provisioning
layout indefinitely, and nothing tells the user that a migration exists.

**A fourth health, for the case the current wording gets wrong.** When a
version's `odooPath` *is* the configured source repository, `diagnoseVersion`
returns `relocated` with the detail *"Leaving it is fine; re-provisioning moves
it."* Leaving it is not fine. Activating that version reaches `alignCoreRepos`
through `applyEnvironmentDiff` and runs `git checkout <series>` in the
repository every other version's worktrees are cut from — the failure `f1d4d4c`
closed for new versions, still reachable through old ones, and silent because
the switch pipeline cannot tell that core path from any other.

`diagnoseVersion` therefore takes the source repository as an argument and
gains `VersionHealth = 'source-repo'`, ranked worst in `needsAttention`, with a
detail that says what is actually at stake: this version runs out of the source
repository, so switching that repository's branch changes what it runs, and
activating it switches that repository's branch.

**One notification, once.** `promptStaleVersions` widens from `missing` to
`missing`, `source-repo` and `unprovisioned` — the three states where something
is broken or unsafe — and offers to fix them together:

> 2 versions were built before provisioning and can be migrated.
> **[Migrate]** **[Later]**

*Migrate* enqueues them through the §3 queue, which is the same resumable
mechanism new versions use, so the user gets one background drain and one
summary rather than a per-version modal. *Later* is remembered in `globalState`,
matching `promptFirstRunSetup`; the current prompt has no dismissal flag and
re-fires on every window, which the extension's own rule about silenceable
prompts forbids.

`relocated` stays deliberately silent. It works, moving it is optional, and a
nag about tidiness is worse than none. It remains visible on the version row
and through `odoo.checkVersions`.

**Migration is re-provisioning, not a new code path.** `provisionExistingVersion`
(`src/odooInstaller.ts:305`) already builds the environment under the current
root and repoints the version at it. The migration is that function, driven from
the queue. The old directories are never deleted: a hand-built checkout is the
user's, and `Delete Version` remains the only thing that removes anything.

### 7. Setup records where custom addons live

Setup asks about the Odoo repositories and the provisioning root. It never asks
about the one directory the user's own work is in, and nothing else fills the
gap: provisioning writes `odooPath`, `enterprisePath`, `designThemesPath` and
`pythonPath`, never `customAddonsPath`, which is left on its shipped default of
`./custom-addons` relative to the workspace.

Every repository-discovery site reads that value —
`projectSelector.create` (`src/commands/projectCommands.ts:44`), the Repos view
(`src/repos.ts:78`), and the project's repo editor (`src/project.ts:1087`). For
a user who has just finished setup the directory usually does not exist, so
project creation ends in a throw, *after* the project name has been typed:

```ts
// src/project.ts:373
if (devsRepos.length === 0) {
    void showInfo('No repositories found in the custom-addons path.');
    throw new Error('No repositories found in the custom-addons path.');
}
```

No recovery, no picker, no pointer at the setting. Nothing downstream works
without project repositories — including the upgrade flow in §4.

**Setup proposes a location.** The confirmation summary from
`2026-09-01-first-run-setup-design.md` §4 gains a fourth row:

```
  Custom addons  ~/Dev/custom-addons     4 repositories
```

Detection reuses the `searchRoots` / `detectRepos` shape already in
`src/services/setupDetection.ts` with a different predicate: a directory
containing at least one git repository that is not `odoo`, `enterprise` or
`design-themes`. The workspace folders are searched first, because the workspace
*is* that directory in the common case.

The value is written to the existing `odooDebugger.defaultVersion.customAddonsPath`
at user scope, not to a new key. It stays a per-version setting with a
per-version override, which is right — a client version may point somewhere
else — and because setup runs before §1 creates any version, every version
created from the multi-select inherits it. No migration is needed: an existing
workspace that already has a working value keeps it, since setup proposes
current configuration ahead of detection.

**Skip is a real answer.** A user doing pure Odoo work has no custom addons, so
the row can be left empty and setup still completes. That makes the recovery in
§8 mandatory rather than decorative.

### 8. Dead ends become offers

Thirty-six messages across the extension name an action without offering it —
`'Select a database before running this action.'`,
`'Unable to load projects, please create a project first'`. The first-run design
already fixed one instance of this, turning provisioning's *no repository* error
into an offer to run setup. The pattern simply never propagated.

Buttons are added to the messages that gate the daily loop, not to all
thirty-six. The rest stay as they are; an error nobody is blocked by does not
need a button.

| Site | Message | Action |
| --- | --- | --- |
| `getRepo` (`src/project.ts:373`) | No repositories in the custom-addons path | **Choose Folder…**, which sets the active version's `customAddonsPath` and re-scans |
| `SettingsStore.getSelectedProject` | No projects exist | **Create Project** |
| `SettingsStore.getSelectedProject` | None selected | **Select Project** |
| Module commands (`src/module.ts`) | No database selected | **Select Database** |
| Module commands (`src/module.ts`) | Testing mode is on | **Disable Testing Mode** |

The testing-mode refusal appears six times in `src/module.ts` with identical
wording; it becomes one guard helper returning whether the caller may proceed,
so the button exists in one place.

**A background sync must not raise a user-facing error.**
`SettingsStore.getSelectedProject` shows an error as a side effect of returning
`null` (`src/settingsStore.ts:240`). `setupDebugger` calls it, and `refreshAll`
runs `setupDebugger` on its default reason — so a freshly configured install
with versions but no project yet shows *"Unable to load projects, please create
a project first"* out of nowhere, triggered by a refresh the user did not ask
for. A silent `peekSelectedProject` is added for background callers;
`getSelectedProject` keeps its prompting behaviour for the command paths that
want it.

**Start Server checks its preconditions.** `startDebugServer`
(`src/debugger.ts:476`) calls `vscode.debug.startDebugging` with no checks and
without awaiting it, so an unprovisioned version, an absent database selection
and a launch entry that has not been written yet all surface as VS Code's own
generic failure. It checks three things first — `isVersionProvisioned` (already
imported in that file), a resolved database for the active version, and the
managed launch entry — and each failure offers its fix: **Provision**, **Select
Database**, **Retry**.

## Failure modes

| Situation | Behaviour |
| --- | --- |
| No source repo configured when the multi-select would show | Not reached: setup only offers it once `isConfigured` |
| Every candidate version already exists | The picker is skipped |
| `listSeriesBranches` returns nothing (no remote, empty clone) | Repo-derived candidates only; `Custom branch…` always present |
| A queued branch does not exist locally or on origin | That entry fails with the existing `ensureWorktree` message; the queue continues |
| Window closed mid-queue | Remaining entries drain on next activation |
| Provisioning root becomes unwritable mid-queue | Entries fail in turn and are reported in the summary; the queue is not retried automatically |
| Legacy version whose `odooPath` is the source repository | Diagnosed `source-repo`, included in the migration offer; re-provisioning repoints it at its own worktree |
| Legacy version that still works outside the provisioning root | Diagnosed `relocated`, left alone and left silent |
| User answers *Later* to the migration offer | Remembered globally; the versions stay reachable through `odoo.checkVersions` |
| Migration fails for one version | Same as any queue failure: removed from the queue, reported in the summary, old paths untouched |
| No custom addons directory detected during setup | The row is left empty; setup completes, and `getRepo` offers **Choose Folder…** on first use |
| Custom addons row skipped, then Create Project run | The picker offers a folder, writes it to the active version, and re-scans without losing the typed project name |
| Start Server on an unprovisioned version | Refused with **Provision**, which runs the existing re-provisioning flow |
| Background refresh with no project | Silent: `peekSelectedProject` returns nothing and the debugger sync stops |
| Upgrade plan names a repo whose source checkout is dirty | That repo's mode change is refused with its dirty files listed; other steps proceed |
| Upgrade plan names a series that has no database yet | Versions and repo mode are configured; branch assignments are written when the database is created |

## Out of scope

Automatic database creation or dump restoration as part of the upgrade plan;
anything resembling migration assistance; parallel provisioning; and rewriting
`media/walkthrough/`, which still describes the pre-provisioning model and needs
its own pass once this flow lands.

## Testing

Pure and unit-tested: `proposeVersions` across its ordering rules, deduplication
and `existing` filtering; branch-to-series extraction including `master` and
non-parsing branches; queue state transitions (enqueue, drain, failure removal,
cancel) over plain data with the provisioning call injected; and `diagnoseVersion`'s
new `source-repo` health, including its rank in `needsAttention` and the
boundary where `odooPath` equals the source repository only after path
resolution; and custom-addons detection, including the predicate that excludes
the core repositories.

Requires the Extension Development Host: the multi-select itself, queue
resumption across a window reload, the version-row states, the migration offer and its
dismissal across a window reload, every message that gains a button, the
Start Server preconditions, and the upgrade
plan's write-through to repository mode and branch assignments — including the
source-conflict path, which cannot be exercised without a real git checkout
holding the branch.
