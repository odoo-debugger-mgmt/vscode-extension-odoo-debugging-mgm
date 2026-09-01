# Per-version custom code: design

**Status:** approved for implementation.
**Depends on:** `2026-08-27-native-version-provisioning-design.md` §2 (worktrees),
`2026-09-01-first-run-setup-design.md` (provisioning root).

## Problem

Provisioning gave every version its own Odoo worktree, so several versions can
be checked out and run at once. That is only half the feature: **custom addons
still switch branches globally.** Selecting a database runs `git checkout` in
each project repo, so the two versions supposedly running side by side share
one copy of the custom code, on one branch. During an upgrade — the case the
whole worktree model exists for — you cannot have 17.0 and 19.0 running
against their own custom code at the same time.

Four smaller problems live in the same code and are fixed here rather than
left to rot around a new mechanism:

1. **"Branch" means three things.** `version.odooVersion` (the core series),
   `db.branchName` (a per-database record that drifts out of sync), and
   `db.projectRepoBranches` (the per-repo map). Nothing tells the user which
   one a given label refers to.
2. **Branch mapping is captured silently.** `createDb` snapshots whatever
   branch each repo happened to be on, with no prompt and no confirmation. The
   only way to discover the result is hovering the database row.
3. **Editing that mapping is buried.** `Configure Project Repo Branches` is two
   levels into a context menu.
4. **Switch notifications are fire-and-forget.** In `ask` mode the notification
   is `void`-ed so the selection is not blocked; it can be answered long after
   the user has moved on, against a workspace that has since changed.

## Design

### 1. Repositories get a branch mode

```ts
// src/models/repo.ts
type RepoBranchMode = 'checkout' | 'worktree';

class RepoModel {
    // …existing fields
    branchMode: RepoBranchMode;   // default 'checkout'
}
```

`checkout` is today's behaviour exactly and stays the default: one working
copy, branches switched in place. This is right for ordinary development,
where a feature branch simply follows staging and prod.

`worktree` is opted into per repository, when a repo genuinely needs two
branches live at once — an upgrade, and the post-upgrade support work around
it. It is a per-repo decision because it is a per-repo situation: a project
usually has one repo mid-upgrade and several that are not.

### 2. Path resolution is the mechanism

Every consumer reads `repo.path` today — module discovery, the Repos tree, the
explorer's file watchers, module scaffolding, the addons path. The change is
not to mutate `repo.path` but to route those reads through one resolver:

```ts
// src/services/repoPaths.ts
interface ResolvedRepo {
    repo: RepoModel;
    /** Directory to use: the source checkout, or a worktree for the branch. */
    path: string;
    /** The branch this path is on, when known. */
    branch?: string;
    mode: RepoBranchMode;
    /** True when `path` is a worktree rather than the source checkout. */
    isWorktree: boolean;
}

function resolveRepoPath(
    repo: RepoModel,
    branch: string | undefined,
    root: string
): ResolvedRepo;

function resolveProjectRepos(
    repos: RepoModel[],
    assignments: ProjectRepoBranchAssignment[],
    root: string
): ResolvedRepo[];
```

Pure and testable: it maps `(repo, branch)` to a directory. Creating the
directory is a separate, impure step (§3). A `checkout`-mode repo always
resolves to `repo.path`, so the default path through this code is unchanged.

Stored data does not change shape. `db.projectRepoBranches` keeps meaning
"this database wants this repo on this branch" — what changes is that in
`worktree` mode that is satisfied by *selecting a directory* rather than by
running `git checkout`.

**Consumers to route through the resolver** (this list is the work):
`prepareArgs` addons path, `collectModuleDiscovery`, `RepoTreeProvider`,
`ProjectReposExplorerProvider` (including its `RelativePattern` watchers),
module scaffolding's destination picker, and `versionFolderEntries` for the
generated workspace.

### 3. Layout, and making it discoverable

Worktrees live under the provisioning root, beside the Odoo ones:

```
~/odoo-dev/
  odoo-19.0/                 core worktree
  venv-19.0/
  psae-internal@19.0-bunka/  custom repo worktree
  psae-internal@17.0-bunka/
```

Naming is `<repo-slug>@<branch-slug>`, **keyed by branch, not by version**: two
versions pointing at the same branch share one worktree, which is both correct
and cheaper.

Putting generated trees in one place is the right call for backup and cleanup,
but it moves a developer's working copy somewhere they did not choose. So the
location is **surfaced, not assumed**:

- The first time a repo is switched to `worktree` mode, a modal confirmation
  names the exact directory that will be created and states that this becomes
  where they edit that repo's code for that branch.
- The Repos tree shows `worktree` on the row, with the resolved path in the
  tooltip.
- `Open in Explorer` / `Copy Path` on a repo row act on the **resolved** path,
  never the source, so the obvious action lands in the right place.
- The Setup summary (`odoo.setup`) lists the provisioning root as
  *"worktrees, virtualenvs and per-version copies of custom repos"* rather than
  the current vaguer wording.

### 4. The source checkout becomes a source

In `worktree` mode the original checkout is treated exactly like the Odoo
source repo: **never in the addons path, never run, never edited by the
extension.** It stays yours to switch, rebase or wreck without changing what
any version runs. That determinism is the entire point — the alternative,
reusing it when it happens to be on the right branch, reintroduces the failure
where `git checkout` in one window silently changes what another version runs.

**The branch-holding conflict, and why it needs care.** git will not check one
branch out in two places. For Odoo core we sidestep this with a managed
`odt/<branch>` branch, because nobody commits to a core worktree. **That trick
must not be used here.** A developer commits and pushes custom code; parking
them on `odt/19.0-client` would put their work on a branch nobody else sees.
Custom worktrees therefore check out **the real branch**.

So when a worktree is needed for branch `X` and the source checkout is on `X`:

- If the source checkout is **dirty**, refuse and say so, naming the branch and
  the uncommitted files. Committing or stashing is the user's call, not ours.
- If it is **clean**, offer two ways to let go of the branch, in this order:
  1. **Move the source to another branch** (default: the repository's default
     branch). This is the recommendation. The checkout stays on a branch, so
     `git pull` works, and tooling that dislikes a detached HEAD — the GitHub
     Pull Requests extension errors outright on one — keeps working.
  2. **Detach it** (`git checkout --detach`). Same commit, same files, nothing
     lost.

**Two consequences of detaching must be stated in the prompt, because both are
easy to discover the hard way:**

- **The source cannot return to that branch while the worktree exists.**
  `git switch 19.0` fails with *"already used by worktree at …"*. It only
  works again after the worktree is removed. (An earlier draft of this design
  claimed detaching was "reversible with one `git switch`". It is not, and the
  claim was removed after testing it.)
- **Commits made in a detached source belong to no branch.** `git branch
  --contains HEAD` returns nothing; only the reflog finds them. A developer
  who forgets the source is detached and commits there out of habit has to
  recover by hand.

Neither consequence affects the worktree, which is where work now happens:
commits there go to the real branch, and `git log <branch>` from anywhere in
the repository shows them.

Never detach or move the source silently. Never stash on the user's behalf.

### 5. Not editing the wrong copy

Two directories with identical file trees is the real hazard this design
introduces. Two mechanisms, because scoping alone leaks:

**Scope the views.** The Repos tree, Project Repos explorer, Modules view and
generated workspace show only the **active version's** resolved paths. The
wrong copy is not reachable through the UI at all.

**Warn on open.** Scoping does not help when a file is reached through search
history, a bookmark, or an external tool. A `TextDocument` open listener maps
the file's path back to a worktree; if that worktree belongs to a version other
than the active one, a dismissible warning names it:

> `models.py` belongs to **Odoo 17.0**, but **Odoo 19.0** is active.
> **[Open the 19.0 copy]** **[Stay here]** **[Don't warn again]**

*Open the 19.0 copy* opens the same relative path under the active version's
worktree — the common case, where you meant the other one. *Don't warn again*
is remembered in `globalState`, because a developer deliberately comparing two
versions should not be nagged.

The mapping is a pure function and is tested directly:

```ts
function identifyWorktreeOwner(
    filePath: string,
    resolved: ResolvedRepo[]
): { repo: RepoModel; branch: string } | undefined;
```

### 6. One meaning of "branch"

`db.branchName` is deleted. It duplicated `version.odooVersion` and drifted
out of sync — the bug where changing a database's version left the row reading
`17.0 • Odoo 19.0`. After migration:

- **The core branch** comes from the database's version, and only from there.
- **Project repo branches** come from `db.projectRepoBranches`, and only from
  there.

Migration folds any `branchName` on a database with no `versionId` into the
legacy `odooVersion` field that already handles unmigrated data, then drops
the field. Views stop rendering it.

### 7. Database creation asks which branches, and asks first

`createDb` snapshots every repo's current branch with no prompt, and does it
**after** the database has been created or a dump restored. Two problems in
one: the choice is never made by the user, and the work is already done before
the environment is settled, so cancelling costs a restore.

The decision moves ahead of any creation work, and becomes an actual question.
The prompt already exists — `promptProjectRepoBranchAssignments` in `create`
mode offers *use current branches* / *choose branch per repository* / *skip* —
it was simply never called from creation.

*Use current branches* remains one of the offered answers, so the old
behaviour is still one keystroke away for anyone who wants it. What changes is
that it is now an answer rather than an assumption.

Cloning a database inherits its source's mapping rather than capturing the
current checkouts, which is the same wrong assumption in a second place: a
clone runs the environment its source ran, and what the repos happen to be on
at clone time has nothing to do with it.

### 8. The mapping is visible on the row

The Databases view shows the mapping in the row description rather than only
in the tooltip: `running :8017 • 3 repos • Odoo 19.0`. `Configure Project Repo
Branches` moves from a nested context-menu entry to an inline action on the
row, next to the existing ones, so editing it is one click from seeing it.

### 9. Switch notifications become reviewable

In `ask` mode the notification is `void`-ed so the tree refresh is not blocked,
which means it can be answered minutes later against a workspace that has
since moved. Instead:

- The prompt carries the summary from `describeSwitch` — already fixed to
  distinguish *"its existing 19.0 worktree"* from *"core branch 19.0"* from
  *"core repositories are missing"*.
- It is **superseded** rather than left standing: a newer switch cancels the
  pending prompt, so two rapid database selections cannot leave two
  contradictory notifications competing.
- On accept, the diff is recomputed (already the case) and the result reported
  with what actually changed.

### 10. Turning the mode off

Switching a repo back to `checkout` mode offers to remove the worktrees the
extension created for it — `git worktree remove`, never a directory the user
made — and refuses on any worktree with uncommitted changes, listing them.
This mirrors Delete Version, which already works this way.

## Failure modes

| Situation | Behaviour |
| --- | --- |
| Source checkout holds the branch, clean | Offer to move it to another branch, or detach, with the consequences of each |
| Source checkout holds the branch, dirty | Refuse; name the branch and the dirty files |
| Worktree directory deleted by hand | Prune the stale record and recreate (already implemented) |
| Branch does not exist locally or on origin | Report it; do not invent a branch |
| Provisioning root not writable | Report it and point at `odooDebugger.provisioning.root` |
| Repo in worktree mode but no branch mapped for this database | Fall back to the source checkout read-only, and say so |
| Two versions map the same repo to the same branch | One shared worktree; not an error |

## Out of scope

Automatic branch creation, any form of merge or rebase assistance, and syncing
uncommitted work between worktrees. The extension resolves paths and creates
worktrees; git remains the tool for git.

## Testing

Pure and unit-tested: `resolveRepoPath` / `resolveProjectRepos` across both
modes, worktree naming and slugging, `identifyWorktreeOwner`, the migration
that drops `branchName`, and the switch-summary wording (already tested).

Requires the Extension Development Host: the detach offer on a conflicting
source checkout, the wrong-copy warning and its *Open the N copy* action, view
scoping following the active version, and the mode-off cleanup refusing a dirty
worktree.
