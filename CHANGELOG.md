# Change Log

All notable changes to the "odoo-devtools-vscode" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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

## [Unreleased]

### Added

- **Version provisioning.** Creating a version now builds its environment: a git **worktree** for the branch, a Python interpreter that branch actually supports, a **virtualenv**, and its `requirements.txt` — awaited, with live progress and cancellation. Re-running is safe: provisioning probes what exists and does only what is missing, so a cancelled or failed run resumes, and an environment you built by hand is adopted rather than rebuilt.
- **Versions can now coexist.** Because each version owns its worktree, several branches are checked out at once — so a database can be compared before and after an upgrade — and activating a version performs no git operation, so it can no longer fail on a dirty working tree. The configured `odooPath` is used only as a source to cut worktrees from and is never itself used as a version's runtime, so it stays free to switch branches without silently changing what a version runs. Worktrees check out an `odt/<branch>` branch tracking `origin/<branch>`, since git will not check the same branch out twice.
- Above a branch's target Python, provisioning picks the **closest** available interpreter rather than the newest — running a branch far above the version it was written for fails at server initialization. If the requirements still will not install (Odoo 17.0's `gevent==21.8.0` pin has no Linux wheel and can no longer be built from source), it retries once on the next interpreter up and records which Python was actually used.
- **The required Python version is read from the branch**, not from a hand-maintained table: the floor from `setup.py`'s `python_requires` or `odoo/release.py`'s `MIN_PY_VERSION`, and the preferred interpreter from the distributions named in `requirements.txt`'s header (17.0 → 3.10, 18.0/19.0 → 3.12). An interpreter already present via pyenv or the system is reused when it fits; otherwise [uv](https://docs.astral.sh/uv/) installs the right one. Using an interpreter newer than the branch targets is allowed but warned about.
- **System dependency check** after provisioning: `wkhtmltopdf`, PostgreSQL client tools, `rtlcss`, and the build headers `lxml`/`psycopg2`/`ldap` need — each reported with what breaks without it and a copy-paste install command for the detected platform. Nothing is installed for you; nothing runs `sudo`.
- The Versions view shows whether each version is provisioned, and **Delete Version** offers to remove the folders the extension created (`git worktree remove` for worktrees) — never a checkout you made yourself.
- New settings `odooDebugger.provisioning.root` and `odooDebugger.provisioning.uvPath`.
- **Versions can now actually run in parallel.** Each derives a unique debugger name and port pair from its branch — `odoo:17.0` on 8017/5017, `odoo:18.0` on 8018/5018 — shown read-only in the Versions tree. Collisions step upward, checked against both the other versions and any port already being listened on. New setting `odooDebugger.debuggerNamePrefix` (default `odoo`).
- **One `launch.json` entry per provisioned version**, each carrying its own port and database, so the Run and Debug dropdown works as a version switcher and F5 launches the configuration it names. `Ctrl+Alt+O S` still follows the *active* version; the divergence is deliberate and lets one version be debugged from the dropdown while another runs from the chord.
- **Databases are remembered per version.** Selecting a database records it against the active version, so each version keeps its own `-d` when several run side by side. Resolution falls back to the project selection, matching the previous behaviour when no memory exists.
- **The Databases view marks which databases are live** — `running :8017` for a server this extension started, `running (external)` for one started from a terminal or another window, detected via `pg_stat_activity`. Backed by a `runningState` service rather than view logic, so later features share one state source.
- **Generated project workspaces include the active version's core checkouts**, so files opened from them belong to the version being run and breakpoints bind to the right worktree.
- **Each version's port is visible everywhere it matters** — in the Versions tree (`17.0 • :8017 • running`), in the status bar, and in the tooltip as a clickable `http://localhost:8017`. A new **Open Server in Browser** action on a version row opens that version's port directly.
- **First-run setup.** `Odoo DevTools: Set Up` detects Odoo checkouts already on the machine and proposes them in a single confirmation instead of asking five questions. It writes `odooDebugger.sourceRepo.odoo` (plus optional `.enterprise` / `.designThemes`) and `odooDebugger.provisioning.root` at **user level**, so one setup covers every workspace; a workspace can still override. A dismissible notification and welcome buttons point at it when the machine is not set up.

### Changed

- **`preCheckoutCommands` and `postCheckoutCommands` are replaced by one `postSwitchCommands` list**, which runs after a version's environment is aligned — whether or not a branch checkout was needed — once per core repo. `postCheckoutCommands` is renamed automatically, in stored versions and in settings. **`preCheckoutCommands` is removed rather than migrated**: it guarded a checkout that was about to happen (typically `git restore .`), and provisioning removes the checkout — running the same command afterwards would discard uncommitted work instead of clearing the way. A one-time notice names the exact commands dropped so any still worth keeping can be re-added. Installing Python requirements no longer belongs in a hook; provisioning owns it.
- Hooks are read from **the version first** and the global default second. The per-version hook fields shown in the Versions tree were previously never read at all.
- **`odooDebugger.defaultVersion.debuggerName`, `.portNumber` and `.shellPortNumber` are removed.** They gave every version one shared identity, so two versions overwrote each other's `launch.json` entry and could not run at once. The three values are now derived from each version's branch and are read-only in the Versions tree. Existing versions are **healed, not rewritten**: a stored name or port survives unless it is missing or collides with an older version's, and each change is logged to the output channel.
- **Stop Server** targets the active version's session and prompts only when several versions are running and none is the active one. Restarting a version stops that version's session alone, leaving the others up.
- **The source repository is now its own setting** (`odooDebugger.sourceRepo.odoo`) rather than a per-version default that provisioning happened to reuse. `odooDebugger.provisioning.root` defaults to `~/odoo-dev` instead of the source repo's parent, so moving the source repo no longer silently relocates every future environment. An existing `defaultVersion.odooPath` pointing at a real checkout is adopted automatically on first activation.
- **Open in Browser opens the port actually serving the database**, resolved from the running session first, then the database's own version, then the active version. Previously it always used the active version's port, which is the wrong answer as soon as two versions run at once. A port with nothing listening is reported rather than opened into a connection-error tab.

### Fixed

- **"Setup Odoo" cloned the repositories and then forgot where it put them.** It wrote no configuration at all, while provisioning read `./odoo` from the workspace — so answering *"Choose a different folder…"*, an offered answer, produced a successful clone followed by *"No Odoo repository at &lt;workspace&gt;/odoo. Run 'Setup Odoo' first."* Setup now records what it did.
- **The Versions view `+` button no longer appears to do nothing.** It awaited the full remote branch list before showing any UI — on the odoo repository that is ~68,700 refs (measured at 1.7s of git time and 7.6 MB of output), nearly all of them PR branches on the `dev` remote, every one marshalled across the extension host and turned into a quick pick item. The picker now opens immediately and fills in, and lists release branches (75 entries, ~0ms) rather than everything. PR and development branches stay reachable through a **Search all branches…** row that pays the cost only when asked. *Change Branch* used the same blocking path and is fixed with it.
- **Setup Odoo no longer fires the environment setup into a terminal and returns.** It wrote `python -m venv` and `pip install` into a terminal without awaiting them, so the virtualenv check that followed ran before anything existed and new version profiles were almost always created with no `pythonPath`. Provisioning awaits its work and reports real failures.
- Post-switch hooks now run when the **version** changes, not only when a branch differs. A provisioned version's worktree is already on the right branch, so the branch diff is empty and hooks would otherwise never fire.

## [1.1.0 and earlier]

- Initial release