# Change Log

All notable changes to the "odoo-devtools-vscode" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.2.0] - Unreleased

### Changed

- **Databases now carry their full environment.** Selecting a database aligns the active version, the core Odoo repo branches, and the project repo branches through a single switch pipeline with one summary notification, replacing three different prompt flows.
- `odooDebugger.databaseSwitchBehavior` simplified to `auto` (new default) / `ask` / `never`. Legacy values (`auto-both`, `auto-version-only`, `auto-branch-only`) are migrated automatically. `ask` is now a single non-modal notification instead of a blocking quick-pick.
- **Database creation is 2–3 prompts instead of ~6**: choose the method, pick the source (dump/template/existing), confirm the pre-filled name. The version is auto-detected from the database itself (base module version), and the current branch of every project repo is captured automatically as the database's working state.
- **Connect to Existing** now lists your live PostgreSQL databases instead of asking you to type a name.
- **Version creation is 2 prompts**: pick the branch (listed from your odoo repo), confirm the suggested name. Paths and ports come from `odooDebugger.defaultVersion.*` and stay editable in the Versions tree.
- New databases use their plain PostgreSQL identifier as the display name (the "Project • Kind • Date • #hash" format is retired; existing names are kept).

- The Modules view uses theme icons instead of emoji (green/yellow = install/upgrade, filled/outline = installed or not), and `ps*-internal` directories are collapsible groups with an explicit include/exclude toggle instead of inline pseudo-modules.
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
- **Menu reorganization**: view title bars keep at most three icons (create/search plus the view's primary action) with everything else in the `…` overflow, grouped (project/server/view, bulk/view, database/view); context menus are grouped semantically with destructive actions (Delete Project/Database/Version) isolated at the bottom — and Delete Project is no longer an inline hover icon.
- Default version settings refreshed to the 19.0 era (`odoo:19.0`, ports 8019/5019) — existing version profiles keep their stored values.

### Removed

- **The Project Repos activity-bar container.** The feature lives on as the more capable *Project Repos* view in the Explorer sidebar (file operations, watchers, sort/search, branch display); the two views were near-duplicates.
- The unimplemented contributed commands (`Get Database`, Explorer `New File`/`New Folder`/`Rename`/`Delete` aliases), which errored with "command not found".
- The accidental `install` and `npm` runtime dependencies.

### Fixed

- "Configure Version Defaults" opened the Settings UI with a wrong extension id filter (showed nothing).
- The Projects view welcome content ("Open a folder…") never rendered due to a broken `when` clause.
- Starting the server no longer kills unrelated debug sessions — only the extension's own session is restarted.
- The "Added base during initialization" notification no longer repeats on every refresh for uninitialized databases.
- Database names containing shell metacharacters can no longer break (or abuse) database operations: all `psql`/`createdb`/`dropdb` calls use argument arrays without a shell.
- The extension package no longer ships sources, `node_modules` and old `.vsix` files (~13 MB → a few hundred KB).
- Legacy per-database `odooVersion` data is migrated into version links (or the branch label) on first activation.

## [Unreleased]

- Initial release