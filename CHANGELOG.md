# Change Log

All notable changes to the "odoo-devtools-vscode" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.3.1] - 2026-10-12

### Added

- **A version's debugger name and ports can be set by hand.** They are still filled in from the branch, so parallel versions do not collide, and marked *automatic* in the Versions view; clicking one now edits it instead of refusing. A value you set is marked *set by you* and kept when the branch changes and by Set All to Default Values; **Make Automatic Again**, on the row's right-click menu, hands it back. Versions may share a port or a debugger name — you are warned, and only one of them runs at a time. Versions sharing a debugger name share one launch entry that always runs the active version, so F5 runs whatever version and database are selected. Renaming removes the old entry from the Run and Debug list. Start Both Servers refuses an upgrade pair that shares a name or port.

### Fixed

- **Clone Database and Create Database never replace an existing database.** Cloning, or creating from a template, a fresh database or a dump, to a name that already existed in PostgreSQL dropped that database first — silently when no project linked it. The name prompts now refuse any name PostgreSQL already has.
- **Create Database adds nothing to the project when PostgreSQL did not create the database** — a name taken in the meantime, an unreachable server or an unreadable dump used to be recorded anyway.
- **Delete Database no longer says "deleted successfully" when the drop failed** (a server still connected, typically). The error is shown and the database stays in the list. Restore Database likewise only reports success when it worked.
- **A version launches only against a database of that version.** With no 19.0 database chosen, the 19.0 launch entry and Start Server used the selected database whatever its version, running 19.0 code against a 17.0 database. Such a version's entry is now left out of `launch.json` until you pick one of its databases, and Start Server asks for one, offering only that version's. Picking another version's database keeps the first version's for its own entry.
- **The status bar names the database the active version launches**, or reads *no 19.0 database* when it has none, instead of pairing the active version with another version's selected database.
- **Switching databases no longer raises "Git: There are no available repositories"** in a window that does not have that repository open.
- **Opening the side bar in a window without a project no longer raises "No projects yet." or "No project is selected."** The views show their welcome content instead; commands still ask.
- **Open Project Workspace opens the generated workspace by its file**, so the Python debugger runs in that window. A window opened the old way, from the Recent list, offers once to reopen it.
- **Moving a checkout off a branch offers only branches it can move to**, not one another worktree holds or one the same setup is about to give its own copy; with none left, it says why and suggests detaching.
- **A first upgrade setup no longer offers the target side's branch** as the one to move the source checkout onto.
- **Upgrade branch pickers mark the branch the checkout is actually on as *current branch***; the row the picker opens on is *suggested*.
- **Set All as Default saves the version's settings** instead of failing halfway on one that has no default.

## [1.3.0] - 2026-09-02

> **Beta.** The provisioning, worktree and setup flows in this release are new and have had limited real-world use. Please report anything that surprises you.

### Added

- **Versions provision themselves.** Create Version now builds a complete environment for a branch: a git **worktree**, an interpreter that branch actually supports, a `uv`-backed virtualenv and its `requirements.txt` — with live progress and cancellation. Choose *Profile only* to register a version without building anything. Re-running is safe: it builds only what is missing, so a cancelled or failed run resumes, and an environment you built by hand is adopted rather than rebuilt.
- **Several versions can be checked out at once.** Each version owns its worktree, so activating one no longer checks anything out and can no longer fail on a dirty working tree. Comparing a database before and after an upgrade is now two live environments rather than two checkouts of the same directory. Each worktree checks out an `odt/<branch>` branch tracking `origin/<branch>`, since git will not check one branch out twice. Generated project workspaces include the active version's own core checkouts, so breakpoints bind to the right worktree.
- **Per-version custom code.** A repository can be switched to **Use One Copy Per Branch** (right-click it in Repos), after which each branch it is mapped to gets its own worktree under the provisioning root. The addons path, module discovery, scaffolding, the Project Repos tree and the generated workspace all follow the active version, so two versions run against their own custom addons. Unlike the Odoo worktrees, these copies check out the real branch, so commits and pushes go where you expect. Freeing a branch the source checkout holds is explicit: moving it to another branch is offered first, detaching second, and a checkout with uncommitted changes is refused with its changed files named. Repositories stay in plain checkout mode unless you opt in.
- **First-run setup.** **Odoo DevTools: Set Up** asks for the source repository and the environments directory (`~/odoo-dev` by default), detecting both where it can. Answers are stored at user level (`odooDebugger.sourceRepo.odoo`, optionally `.enterprise` and `.designThemes`, and `odooDebugger.provisioning.root`), so later workspaces are already configured; a workspace needing a different fork can override them. A notification offers this on first activation.
- **Running indicators.** The Databases view marks which databases are live — `running :8017` for a server this extension started, `running (external)` for one started from a terminal or another window — and each version shows the port it serves, with a clickable `http://localhost:<port>` in its tooltip and **Open Server in Browser** on its row. **Open in Browser** opens the port actually serving the database — its running session's, else its version's, else the active version's — and reports a port with nothing listening rather than opening it.
- **One `launch.json` entry per provisioned version**, each with its own port and database, so the Run and Debug dropdown works as a version switcher. `Ctrl+Alt+O S` follows the *active* version; the difference is deliberate, so one version can be debugged from the dropdown while another runs from the chord.
- **Databases are remembered per version.** Selecting a database records it against the active version, so each version keeps its own `-d` when several run side by side.
- **The required Python version is read from the branch**, not from a hand-maintained table: the floor from `setup.py`'s `python_requires` or `odoo/release.py`'s `MIN_PY_VERSION`, the preferred interpreter from the distributions named in `requirements.txt`'s header (17.0 → 3.10, 18.0/19.0 → 3.12). An interpreter already present via pyenv or the system is reused when it fits; otherwise [uv](https://docs.astral.sh/uv/) installs one. Above the target, the closest interpreter is picked rather than the newest, and one newer than the branch targets is warned about.
- **A system dependency check** after provisioning: `wkhtmltopdf`, the PostgreSQL client tools, `rtlcss`, and the build headers `lxml`/`psycopg2`/`ldap` need — each reported with what breaks without it and a copy-paste install command for the platform. Nothing is installed for you and nothing runs `sudo`.
- The Versions view shows whether each version is provisioned, and **Delete Version** offers to remove the folders the extension created (`git worktree remove` for worktrees) — never a checkout you made yourself.
- New settings: `odooDebugger.provisioning.root`, `odooDebugger.provisioning.uvPath`, `odooDebugger.debuggerNamePrefix` (default `odoo`) and `odooDebugger.sourceRepo.*`.
- **Odoo DevTools: Check Version Environments** diagnoses versions left behind by an older layout (missing, unprovisioned or outside the current provisioning root) and offers to rebuild them.
- A warning when you open a file belonging to a version other than the active one, so edits do not land in the wrong copy. Dismissible for the session or permanently.
- **Setup offers the versions to build.** Finishing setup now asks which Odoo versions you want, the list coming from your own repositories' branches and the source repository's real branch list rather than a hardcoded table. The first is built while you wait; the rest are queued and built one at a time, resuming after a window reload, with `building…` and `queued` shown on the version rows.
- **Setup records where your custom addons live**, so creating a project finds your repositories instead of failing on a path nobody configured. Leaving it unset stays a valid answer — the repository picker then offers to browse.
- **Upgrade mode.** An upgrade is now a mode with its own **Upgrade** view, not a one-shot wizard: it is set up by naming the two databases being compared, everything else is deduced from them. The view shows both sides — version, database and the branch each repository runs — and starts both servers. `Ctrl+Alt+O Shift+U` toggles it.
- **Upgrade mode toggles without forgetting.** Turning it off gives the target database its own modules back and keeps everything else — the pair, the branches, the copies and any module marks changed by hand — so turning it back on resumes the same upgrade without a question. Anything removed while it was off, a copy or a version, is rebuilt on the way back in. **Change the Upgrade** reopens setup with the current databases preselected.
- **Project Repos shows both copies during an upgrade**, each marked with the side it runs, instead of only the selected database's. Opening a file from the side that is not selected no longer warns that it belongs to another version.
- **Start Both Upgrade Servers** starts each side on its own database and its own port, so the two versions run side by side with no picking from the Run and Debug dropdown.
- **The target database can be created as part of the setup.** Choosing *Create a new database* asks the target version and branch — which the pair needs anyway — and creates an empty database from them, instead of requiring one to exist first.
- **Versions built before provisioning are offered a migration** rather than left to fail later. A version running out of the source repository is now reported as unsafe rather than merely relocated, because switching that repository's branch changes what it runs.

### Changed

- **Debugger name and ports are derived from the version's branch** — `odoo:17.0` on 8017/5017 — and are read-only, so parallel versions cannot collide on a port. Collisions step upward, checked against the other versions and any port already listened on. `odooDebugger.defaultVersion.debuggerName`, `.portNumber` and `.shellPortNumber` are removed: they gave every version one identity, so two versions overwrote each other's launch entry. Existing versions are healed, not rewritten: a stored name or port survives unless it is missing or collides with an older version's, and each change is logged.
- **Database creation asks which branch each project repository should use** instead of silently recording whatever was checked out at the time — before anything is created or restored, so cancelling costs nothing. Cloning a database inherits its source's mapping. The Databases view shows the repo-branch count on the row, and Configure Project Repo Branches is an inline action.
- `db.branchName` is removed: a database's core branch comes from its version, which is the only place it was ever authoritative. Legacy values are folded into the database's Odoo version where no version profile matches. A database moved to another version no longer reads `17.0 • Odoo 19.0`.
- Switch notifications say what will actually happen — reusing an existing worktree, checking out a branch, or reporting a missing environment — rather than always promising a checkout. Rapid database selections no longer leave two contradictory prompts standing.
- **Back navigation in the multi-step flows.** Create Project, Create Database, Create Version and Set Up an Upgrade now carry VS Code's Back button on every question, so picking the wrong repository means one step back rather than escaping the flow and retyping everything. Back from the first question closes the flow.
- **The upgrade no longer refuses a branch whose name does not state its Odoo series.** `dev/upgrade-client` is an ordinary branch name; it now asks which series that side runs, offering the series you already have, instead of failing after five answers.
- **The extension now starts with VS Code** (`onStartupFinished`). Without it, activation waited for one of its views to be opened, so the first-run prompt could only reach someone who had already found the extension.
- **The setup confirmation is a modal.** It was a quick pick's one-line detail, truncated after "Source:" — hiding that detection can propose an enterprise repo, a design-themes repo and an addons folder from anywhere on the machine, all written at user scope on one keystroke.
- **Setup's custom addons folder now reaches the active version**, not just the user-level default. Repository discovery reads the version's own copy, so setup reported success while Create Project searched a `./custom-addons` that never existed.
- The version multi-select offers versions from your addon repositories on a first run, where there are no projects to read them from yet — and **`master` is never the pre-ticked default**, so the out-of-the-box choice no longer spends ~2 GB on the development branch.
- The one-copy-per-branch dialog no longer promises directories and lists none when nothing is mapped yet, names the original checkout by absolute path, and says *copies* on its button instead of *worktrees*.
- **Use a Single Checkout** is a Command Palette command only; neither repository tree offers it.
- **A legacy version running out of the source repository is diagnosed as such even when its interpreter is also missing** — the exact 1.2 shape, previously reported as merely `unprovisioned` and stripped of the wording explaining why it is unsafe.
- Upgrade branch pickers preselect their seeded branch (a description alone never moved the selection), and the *upgrading to* list no longer offers the branch just chosen as *upgrading from*.
- Setup no longer asks *provision or profile only?* about a version you already chose to build.
- Three more places that said "No projects found. Create a project first." now offer **Create Project** instead of stacking a dead-end toast on the one that does.
- **Per-repository branch mapping is one picker, not one dialog per repository.** Every row is pre-seeded with the branch already mapped, or the branch the repository is on, so the common case is a single confirmation instead of N; only rows that are wrong cost anything. Cancelling no longer discards every answer given so far.
- **The upgrade flow asks per repository.** Reading both branches from the first repository and applying them to the rest produced a branch assignment naming a branch the other repositories did not have, surfacing much later as a checkout failure.
- **The debugger sync no longer arbitrates git state.** It creates the per-branch copies that need no decision and reports the rest as an offer; the modal that asks to move or detach a source checkout now only appears inside a command you started. **Create Missing Per-Branch Copies** is that command.
- **Change Branch rebuilds the version's environment** instead of leaving it running the old branch under the old branch's debugger name and ports.
- Cancelling project creation is no longer reported as an error.
- **Use One Copy Per Branch** is on the repository right-click menu in the **Repos** view, not only in Project Repos.
- The upgrade flow picks both branches from the repository instead of asking you to type them, and shows its plan as a readable modal.
- **Choose Custom Addons Folder** is a command and an action on the empty Repos view; choosing a folder now updates the active version, so discovery picks it up immediately instead of only affecting versions created later.
- Actions that need a project no longer stack a second, less useful notification on top of the one that offers **Create Project** / **Select Project**.
- **Checkout hooks are consolidated into `postSwitchCommands`**, which runs after a version's environment is aligned, once per core repository — also when only the version changed, since a worktree is already on its branch. `postCheckoutCommands` is renamed automatically, in settings and stored versions. `preCheckoutCommands` is removed rather than migrated: it guarded a checkout that provisioning no longer does, and running it afterwards would discard uncommitted work; a one-time notice names what was dropped. Hooks are read from the version first and the default second; the per-version hook fields were never read before. Installing Python requirements belongs to provisioning, not to a hook.
- **Stop Server** targets the active version's session, and asks only when several versions run and none is the active one. Restarting a version stops that version's session alone.
- The configured source repository is never run directly; versions always run from their own worktree, leaving that checkout yours to switch freely. It is its own setting, `odooDebugger.sourceRepo.odoo`, rather than a per-version default; `odooDebugger.provisioning.root` defaults to `~/odoo-dev` instead of the source repository's parent, and an existing `defaultVersion.odooPath` pointing at a checkout is adopted on first activation.
- **The upgrade asks which two databases are being compared**, and deduces the rest from them: each side's Odoo series from the database itself, each side's version by matching that series, and each repository's branch by name. Only what cannot be deduced is asked. Setting an upgrade up costs about four answers instead of one per repository plus four.
- **One dialog, then one progress notification.** The per-repository copy modals are gone — the single confirmation names the directories it will create — and the copies are created by the command, with progress, rather than silently minutes later by the debugger sync. The confirmation is an information dialog, because it is a confirmation and not a warning.
- **The upgraded database is built by installing the source database's module set**, staged onto the target as `install`, rather than by running `-u all`. Modules with no counterpart in the target version are left out and named. A toggle in the Upgrade view turns the staging off, giving the target back its own modules, and on again as it was left.
- **Upgrade mode blocks what would break the pair** and says so, offering *Exit Upgrade Mode*: testing mode, changing either database's version or its repository branches, renaming, restoring or deleting a paired database, deleting a paired version, changing a version's branch or settings, and switching a paired repository's branch mode. Everything harmless stays available — Open in Browser, psql, Clone, Copy Database Name.
- **Selecting either database of the pair now chooses whose modules the Modules view edits**, without realigning the environment onto that side's branches. Both rows read as checked; the selected one still stands out.
- **Set Up an Upgrade has one entry point**, the Upgrade view, and the toggle row reads *Upgrade Enabled* / *Upgrade Disabled* — the shape testing mode already uses. The Versions view title icon and the repository right-click entry are removed.

### Fixed

- **Restart Server's command id is now `odt.server.restart`.** It was `odoo.restartServer`, which the official Odoo extension also registers, so whichever loaded second failed to register it. The keybinding (`Ctrl+Alt+O R`) and title are unchanged; a custom keybinding bound to the old id needs updating.
- **Only an upgrade database can look selected during an upgrade.** A database selected before upgrade mode started kept its selected icon next to the pair, and couldn't be moved off it because selecting outside the pair is refused. The selection now moves to the "upgrading from" database. Clicking a database outside the pair also no longer leaves its row highlighted beside the actual selection.
- **Repositories keeping one copy per branch have their file actions back in Project Repos.** Their root rows matched none of the root menus, so New File, New Folder, Reveal, Copy Path and Open in Terminal were missing on every such repository — which, during an upgrade, is all of them.
- **Switching databases no longer drags a repository's own checkout onto a branch one of its copies owns.** Environment alignment checked out the assigned branch into the source repository whatever mode the repository was in, so every switch re-armed the *source is still checking out one of these branches* dialog even when the copies were correct. Alignment now only touches repositories that are in single-checkout mode.
- **The per-branch copy that already holds the branch is no longer arbitrated.** The check that a copy already satisfies its branch ran after the conflict gate rather than before it, and the branch cache was not invalidated after a switch or detach, so a conflict just resolved was reported again for three seconds.
- **An upgrade whose target version does not exist yet now writes the target side's branches.** They were looked up through the target version's id, which on a first-time upgrade is `undefined` — so no target-side branch assignment was ever recorded.
- **The version offered when a database's Odoo series has no profile can now run.** It created a bare profile that Start Server immediately refused; it goes through provisioning.
- Setup no longer queues the remaining versions before the foreground build finishes, which let a queued `pip install` run beside it.
- **Migrating a version built before provisioning no longer duplicates it.** Accepting *Migrate* rebuilt the environment but created a second version for the same branch, on a shifted port; the existing version is now repointed in place.
- Stale `git worktree` records no longer reserve a branch a new version needs (the `'odt/19.0' is already used by worktree at ...` failure), so a version whose folder was deleted can be rebuilt. A branch still held by a live worktree elsewhere is adopted rather than duplicated, and the reuse is reported.
- Interpreter selection steps up to the next supported Python when a pinned requirement has no wheel for the closest match.
- The branch picker opens immediately instead of after enumerating every ref (~68,700 on the odoo repository), so the Versions view's `+` no longer seems to do nothing. It lists release branches; a **Search all branches…** row reaches PR and development branches. Change Branch is fixed with it.
- **Setup records where it cloned the repositories.** "Setup Odoo" wrote no configuration, so a clone into another folder was followed by "No Odoo repository at <workspace>/odoo".
- **Building an environment waits for its work.** Setup used to type `python -m venv` and `pip install` into a terminal and return, so new versions were almost always created with no `pythonPath`. Provisioning awaits each step and reports real failures.
- A database is remembered against the version it switches *to*, not the one it switched from.
- The first branch pick after setup lists the source repository's branches instead of falling back to a free-text box.
- Cloning during setup no longer asks for a branch or a clone depth: that clone is only ever a source to cut worktrees from.
- Creating a project no longer dead-ends when the custom addons path points at nothing; it offers a folder picker and remembers the answer.
- A background refresh no longer raises "create a project first" on an install that has no projects yet.
- Starting the server reports what is actually wrong — an unprovisioned version or an unselected database — instead of VS Code's generic launch failure.

## [1.2.0] - 2026-07-23

### Changed

- **Databases now carry their full environment.** Selecting a database aligns the active version, the core Odoo repo branches, and the project repo branches through a single switch pipeline with one summary notification, replacing three different prompt flows.
- `odooDebugger.databaseSwitchBehavior` simplified to `auto` (new default) / `ask` / `never`. Legacy values (`auto-both`, `auto-version-only`, `auto-branch-only`) are migrated automatically. `ask` is now a single non-modal notification instead of a blocking quick-pick.
- **Database creation is 2–3 prompts instead of ~6**: choose the method, pick the source (dump/template/existing), confirm the pre-filled name. The version is auto-detected from the database itself (base module version), and the current branch of every project repo is captured automatically as the database's working state.
- **Connect to Existing** now lists your live PostgreSQL databases instead of asking you to type a name.
- **Version creation is 2 prompts**: pick the branch (listed from your odoo repo), confirm the suggested name. Paths and ports come from `odooDebugger.defaultVersion.*` and stay editable in the Versions tree.
- New databases use their plain PostgreSQL identifier as the display name (the "Project • Kind • Date • #hash" format is retired; existing names are kept).

- The Modules view uses theme icons instead of emoji (down-arrow = install, up-arrow = upgrade, filled circle = installed, outline = not installed), and `ps*-internal` directories are collapsible groups with an explicit include/exclude toggle instead of inline pseudo-modules.
- launch.json is updated surgically: only the extension's own configuration entry is rewritten — user comments, formatting and other configurations are preserved.
- The command palette no longer lists tree-only commands that errored when invoked without a selection (~50 commands hidden); user-invokable commands are grouped under the **Odoo DevTools** category.
- Testing view: the Add Test Target / Set Test File buttons only appear while testing is enabled; naming-convention hints are shown inline in the input box; the command preview includes `--log-level`.
- Dump restore runs entirely without a shell (database names and paths are passed as process arguments), and the development neutralization tolerates missing tables (e.g. dumps without `hr`).
- **Every view now uses theme icons** — the emoji markers in Projects, Repos, Databases, Testing and the version pickers are replaced by consistent codicons: a green check-circle marks the active project/database/version, filled/outline circles mark selection, and database origin ("backup"/"existing") moved into the description text.
- Project Repos (Explorer): file operations moved from hover icons into the right-click menu (grouped like the built-in Explorer) and now actually work; **Delete, Cut, Copy and Paste were removed** — destructive file management stays in the built-in Explorer. Reveal in Explorer is available on every item.
- Empty views show welcome content with action buttons (Create Project, Create Database, Manage Versions, Select Project) instead of placeholder rows, and loading an empty state no longer fires error notifications.
- Projects show a "N repos • N dbs" description; projects, versions and repos have detailed markdown tooltips (branches, ports, paths, active database).

### Added

- Odoo version auto-detection from PostgreSQL: restored/connected databases are probed for their Odoo series (e.g. `17.0`, `saas-17.4`) and linked to the matching version profile, with a one-click offer to create the profile when missing.
- **Status bar indicators** for the active project, database and version — click to switch (`odooDebugger.statusBar.enabled`).
- **Keybindings**: `Ctrl+Alt+O` + `S`/`X`/`T`/`D`/`V` for Start/Stop Server, Toggle Testing Mode, database quick-switch and version switch; new `Stop Server`, `Toggle Testing Mode` and `Switch Active Version` palette commands.
- **Clone Database** and **Copy Database Name** context actions in the Databases view.
- **Reconcile Databases**: detects stored database/template references whose PostgreSQL database no longer exists and removes them in one multi-select pass (activation logs stale references silently).
- **Relocate Repository**: repos whose folder was moved or deleted are flagged in Project Repos with a one-click relocation flow; repo items show their current git branch.
- **Module dependencies**: expand a module to see its `depends` from the manifest, marked as project modules vs core.
- **Detect Tickets from Branches & Manifests**: scans repo branch names and module manifests for ticket/task ids and adds them to the project's tickets.
- **Getting Started walkthrough** (VS Code Welcome page).
- New sort options: modules by installed state, repos by branch.
- All diagnostics now go to the **Odoo DevTools** output channel.
- **Run Server Without Debugging** (`Ctrl+Alt+O N`) and **Restart Server** (`Ctrl+Alt+O R`).
- **Open Odoo in Browser** (`Ctrl+Alt+O B`) using the active version's port and the selected database; per-database *Open in Browser* and *Open psql Shell* context actions; optional `odooDebugger.server.openBrowserOnStart` opens the web client automatically once the server port is up.
- **Copy Odoo Command**: copies the exact `python odoo-bin …` command line the debugger runs (from the selected project, active version and database) to the clipboard.
- **Editor actions** on files inside an Odoo module (toggle with `odooDebugger.editorActions.enabled`): *Run Odoo Tests for Current File* (`test_*.py` — enables testing, targets the file and its module, starts the server), *Upgrade Current Module* (marks for `-u`, offers a restart) and *Reveal Module in Modules View*.
- **Multi-select in the Modules view**: set install/upgrade/clear for the whole selection at once.
- **Setup Odoo rework**: choose *Full setup* or *Clone repositories only*, pick which repositories to clone (community/enterprise/design-themes) and whether to make a **shallow copy** (`--depth 1 --single-branch`) or a full clone. Clones run with live git progress and are cancellable; after a clone-only run the extension offers to continue the full setup and/or **create a version profile** pointing at the cloned repositories.
- **Reveal in Explorer / Reveal in OS** context actions on module items in the Modules view.
- **Git-less addons folders are now discovered as repos**: a folder under the custom addons path that contains Odoo modules shows up in the Repos view (marked *addons folder*) even before `git init` — branch display and checkout are simply skipped for it.
- **Configure Modules quick pick** (`Ctrl+Alt+O M`, also in the Modules view title bar): Enter cycles install → upgrade → unmanaged, per-item buttons set a state directly, and the picker stays open for several changes.
- **Repos view context menu**: reveal in Explorer/OS, copy path, open in terminal on repo items; unselected repos use the same small open-circle icon as the Modules view.
- **Project quick search matches metadata**: typing a repo, database, module or ticket id in the project picker (`Ctrl+Alt+P`) finds the project that owns it.
- Setup Odoo: branch list refreshed for Odoo 19.0, and the clone destination is selectable (workspace folder by default).
- **Rename Display Name** context action on databases — change the label shown in the extension without touching the PostgreSQL database.
- **Keyboard Shortcuts cheat sheet** (`Ctrl+Alt+O K`, palette, Projects view `…` menu): lists every keybinding straight from the extension manifest; picking an entry runs its command, and a last entry opens the Keyboard Shortcuts editor.
- **Chords for all common actions**: `Ctrl+Alt+O` + `C` create project, `Shift+D` create database, `Shift+M` create module, `Shift+V` create version, `L` manage/link tickets, `O` open ticket, `W` open project workspace, `H` Odoo shell, `U` upgrade current module, `F` run tests for current file — plain letters act, `Shift` variants create the matching thing.
- **Menu reorganization**: view title bars keep at most three icons (create/search plus the view's primary action) with everything else in the `…` overflow, grouped (project/server/view, bulk/view, database/view); context menus are grouped semantically with destructive actions (Delete Project/Database/Version) isolated at the bottom — and Delete Project is no longer an inline hover icon.
- Default version settings refreshed to the 19.0 era (`odoo:19.0`, ports 8019/5019) — existing version profiles keep their stored values.

### Removed

- **The Project Repos activity-bar container.** The feature lives on as the more capable *Project Repos* view in the Explorer sidebar (file operations, watchers, sort/search, branch display); the two views were near-duplicates.
- The unimplemented contributed commands (`Get Database`, Explorer `New File`/`New Folder`/`Rename`/`Delete` aliases), which errored with "command not found".
- The accidental `install` and `npm` runtime dependencies.

### Fixed

- Module and repo status icons stayed legible when a row is highlighted: state is now carried by icon **shape** (module install = down-arrow, upgrade = up-arrow, installed = filled circle, absent = outline; repo in-project = check, otherwise outline) instead of color alone, which VS Code strips on the selected row. Previously the install/upgrade/installed states all collapsed into one indistinguishable dot when clicked.
- "Configure Version Defaults" opened the Settings UI with a wrong extension id filter (showed nothing).
- The Projects view welcome content ("Open a folder…") never rendered due to a broken `when` clause.
- Starting the server no longer kills unrelated debug sessions — only the extension's own session is restarted.
- The "Added base during initialization" notification no longer repeats on every refresh for uninitialized databases.
- Database names containing shell metacharacters can no longer break (or abuse) database operations: all `psql`/`createdb`/`dropdb` calls use argument arrays without a shell.
- The extension package no longer ships sources, `node_modules` and old `.vsix` files (~13 MB → a few hundred KB).
- Legacy per-database `odooVersion` data is migrated into version links (or the branch label) on first activation.

## [1.1.0 and earlier]

- Initial release