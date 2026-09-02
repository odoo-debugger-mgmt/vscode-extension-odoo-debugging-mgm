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

Three defects in the current flow come from the same gap:

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

### 5. The three defects

- `odoo.createVersion` passes `readSetupState().sourceRepo` to `pickOdooBranch`,
  not the active version's `odooPath`, so the first branch pick is a real list.
- `cloneOdooRepositories` stops asking for branch and depth. It clones the
  newest series shallow, because a source repository's branch is immaterial —
  every version worktree fetches what it needs. Destination and targets keep
  their prompts; they are genuine choices.
- `BRANCH_OPTIONS` is deleted with §2.

## Failure modes

| Situation | Behaviour |
| --- | --- |
| No source repo configured when the multi-select would show | Not reached: setup only offers it once `isConfigured` |
| Every candidate version already exists | The picker is skipped |
| `listSeriesBranches` returns nothing (no remote, empty clone) | Repo-derived candidates only; `Custom branch…` always present |
| A queued branch does not exist locally or on origin | That entry fails with the existing `ensureWorktree` message; the queue continues |
| Window closed mid-queue | Remaining entries drain on next activation |
| Provisioning root becomes unwritable mid-queue | Entries fail in turn and are reported in the summary; the queue is not retried automatically |
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
cancel) over plain data with the provisioning call injected.

Requires the Extension Development Host: the multi-select itself, queue
resumption across a window reload, the version-row states, and the upgrade
plan's write-through to repository mode and branch assignments — including the
source-conflict path, which cannot be exercised without a real git checkout
holding the branch.
