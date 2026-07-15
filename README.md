# Odoo DevTools for VS Code

All-in-one VS Code extension for Odoo development: projects, repositories, databases (create/restore/clone/templates), modules, version & branch switching, testing mode, and one-keystroke server/shell launch under the debugger.

A **Get Started with Odoo DevTools** walkthrough is available from VS Code's Welcome page after installing.

## Requirements

- Python + an Odoo environment (virtualenv recommended), with `debugpy` available for debugging
- PostgreSQL client tools in `PATH` (`psql`, `createdb`, `dropdb`) for the database features
- Git checkouts of Odoo / your addons (for branch switching)
- `unzip` / `gunzip` for restoring `.zip` / `.sql.gz` dumps

## Quick Start

1. Open a folder in VS Code.
   The extension stores its state in `.vscode/odoo-debugger-data.json`, so projects/versions/databases are **workspace-specific**.

2. **(Optional — skip if Odoo is already set up)** Run `Setup Odoo` from the Projects view title bar.
   Pick **Full setup** (clone + Python venv + requirements) or **Clone repositories only**, choose the destination folder (workspace by default), the repositories (community/enterprise/design-themes), the branch, and whether to make a **shallow copy** (single branch, no history — fast and small) or a full clone. After a clone-only run you can continue the full setup or have a matching **version profile created for you** in one click.

   ![Odoo Setup](resources/assets/odoo-setup.gif)

3. Configure defaults under `odooDebugger.defaultVersion.*` in VS Code settings — most importantly the paths:

   ```jsonc
   {
     "odooDebugger.defaultVersion.odooPath": "./odoo",
     "odooDebugger.defaultVersion.enterprisePath": "./enterprise",
     "odooDebugger.defaultVersion.designThemesPath": "./design-themes",
     "odooDebugger.defaultVersion.customAddonsPath": "./custom-addons",
     "odooDebugger.defaultVersion.pythonPath": "./venv/bin/python",
     "odooDebugger.defaultVersion.dumpsFolder": "./dumps"
   }
   ```

   Absolute paths are recommended.

   ![VS Code Setting](resources/assets/vscode-settings.gif)

4. In the **Versions** view: create a version (branch pick + name — settings come from the defaults) and activate it.

   ![Version Setup](resources/assets/version-setup.gif)

5. In the **Projects** view: create a project. The wizard covers repositories and the first database.

   ![Project Creation](resources/assets/project-creation.gif)

6. In the **Modules** view: mark modules for **Install** or **Upgrade**.

   ![Module Management](resources/assets/module-management.gif)

7. Launch: `Odoo DevTools: Start Server` (`Ctrl+Alt+O S`) or `Start Shell` from the Projects view / Command Palette.

## Core Concepts

- **Project**: a grouping of repositories + databases (+ tickets and a testing configuration).
- **Version**: a named settings profile (paths/ports/params) bound to a target git branch; one version is *active* at a time.
- **Database**: a PostgreSQL DB that carries its full environment — a linked version profile and per-repo branch assignments. Selecting a database aligns your workspace to it.

## Database-Driven Switching

Selecting a database aligns the active version, the core repo branches (odoo/enterprise/design-themes) and the project repo branches to what that database expects, controlled by `odooDebugger.databaseSwitchBehavior`:

- `auto` (default): align silently
- `ask`: one notification with **Switch** / **Keep Current**
- `never`: selection only, no switching

The status bar shows the active project, database and version — click any of them to switch.

## Views

Activity Bar (**Odoo DevTools**): Projects, Repos, Databases, Modules, Testing, Versions.
Explorer sidebar: **Project Repos** (project-scoped file tree).

### Projects

- Create/select/delete/duplicate projects; import/export them as JSON for backup or sharing.
- Project selection drives every other view.
- **Tickets**: attach ticket/task ids to a project and open them with `odooDebugger.ticketBaseUrl`. `Detect Tickets from Branches & Manifests` scans your repo branch names and module manifests for task ids automatically.
- **Workspace**: build/open a multi-root `.code-workspace` from the project's repos (`Open Project Workspace`, `Quick Switch Project Workspace`).

### Repos

- Choose which addons sources (discovered under your custom addons folder) belong to the active project: **git repositories and plain folders containing Odoo modules** — a folder full of modules is picked up even before `git init`.
- Git repos show their current branch; git-less folders are marked *addons folder*. Sort by name, creation date or branch.
- Right-click a repo to reveal it in the Explorer or OS, copy its path, or open it in a terminal.

### Databases

- Create databases four ways: **Fresh**, **From Dump** (folder with `dump.sql`, `.zip`, `.sql`, `.sql.gz` — streamed straight into psql), **From Template** (`createdb -T` clone), or **Connect to Existing** (picked from your live PostgreSQL instance).
- Restored dumps are neutralized for development: crons and outgoing mail disabled, passwords reset (`admin`/`admin`), fresh database UUID, extended expiration, mailcatcher entry.
- The Odoo version is **auto-detected** from the database contents and linked to the matching version profile.
- Context actions: restore, delete, clone, copy name, **open in browser**, **open psql shell**, change linked version, configure per-repo branches.
- **Templates** (`Manage Database Templates`): register or create template databases and clone from them in seconds; import/export template lists as JSON.
- **Reconcile Databases** finds stored references whose PostgreSQL database no longer exists and removes them in one pass.

### Modules

- Modules discovered from the project's repos; click to cycle install → upgrade → unmanaged (green/yellow icons; filled/outline shows installed state).
- **Multi-select** (Ctrl/Shift-click) to set install/upgrade/clear on several modules at once.
- **Configure Modules** (`Ctrl+Alt+O M`): a quick pick over all modules — Enter cycles install → upgrade → unmanaged, and per-item buttons set a state directly; stays open for several changes.
- Right-click a module to **Reveal in Explorer** (VS Code file tree) or **Reveal in OS**.
- Expand a module to see its manifest dependencies (project modules vs core).
- Bulk actions: install all, update all, update installed, clear; browse the modules actually installed in the database.
- **Create Module** scaffolds a new module via `odoo-bin scaffold` into a chosen repo.
- `ps*-internal` directories appear as collapsible groups with an include/exclude toggle for the addons path.

### Testing

- Toggle testing mode (module selections are stashed and restored when you leave it).
- Configure test targets (tags, modules, classes, methods — click to cycle include/exclude/disabled), a test file, `--stop-after-init` and a log level.
- The view shows the exact test flags added to the launch configuration.

### Versions

- Create (branch + name), clone, delete, activate; edit any setting inline from the tree.
- Reset settings to the configured defaults, or save a version's settings as the new defaults.
- Changing a version's branch or activating a version can check out the matching git branches.

### Project Repos (Explorer)

- Browse only the active project's repositories, with the current branch shown per repo.
- Right-click actions: reveal in Explorer/OS, copy path, open in terminal, new file/folder, rename. Destructive operations (delete, cut/paste) are intentionally left to the built-in Explorer.
- Repos whose folder was moved or deleted are flagged with a **Relocate Repository** action.
- Honors your `files.exclude` settings.

## Debugging & launch.json

The extension maintains a single launch configuration (named after the version's `debuggerName`) in `.vscode/launch.json`, and rewrites **only that entry** — your own configurations and comments are preserved. It assembles `--addons-path`, `-d`, `-i`/`-u` from your module selections, ports, time limits, dev mode and testing flags automatically.

Server commands: **Start Server**, **Run Server Without Debugging**, **Restart Server**, **Stop Server**, **Open Odoo in Browser** (uses the active version's port and the selected database). With `odooDebugger.server.openBrowserOnStart` enabled, the browser opens automatically once the server port accepts connections.

## Editor Actions

Right-click inside a file that belongs to an Odoo module (toggle with `odooDebugger.editorActions.enabled`):

- **Run Odoo Tests for Current File** (on `test_*.py`) — enables testing mode, targets the file and its module, and starts the server.
- **Upgrade Current Module** — marks the module for `-u` and offers a server restart.
- **Reveal Module in Modules View** — highlights the module in the tree, including inside `ps*-internal` groups.

## Branch Checkout Hooks

- `odooDebugger.defaultVersion.preCheckoutCommands` / `postCheckoutCommands` run **once per repo being switched**, with the repo folder as the working directory, and are logged in the `Odoo Debugger: Branch Hooks` output channel.

```jsonc
{
  "odooDebugger.defaultVersion.preCheckoutCommands": [
    "git status --porcelain"
  ],
  "odooDebugger.defaultVersion.postCheckoutCommands": [
    "pip install -r requirements.txt"
  ]
}
```

## Commands & Keybindings

| Keybinding | Command |
| --- | --- |
| `Ctrl+Alt+P` | Search Projects (quick switch) |
| `Ctrl+Alt+O S` | Start Server |
| `Ctrl+Alt+O X` | Stop Server |
| `Ctrl+Alt+O N` | Run Server Without Debugging |
| `Ctrl+Alt+O R` | Restart Server |
| `Ctrl+Alt+O B` | Open Odoo in Browser |
| `Ctrl+Alt+O M` | Configure Modules (quick pick) |
| `Ctrl+Alt+O T` | Toggle Testing Mode |
| `Ctrl+Alt+O D` | Search Databases (quick switch) |
| `Ctrl+Alt+O V` | Switch Active Version |

Every view also has search (`$(search)`) and sort (`$(sort-precedence)`) actions in its title bar. All palette commands live under the **Odoo DevTools** category.

## Settings Reference

- `odooDebugger.defaultVersion.*` — defaults applied to newly created versions (paths, ports, params, checkout hooks). Existing versions are edited from the Versions view.
- `odooDebugger.databaseSwitchBehavior` — `auto` / `ask` / `never` (see above).
- `odooDebugger.statusBar.enabled` — show the project/database/version status bar items.
- `odooDebugger.server.openBrowserOnStart` — open the web client automatically after the server starts (default off).
- `odooDebugger.editorActions.enabled` — show the Odoo actions in the editor right-click menu (default on).
- `odooDebugger.ticketBaseUrl` — base URL used by Open Project Ticket.
- `odooDebugger.search.*` — module/repository discovery tuning (max depth, max entries, exclude patterns) for large workspaces.

Diagnostics are written to the **Odoo DevTools** output channel (View → Output).

## Tips & Troubleshooting

- If branch switching does nothing, confirm the version's `odooPath`/`enterprisePath`/`designThemesPath` point to valid git repos.
- If database operations fail, ensure the PostgreSQL client tools are installed and in `PATH` (`psql`, `createdb`, `dropdb`).
- If module discovery is slow in large workspaces, tune the `odooDebugger.search.*` exclude patterns and max depth.
- If a repo shows **path missing** in Project Repos, use *Relocate Repository* to point it at the moved folder.
- Check the **Odoo DevTools** output channel for logged errors before filing an issue.

## Support

For bug reports or feature requests, join the Discord channel: https://discord.gg/5DMzx3nr9z

## License and Ethical Use Disclaimer

This project is provided under the AGPL-3.0 license. The license terms apply as written in `LICENSE`.

Separately, the maintainers request that you do not use this software for any unethical purposes, including any purpose that is haram (forbidden) under Islamic law, including but not limited to:

- Promoting, enabling, or facilitating riba (usury or interest-based transactions).
- Producing, distributing, or marketing alcoholic beverages, pork products, or gambling.
- Producing, distributing, or facilitating pornographic or sexually explicit material.
- Participating in or aiding fraud, deception, oppression, or harm to innocents.
- Engaging in activities involving spying, invasion of privacy, or breach of trust.
- Using the Software to support systems contrary to the moral or legal rulings of the four Sunni schools.

This section is a moral/ethical statement from the maintainers and is not intended to replace or modify the terms of the AGPL-3.0 license.
