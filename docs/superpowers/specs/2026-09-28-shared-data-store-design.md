# Shared data across workspaces: design

**Status:** decided 2026-09-29. The main store is SQLite through `node:sqlite`,
and `engines.vscode` is raised to `^1.101.0`. Steps 1 and 2 of the build order
are implemented; steps 3 to 5 are not.
**Spike outcome (2026-09-29):** `node:sqlite` loads from VS Code 1.101.0
(Node 22.15.1) onward, but not on 1.100.0, the current minimum (Node 20.19).
Where it loads, WAL, `data_version` and the `rev`-guarded writes behave as §4
assumes. §4 therefore stands only if `engines.vscode` is raised to `^1.101.0`,
which was accepted. §4.2 records what the spike changed.
Full results: [the spike report](../notes/2026-09-29-node-sqlite-spike.md).
**Depends on:** `2026-09-01-custom-repo-worktrees-design.md` (path resolution
through `resolveProjectRepos`), `2026-09-01-first-run-setup-design.md` (user-level
setup with a workspace override).

## Problem

Odoo is version-based, and developers usually work on several versions at once.
A common setup is **one VS Code workspace per Odoo version**, each holding that
version's custom code. The extension cannot serve that setup:

- **All state lives in one workspace.** `SettingsStore` reads and writes
  `<workspaceFolders[0]>/.vscode/odoo-debugger-data.json`
  (`SettingsStore.resolveFilePath`, `utils.readFromFile`). A second workspace
  starts with nothing: no projects, no versions, no databases. Versions built in
  the first workspace are invisible to it, although their worktrees and
  virtualenvs sit in the same `~/odoo-dev`.
- **Upgrade mode needs both sides**, but each side's code lives in a different
  workspace, and neither workspace knows about the other.

Pointing two workspaces at the same file today would not help. It would make
things worse:

1. **Per-window state is stored in shared entities.** `project.isSelected`,
   `db.isSelected`, `activeVersion` / `version.isActive` and
   `testingConfig.isEnabled` would be fought over. Selecting a database in one
   window would change what the other window launches.
2. **Writes are whole-file read-modify-write.** About 40 call sites do
   `SettingsStore.get()` → mutate → `saveWithoutComments()`, with no conflict
   detection. With two writers, the last one silently drops the other's edit.
3. **Nothing tells a window that another one wrote.** `VersionsService` loads
   once. `SettingsStore` re-checks mtime only when something reads, and there is
   no watcher, so views stay stale.
4. **Default paths are workspace-relative.** `./odoo`, `./custom-addons` and
   `./venv/bin/python` resolve against `workspaceFolders[0]` through
   `normalizePath`. In a shared file they mean something different in each
   window.
5. **The provisioning queue is already shared, unguarded.** It lives in
   `globalState`, which every window sees, but the `draining` guard in
   `provisionQueue.ts` is per process. Two open windows can both build the same
   branch today.

And one existing bug that this design fixes on the way:

6. **Open Project Workspace loses the data.** `projectWorkspace.ts` writes a
   `.code-workspace` whose first folder is the project's first repository. In the
   new window `workspaceFolders[0]` is that repository, so the extension reads,
   and creates, `.vscode/odoo-debugger-data.json` *inside the user's repo*. The
   projects appear to vanish, and a stray data file and launch.json are written
   into custom code.

## Goals

- Several workspaces share one set of data: projects, versions, databases,
  upgrades, templates.
- Each workspace keeps its own view and choices: the projects it shows, what is
  selected, which version it runs.
- Each workspace chooses which store it uses. The default is one shared store
  per machine, and a workspace can opt into another.
- Import and export, for backup, moving machines, and sharing a project.
- Upgrade mode works across workspaces: either window can see and start both
  sides.
- Every custom-code layout developers already use keeps working. Nobody is made
  to reorganise their repositories.
- An existing single-workspace user notices nothing until they opt in.

## Design

### 1. Two tiers: a main store and a workspace store

Every piece of state is either a **fact** that more than one window needs, or a
**choice** one window made. Facts go to the main store, choices to the workspace
store.

| State | Tier | Why |
|---|---|---|
| Versions: branch, environment paths, `managedPaths`, settings | main | A version is a directory on disk; every window can run it. |
| Version identity: debugger name, ports | main | Ports must be unique across the machine, not per window. |
| Projects: name, uid, tickets | main | |
| Project repos: identity (name, remote URL), branch mode | main | |
| Repo location per version (§5) | main | This is how one window finds the other side's code. |
| Databases: version link, per-repo branch mapping, kind, dump path | main | |
| Module install/upgrade marks | main | They belong to a database, and a database belongs to one version, so in practice one window edits them. Upgrade mode stages the source database's marks onto the target, which needs both sides from either window. |
| Upgrade configuration | main | It pairs two versions and two databases: cross-workspace by definition. |
| `selectedDbByVersion` | workspace | *Revised after testing.* It was main, for Start Both Servers - which made one window's database choice decide what every window launched. It is per window; an active upgrade pins its two databases instead (`dbForVersion` in `services/dbResolution.ts`), so either window still starts both sides. The order is: the pin, then the window's selected database when it belongs to that version, then the memory - so a window always launches what it shows as selected. A database of another version is never used; a legacy one with no version is. |
| DB templates | main | |
| Workspace registry (§3) | main | Discovery only. |
| Projects attached to this workspace | workspace | Each workspace shows its own subset. |
| Selected project; selected database per project | workspace | |
| Active version | workspace | Workspace A runs 17.0 while workspace B runs 19.0. |
| Testing mode on/off, test targets | workspace | "What I am doing right now". The module stash stays keyed by database. |
| Sort orders, per-workspace dismissals | workspace | Sort orders already live in `workspaceState` (`SortPreferences`). |
| Source repo, provisioning root, version defaults | user settings | Unchanged. Already user-level with a workspace override. |

**Where the workspace store lives: `context.workspaceState`, not a file.**
VS Code keys `workspaceState` by the real workspace identity: a folder, a
`.code-workspace` file, or an untitled workspace. A `.vscode/…` file would have
to be placed under `workspaceFolders[0]`, which in a multi-root window is a
user's repository, which is bug 6 again. The price is that it cannot be seen or
edited by hand. The registry row (§3) mirrors the attached projects, so they can
be restored if the state is lost.

**A JSON workspace file keeps a copy.** *Revised after testing.* Only a shared
(SQLite) store is written without the per-window fields. The workspace's own
file keeps the last selection, as before 1.3: the window's `workspaceState`
still decides for that window, and the file's copy is what another profile,
another editor or an older build starts from. Stripping it there broke the
design's own goal that nothing changes until someone opts in.

**Call sites do not change.** The split happens at the `SettingsStore` seam:

- `get()` loads the main store, then applies the workspace overlay: sets
  `isSelected` on the chosen project and database, `activeVersion`, and
  `testingConfig.isEnabled`.
- `save()` strips those fields before writing to the main store, and writes
  them to the overlay.

The in-memory model keeps its flags, so `project.ts`, `dbs.ts`, `module.ts` and
the rest keep reading `isSelected` as they do today.

### 2. Which main store a workspace uses

A new setting, `odooDebugger.dataStore.path`: a **user-level default plus a
workspace override**, exactly how `odooDebugger.sourceRepo.*` works.

- Unset at every level: legacy mode. The workspace's own
  `.vscode/odoo-debugger-data.json`, as today. Nothing changes for existing
  users.
- Set at user level: every workspace shares that store. This is the setting
  someone with one workspace per version sets once.
- Set in a workspace: that workspace uses its own store, for a separate client
  or employer, say.

Command **Odoo DevTools: Choose Data Store…** offers:

- the default shared store, `~/odoo-dev/odoo-devtools.db`, next to the
  provisioning root, which is already machine-wide;
- pick an existing store, or create a new one anywhere;
- keep this workspace's legacy file.

When the current data does not already live in the chosen store, it offers to
import it (§8).

The store in use is shown in the Projects view description, so a user can always
see which data they are looking at.

**Generated project workspaces pin the store.** `buildWorkspaceFile` writes
`settings: { "odooDebugger.dataStore.path": <current store> }` into the
`.code-workspace`, and in legacy mode the path of the current legacy file. That
fixes bug 6: the new window opens the same data, whatever its first folder is.

### 3. The workspace registry

A table in the main store, one row per workspace that has opened it:

- a stable id, stored in `workspaceState`;
- a display name (the workspace name or folder name);
- the URI to reopen it: `workspace.workspaceFile` or the first folder;
- the version it is bound to;
- the projects attached to it;
- a last-seen time.

It is for discovery, never for state that drives behaviour:

- the Upgrade view offers **Open the 19.0 workspace** (`vscode.openFolder`);
- the version picker can show which workspace is bound to each version;
- a lost `workspaceState` can restore its attached projects.

Rows unseen for 90 days, or whose URI no longer exists, are pruned.

### 4. The main store's engine: SQLite through `node:sqlite`

**Recommendation: SQLite, through the runtime's built-in `node:sqlite`, holding
one document per row to start.** This is conditional on the spike at the end of this document.

**Why a database, now that the store is split.**
With per-window state moved out, what reaches the main store is real data: a few
processes writing a small dataset, rarely the same row. That is what SQLite is
for:

- **Correct multi-process writes.** WAL mode with a `busy_timeout` gives
  concurrent readers and serialised writers, with no merge logic of our own. The
  JSON alternative needs a hand-rolled three-way merge, which is where subtle
  bugs live.
- **Transactions.** Setting up an upgrade changes a project, its databases and
  possibly versions together (`upgradeApply.ts`). Today a failure halfway
  through leaves half a pair on disk, which `ensureUpgradeConfigModel` has to
  read as "no upgrade".
- **Integrity.** Foreign keys with cascades replace hand-written cleanup such as
  `VersionsService.cleanupDatabaseVersionReferences`, and part of what
  Reconcile Databases does.
- **Change detection.** `PRAGMA data_version` changes whenever another
  connection commits, so a cheap poll tells a window that someone else wrote.
  With JSON that can only be approximated with mtime watchers.

**Why `node:sqlite`, not a package.**

- `better-sqlite3` is a native addon. It must be compiled against the Electron
  ABI of every VS Code release we support, and the extension must ship one VSIX
  per platform and architecture (`vsce package --target …`), with a CI matrix
  to build them. That is a permanent cost for a store holding kilobytes.
- `sql.js` (SQLite compiled to WASM) keeps the database in memory and writes
  the whole file back on save. It has exactly the lost-update race of the JSON
  file, with none of the transparency. Rejected.
- `node:sqlite` needs no dependency and no packaging. **Two unknowns:** Node
  still marks it experimental, and it is not certain that the Node inside VS
  Code's Electron includes it at our minimum engine version. The spike (below) settles both
  before anything is built on it.

**Why not PostgreSQL.** It is already required, and `LISTEN/NOTIFY` would even
make multi-machine and team sharing possible. Against it, as the default store:

- The extension talks to PostgreSQL only through the `psql` / `createdb` /
  `dropdb` CLIs with ambient credentials (`services/postgres.ts`). A store
  would need the `pg` driver and connection settings.
- Nothing could render while the server is down, including the views that
  explain why it is down.
- The store database would show up in **Odoo's own database selector**, and in
  this extension's *Connect to Existing* list and Reconcile Databases.
- Its life would be tied to the cluster: reinstalling PostgreSQL would take
  every project and version with it.

It remains a sensible second backend for team sharing, behind the same interface
(§4.1).

**Fallback, if the spike fails.** JSON, **one file per entity** under a store
directory (`projects/<uid>.json`, `versions/<id>.json`, …). Writes are atomic
(temp file, then rename), a directory watcher replaces `data_version`, and each
file carries a `rev` for conflict detection. That keeps entity-level writes and
no dependency, and gives up transactions and foreign keys. The other option is
to accept `better-sqlite3` and its per-platform builds.

**Stays JSON regardless:** import and export files (§8), so data remains
portable, diffable and fixable by hand.

**Constraint to document:** the main store must be on a local disk. SQLite's
locking is unreliable over NFS and SMB, and so is a JSON rewrite.

#### 4.1 One interface, documents per row

```ts
interface MainStore {
    /** Everything, as the DebuggerData shape callers use today. */
    load(): Promise<StoreSnapshot>;
    /** Writes what changed since `base`, in one transaction. */
    commit(base: StoreSnapshot, next: DebuggerData): Promise<CommitResult>;
    /** Fires when another process commits. */
    onDidChange: vscode.Event<void>;
}
```

Implementations: `JsonFileMainStore`, which wraps today's file and is used in
legacy mode; `SqliteMainStore`; later, possibly, a PostgreSQL one.

Schema, first cut: documents, not normalised tables. Normalising is a later
choice, made where a query needs it.

```sql
CREATE TABLE meta       (key TEXT PRIMARY KEY, value TEXT);   -- schema_version
CREATE TABLE versions   (id TEXT PRIMARY KEY, rev INTEGER NOT NULL, doc TEXT NOT NULL);
CREATE TABLE projects   (uid TEXT PRIMARY KEY, rev INTEGER NOT NULL, doc TEXT NOT NULL);
CREATE TABLE templates  (name TEXT PRIMARY KEY, rev INTEGER NOT NULL, doc TEXT NOT NULL);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, rev INTEGER NOT NULL, doc TEXT NOT NULL);
```

A project document keeps its databases, repos and upgrade configuration nested,
as the model does today. That keeps the change inside `SettingsStore`:

- `get()` records the snapshot it handed out, in a `WeakMap` keyed by the
  returned object. Callers already pass that same object back to
  `saveWithoutComments()`.
- `save()` diffs the object against its snapshot and commits only the rows that
  changed, in one transaction, each guarded by `WHERE rev = :rev`.
- A row whose `rev` moved is a conflict: re-read that row, re-apply this
  caller's changed fields on top, commit, and log it. Two windows changing the
  same field of the same project is the only case that loses anything, and it
  resolves last-writer-wins on that field.

#### 4.2 What the spike changed

- **Short lock waits, retried off the thread.** `DatabaseSync` is synchronous,
  and the Extension Host thread is shared by every extension in the window. A
  write waiting on a 5 s `busy_timeout` would freeze all of them for up to 5 s.
  `busy_timeout` is therefore short (about 200 ms), and a busy commit is retried
  asynchronously with backoff, a handful of times, before it is reported as a
  failure.
- **The smallest API surface.** Only `DatabaseSync`, `exec`, `prepare` and
  `run` / `get` / `all`, with every setting (`journal_mode`, `busy_timeout`,
  `foreign_keys`) passed as a `PRAGMA` rather than a constructor option. That
  surface worked unchanged from Node 22.15 to 24.20; the module is still
  experimental on Node 22.
- **A warning nobody sees.** Node 22 builds (VS Code 1.101 to at least 1.109)
  print one `ExperimentalWarning` per Extension Host, to its stderr only. It
  never reaches the output channel or the UI. Node 24 builds print nothing.
- **Types and bundling.** `@types/node` moves to `22.x` for the
  `node:sqlite` declarations. Webpack needs no change: it treats `node:sqlite`
  as an external on its own.
- **Still unverified:** remote Extension Hosts (Remote-SSH, WSL, Dev Containers,
  Codespaces run the VS Code Server's own Node), other VS Code-based editors -
  Cursor and VSCodium are in use by testers, and their *Help → About* shows the
  Node version to check against 22.15 - and macOS and Windows. So the store checks for the module at runtime. When it
  is missing, shared mode is refused with a message naming the runtime, and the
  workspace keeps its legacy file. There is no second store implementation to
  fall back to.

### 5. Repositories across workspaces

Developers lay out custom code in different ways, and the design accommodates
all of them rather than enforcing one:

- **One custom-addons path.** One clone per repo, which switches branches.
  Today's default.
- **A folder per version.** `~/v17/acme` and `~/v19/acme` are two clones of one
  repository, each on the branch its version runs.
- **Extension-managed copies.** `~/odoo-dev/acme@17.0-dev`, from *Use One Copy
  Per Branch*.
- **A different repository per version.** Rare.

Branch names often do not name a series. A repository typically carries every
version on `main`, `staging` and `dev` branches, and different branches run on
different Odoo versions. So the series of a branch is never read from its name
when the data can answer: a database says which branch each repo runs, and its
version says which series that is.

**One model underneath.** A project repo is one repository, identified by its
**remote URL**, with its name as the fallback. It can have any number of
**checkouts** on disk. The question the resolver answers is always: *which
checkout serves branch B for version V?*

1. A manual override: `version.settings.repoPaths[repoName]`.
2. A checkout with the same remote under V's **addons roots**.
3. A checkout with the same name under V's addons roots.
4. The legacy `repo.path`.

Then, in worktree mode, the existing per-branch copy for B
(`resolveRepoPath` in `repoPaths.ts`).

V's addons roots are `customAddonsPath`, which already exists per version,
generalised to a list. When a workspace is bound to V (§6), its folders are
offered as V's roots. That is how "the directories available in this workspace"
become that version's code. How each layout comes out:

- **One custom-addons path:** every version's roots are the same folder, so
  every version resolves to the one clone, and B is checked out there, exactly
  as today. When two versions need it at once, in an upgrade, the per-branch
  copies take over (§7).
- **A folder per version:** each version finds its own clone and B is checked
  out in it. The other versions' clones are never touched, and no copies are
  needed.
- **Extension-managed copies:** unchanged. A per-version workspace can simply
  open those directories.
- **A different repository per version:** the manual override.

`RepoModel` gains an optional `remoteUrl`, filled in lazily from
`git remote get-url origin`.

**One choke point.** `resolveProjectRepos(repos, assignments, root)` in
`services/repoPaths.ts` gains the version. Its consumers already route every
path through it: the debugger's addons path (`debugger.ts` `prepareArgs`),
module discovery (`psaeInternal.ts` `collectModuleDiscovery`), Project Repos,
workspace generation (`projectWorkspace.ts`) and the wrong-copy guard. The
places that still read `repo.path` directly (the Repos view, `checkout.ts`,
`environment.ts` `resolveProjectRepoBranchAssignments`, the upgrade setup) move
onto it too.

### 6. Binding a workspace to a version

The active version becomes a per-workspace choice (§1). The first time a
workspace opens a store, the extension proposes a version for it, e.g. "Use
*Odoo 19.0* in this workspace?". Detection, in order:

1. **Through the data.** A folder in this workspace is a checkout of a project
   repo, on branch B → a database maps that repo to B → that database's
   version. This works for `main`/`staging`/`dev`, where the name says nothing.
2. **Through the name.** `branchToSeries(B)`, when B is named after a series.
3. **Ask.** A quick pick over the store's versions, plus *Create Version*.

At most one question per workspace. The answer is stored in `workspaceState` and
mirrored to the registry. Switching versions later works exactly as today.

### 7. Upgrade across workspaces

The upgrade configuration is shared (§1), so both windows see the same pair,
the same Upgrade view and the same staged modules.

- **Each side resolves repos through its own version** (§5). In window A, the
  from-side runs 17.0's checkouts and the to-side runs 19.0's, which live in
  workspace B's folders. No messaging between windows is needed: the paths are
  in the main store.
- **Copies only where they are needed.** `buildUpgradePlan` (`upgradePlan.ts`)
  schedules a per-branch copy (`reposToWorktree`) only for repositories whose
  from- and to-locations resolve to **the same directory**. That is the
  single-path user, who gets exactly today's flow. The folder-per-version user
  gets no copies at all.
- **Start This Side**, next to Start Both Servers, starts the side whose
  version this window is bound to. Each window can then debug the code it
  holds. Start Both Servers still works from either window.
- **Open the Other Side** opens the workspace bound to the other version, from
  the registry (§3).
- The other side's running state comes from the existing `pg_stat_activity`
  probe (`runningState.ts`). It already reports a server this window did not
  start as `running (external)`.

### 8. Import and export

- **Export Data Store…** writes the whole main store as one JSON document with a
  `schemaVersion`.
- **Import Data…** reads one and offers **Merge** or **Replace**, with a preview
  of what will change (projects added or updated, versions matched, databases
  added):
  - projects merge by `uid`; databases by `id` within a project;
  - versions match by branch, not id, because ids differ between machines, and
    references are remapped;
  - templates merge by name.
- **Project export and import** (`exportProject` / `importProject` in
  `project.ts`) grow to carry databases, their branch mappings and module
  marks, and version references by series. Today they carry only the name, the
  repositories and the tickets.
- **Machine-specific fields** (`managedPaths`, virtualenv and worktree paths,
  `repoPaths` overrides) are marked in the export. On import they are kept when
  they exist on this machine. Otherwise the version is flagged unprovisioned, and
  Check Version Environments offers to rebuild it.
- **Relative paths are made absolute** against the source workspace whenever
  data moves into a shared store. A shared store never holds a workspace-relative
  path.

**Migration** is an import. The first time a legacy workspace chooses a shared
store:

1. its `.vscode/odoo-debugger-data.json` is imported with Merge;
2. its selection flags seed `workspaceState`;
3. the legacy file is left in place, renamed `…migrated.json`, so going back is
   a rename.

### 9. Cross-window guards

- **A version already running elsewhere.** Before starting, probe the version's
  port. When something is listening and it is not one of this window's debug
  sessions, say "Odoo 19.0 is already running, probably in another window",
  instead of letting Odoo fail to bind.
- **The provisioning queue gets a lease.** A row in the main store (or a lock
  file in the provisioning root, in legacy mode) with the owner's pid and a
  heartbeat. A window drains the queue only while it holds the lease, and a
  stale lease can be taken over. This also fixes problem 5 for today's users.
- **Things deleted underneath a window.** When a change event shows that this
  window's active version or selected database no longer exists, fall back to
  the next best one and say so once.
- **Live refresh.** `MainStore.onDidChange` invalidates `SettingsStore` and
  `VersionsService` (which gains a `reload()`), then runs
  `refreshAll({ reason: 'all' })`. The launch.json sync follows, so every
  window's Run and Debug dropdown lists every provisioned version.
- **"Save as default"** (`setSettingAsDefault`, `setAllSettingsAsDefault`)
  writes to Global instead of Workspace when the store is shared: a default
  that only applies in one of several windows is not a default.

## Alternatives considered

**Linked stores.** Each workspace keeps its own file, and an upgrade reads the
other workspace's file read-only. It is simpler, with no concurrency at all, but
it duplicates projects, versions and databases in every workspace. Keeping them
in step is the problem this design exists to remove.

**One multi-root window holding both versions.** A `.code-workspace` with
`~/v17` and `~/v19` side by side, one store, one extension host. Per-version
repo resolution (§5) makes this work for free, and it is worth supporting. But
it does not replace separate windows, which is how the developers this design is
for already work.

**Everything in the main store, keyed by workspace URI.** Per-window state could
live in the registry rows. That would make it visible to every window, but keyed
by a URI that changes whenever a folder is moved or renamed. `workspaceState` has
identity handled by VS Code.

**Enforcing one repository layout.** It would simplify §5 to a single rule, at
the cost of making every developer who works differently reorganise first.
Resolution is one function either way; the layouts cost a few lines each.

## Failure modes

| Situation | Behaviour |
|---|---|
| Store path points at nothing | Offer Create / Choose / Use Legacy. Never silently start empty. |
| Store stays locked through every retry (§4.2) | The save fails with a named error and the in-memory change is kept for retry. Never a partial write. |
| Two windows edit the same field of the same project | Last writer wins on that field. Logged in the Odoo DevTools output channel. |
| `workspaceState` lost (new profile) | The registry restores attached projects. The version binding is asked again, one question. |
| A version's repo location is missing on disk | Same as today's missing path: Project Repos flags it with *Relocate Repository*, now per version. |
| Store written by a newer extension (`schema_version` higher than known) | Open read-only and say so. Never downgrade the schema. |
| `node:sqlite` unavailable at runtime (e.g. a remote host or another editor on an older Node) | Refuse shared mode with a message naming the runtime; the workspace keeps its legacy file (§4.2). |

## Build order

Each step ships on its own and leaves the extension working.

1. **`MainStore` interface — implemented.** `JsonFileMainStore`
   (`services/mainStore.ts`) wraps today's file. The selected project, the
   selected database per project and the active version live in
   `workspaceState` (`services/workspaceSelection.ts`), seeded once from the
   file so existing users keep their selection. Generated project workspaces
   pin the file through `odooDebugger.dataStore.path` and hand the selection
   over, which fixes bug 6. Where it differs from the rest of this document:
   - `testingConfig.isEnabled` has **not** moved. Its module stash is project
     data, and moving the flag without the stash would split one state in
     two. It moves in step 2, together with the stash question under *Open
     questions*.
   - `odooDebugger.dataStore.path` is honoured **only at workspace level, and
     only for `.json` files**. A user-level value would make every workspace
     share one JSON file before step 2's concurrency safety exists.
   - A saved multi-root window keeps its launch configurations in the
     `launch` section of its `.code-workspace` file, and starts them with no
     folder (`launchTarget` in `services/launchConfig.ts`). `folders[0]` is
     the first repository in a generated window, and writing there shared one
     `launch.json` between every workspace listing it first. Entries earlier
     builds left there are removed on the first sync. The generated file is
     opened by its path: opened by its global-storage URI, the window was a
     `vscode-userdata:` workspace, which the target check missed and debugpy
     refuses. VS Code looks a configuration up by name only in a folder's
     `launch.json`, so Start Server passes the workspace file's entry as
     itself.
2. **The shared store — implemented.** `SqliteMainStore`
   (`services/sqliteMainStore.ts`), the three-way merge
   (`services/mergeDocuments.ts`), Choose Data Store / Export Data / Import
   Data (`commands/dataStoreCommands.ts`, `services/dataImport.ts`), change
   events through `PRAGMA data_version`, and testing mode per window with its
   stash on the database (`DatabaseModel.testingModuleStates`). Where it
   differs from the rest of this document:
   - **One `documents` table**, keyed by `(kind, key)`, rather than a table per
     kind; foreign keys and cascades wait for normalisation, when a query needs
     them.
   - **The legacy file is not renamed** after its data moves into a shared
     store. Project workspaces generated before the move pin that file, and
     renaming it would open them on an empty one - bug 6 again. It is simply no
     longer the one in use.
   - A `.db` store is honoured at user or workspace level; a `.json` store at
     workspace level only. New installs still use the workspace file: the
     shared store is opt-in, through Choose Data Store.
   - Verified with three processes committing 200 times each to one file: no
     update lost, a couple of hundred conflicts merged along the way.
   - **Tested in real windows** on 2026-09-29
     ([report](../notes/2026-09-29-shared-store-test-report.md)): the suite
     passed in a real Extension Host and nearly everything matched. The
     findings were fixed the same day - most importantly, `selectedDbByVersion`
     moved to the window (see §1), and the workspace's own JSON file keeps a
     copy of the selection.
     A second run confirmed those fixes and found four more, also fixed: a
     window could show one database and launch another after an upgrade was
     toggled from another window (the selection now comes before the memory);
     a refused save read as a command crash; two views still raised "No
     project is selected."; and the move-off picker offered a branch another
     worktree held. A third run confirmed those, except that a first upgrade setup
     still offered the branch its other side was about to use; both sides
     are now resolved before either is built.
3. **Per-version repo locations**, workspace binding and the registry.
   - **3a, repo locations — implemented.** `pickRepoCheckout` and
     `reposForVersion` (`services/repoPaths.ts`), the locator
     (`services/repoLocations.ts`), and one entry point for every consumer,
     `resolveReposForDatabase` / `reposSeenByDatabase`
     (`services/versionRepos.ts`): the launch entries, module discovery,
     scaffolding, Project Repos, the generated workspace and a database
     switch's checkouts. Order: `settings.repoPaths` override, a checkout
     under the version's `customAddonsPath` with the same remote, one there
     with the same name, `repo.path`. Only checkout-mode repositories are
     relocated; a copy-per-branch repository keeps its source. The remote is
     read on demand and cached, not stored. The upgrade setup and the
     wrong-copy guard deal only in per-branch copies, so they were left as
     they are until step 4.
   - **3b, binding a workspace to a version — implemented.** The binding
     lives in `workspaceState` under its own key (`services/workspaceBinding.ts`),
     not in the selection overlay, which is rebuilt from the data on every
     save. `proposeWorkspaceVersion` decides through the data, then the branch
     name; `shouldOfferBinding` asks only on a shared store with more than one
     version, once. Choosing activates the version through Switch Active
     Version. The bound window's folders are searched first for that
     version's checkouts (`extraRootsFor` in `services/versionRepos.ts`).
   - **3c, the registry — implemented.** A `workspaces` table beside the
     documents (`SqliteMainStore.listWorkspaces` / `recordWorkspace` /
     `forgetWorkspaces`); no schema bump, since older builds ignore it, and a
     read-only store records nothing. A window records itself on open and
     when its binding changes (`services/workspaceRegistry.ts`); rows unseen
     for 90 days or whose file or folder is gone are pruned. Surfaced in the
     Versions view tooltip and **Open the Workspace for a Version…** - the
     piece step 4's Open the Other Side builds on. Attached projects are not
     recorded: nothing attaches projects to a workspace yet.
4. **The upgrade plan** only copies shared directories; Start This Side; Open
   the Other Side.
5. **Cross-window guards** (§9). The provisioning lease can come first, since it
   fixes something already broken.

## Testing

In the house style: pure decisions tested as data, and I/O against real files.

- **Pure:**
  - the overlay split and merge (selection out, selection back in);
  - the snapshot diff that chooses which rows to write;
  - the conflict re-apply;
  - repo resolution across the four layouts;
  - version-binding detection;
  - import merge and remapping of versions by branch;
  - the plan's "copy only when both sides resolve to one directory" rule.
- **Integration**, in the Extension Host, with real files:
  - two `SqliteMainStore` instances on one file, standing in for two windows,
    writing different rows and then the same row, with no update lost;
  - `data_version` observed changing;
  - legacy file → shared store migration and back.
- **Manual:** two real windows on one store, per `docs/manual-test-brief.md`;
  the part no test can reach is whether each window is honest about which data
  it shows.

## Spike: is `node:sqlite` available?

About ten minutes, throwaway, never committed. It needs an Extension
Development Host on the **minimum VS Code version we support** (`engines.vscode`,
currently `^1.100.0`), and ideally on any VS Code-based editor the users rely
on, since those can ship an older Electron.

1. In `activate()`, temporarily add:

   ```ts
   logger.info('versions', JSON.stringify(process.versions));
   try {
       const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(path.join(os.tmpdir(), 'odt-spike.db'));
       db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t (v INTEGER)');
       db.prepare('INSERT INTO t VALUES (?)').run(Date.now());
       const dv = () => db.prepare('PRAGMA data_version').get();
       logger.info('sqlite ok', JSON.stringify(dv()));
       setInterval(() => logger.info('data_version', JSON.stringify(dv())), 2000);
   } catch (error) {
       logger.warn('node:sqlite unavailable', error);
   }
   ```

2. Press F5, then open a **second** Extension Development Host window on another
   folder.
3. Read the **Odoo DevTools** output channel in both:
   - Does `node:sqlite` load? Record `process.versions.node` and
     `process.versions.electron`.
   - Does each window's `data_version` change when the other window starts,
     since each insert is a commit from another connection?
   - Is an `ExperimentalWarning` printed, and where?
4. Record the outcome at the top of this document. If it loads on the minimum
   engine, §4 stands. If it loads only on newer versions, decide whether raising
   `engines.vscode` is acceptable. If it does not load, use the JSON fallback.

## Open questions

Answered 2026-09-29:

- **Default for new installs:** the workspace file, for now. The shared store
  is opt-in until it has been used for a while.
- **Testing mode's module stash:** on the database it was taken from. That also
  fixed turning testing off after switching databases, which restored one
  database's marks onto another.
- **Team sharing:** not a goal now. The store interface keeps a PostgreSQL
  backend possible without rework.
