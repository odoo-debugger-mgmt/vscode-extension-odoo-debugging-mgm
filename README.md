# Odoo DevTools for VS Code

All-in-one VS Code extension for Odoo development: projects, repositories, databases (create/restore/clone/templates), modules, version & branch switching, testing mode, and one-keystroke server/shell launch under the debugger.

A **Get Started with Odoo DevTools** walkthrough is available from VS Code's Welcome page after installing.

## Requirements

- VS Code 1.101 or later.
- `git`, and a clone of the Odoo repository (Set Up offers to clone one). Enterprise and design-themes clones are optional.
- The **Python Debugger** extension (`ms-python.debugpy`): the generated launch configurations use its `debugpy` type.
- A Python interpreter the branch supports, or [uv](https://docs.astral.sh/uv/) so provisioning can install one. Without uv, provisioning falls back to the standard library `venv` and `pip`. You do not build virtualenvs yourself: each version gets its own.
- PostgreSQL running locally, with its client tools in `PATH` (`psql`, `createdb`, `dropdb`).
- `unzip` / `gunzip` for restoring `.zip` / `.sql.gz` dumps.

## Quick Start

**First run: `Odoo DevTools: Set Up`.** It asks for two things — the Odoo git repository to cut per-version worktrees from, and where to build environments (`~/odoo-dev` by default) — and it finds them for you where it can, so it is usually one confirmation. Both are stored at user level, so every workspace you open afterwards is already set up; a workspace that needs a different fork can override them. If you have no Odoo checkout yet, setup offers to clone one and records where it put it.

The source repository is never run directly: every version gets its own worktree cut from it, so that checkout stays yours to switch branches freely.

1. Open a folder in VS Code.
   The extension stores its data in `.vscode/odoo-debugger-data.json`, so projects/versions/databases are **workspace-specific** — unless you [share them between workspaces](#sharing-data-between-workspaces). What you have *selected* — the project, each project's database, the active version and testing mode — is remembered per window, not in that file.

2. Run **`Odoo DevTools: Set Up`** — once per machine, not per workspace.
   It looks for Odoo checkouts you already have and shows what it found for confirmation, so this is usually one click. If there is nothing to find it offers to clone the repositories (community/enterprise/design-themes, any branch, optionally a **shallow copy**) and records where it put them.

3. Where do the paths come from? **Provisioning sets them.** Creating a version builds its own worktree and virtualenv, so `odooPath`, `enterprisePath`, `designThemesPath` and `pythonPath` are filled in for you and tracked as extension-managed. You do not set them by hand — they stay editable in the Versions tree for the unusual case, but editing one points the version away from the environment that was built for it.

   The debugger name and both ports are filled in from the version's branch, so parallel versions do not collide. Click one in the Versions view to set it yourself.

   What is still worth configuring under `odooDebugger.defaultVersion.*` are the runtime knobs applied to new versions:

   ```jsonc
   {
     "odooDebugger.defaultVersion.customAddonsPath": "/home/you/custom-addons",
     "odooDebugger.defaultVersion.dumpsFolder": "/home/you/dumps",
     "odooDebugger.defaultVersion.extraParams": "",
     "odooDebugger.defaultVersion.limitTimeReal": 0
   }
   ```

   Absolute paths are recommended.

   If you used an earlier release, run **`Odoo DevTools: Check Version Environments`**: it reports versions still pointing at hand-configured paths and offers to rebuild them under the environments folder.

4. In the **Versions** view: create a version — pick the branch, confirm the name, and the extension provisions its worktree, interpreter and virtualenv with live progress. Activate it when it is built. (*Profile only* registers the version without building anything.)

5. In the **Projects** view: create a project. The wizard covers repositories and the first database.

6. In the **Modules** view: mark modules for **Install** or **Upgrade**.

7. Launch: `Odoo DevTools: Start Server` (`Ctrl+Alt+O S`) or `Start Shell` from the Projects view / Command Palette.

## Core Concepts

- **Project**: a grouping of repositories + databases (+ tickets and a testing configuration).
- **Version**: a built environment for one Odoo branch: its own worktree of the Odoo source, virtualenv and runtime settings. Its debugger name and ports are filled in from the branch, and you can change them. One version is *active* at a time, but several can run at once.
- **Database**: a PostgreSQL DB that carries its full environment — a linked version and per-repo branch assignments. Selecting a database aligns your workspace to it.
- **Upgrade**: a pair of databases on two versions, run side by side. See [Upgrade mode](#upgrade-mode).

## Database-Driven Switching

Selecting a database aligns the active version, the core repo branches (odoo/enterprise/design-themes) and the project repo branches to what that database expects, controlled by `odooDebugger.databaseSwitchBehavior`:

- `auto` (default): align silently
- `ask`: one notification with **Switch** / **Keep Current**
- `never`: selection only, no switching

The status bar shows the active project, database and version — click any of them to switch.

## Views

Activity Bar (**Odoo DevTools**): Projects, Repos, Databases, Modules, Testing, Upgrade, Versions.
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

- Create databases four ways: **Fresh**, **From Dump** (folder with `dump.sql`, `.zip`, `.sql`, `.sql.gz` — streamed straight into psql), **From Template** (a copy of a template database, attachments included), or **Connect to Existing** (picked from your live PostgreSQL instance).
- Restored dumps are neutralized for development: crons and outgoing mail disabled, passwords reset (`admin`/`admin`), fresh database UUID, extended expiration, mailcatcher entry.
- The Odoo version is **auto-detected** from the database contents and linked to the matching version profile.
- Context actions: **rename display name**, copy name, clone, restore, **open in browser**, **open psql shell**, change linked version, configure per-repo branches, delete. Renaming only changes the label — the PostgreSQL database keeps its name.
- **Templates** (`Manage Database Templates`): register or create template databases and clone from them in seconds; import/export template lists as JSON. A template remembers the data dir it was created in.
- **Checkpoints** keep a database's state to come back to. Right-click a database → **Create Checkpoint**, or use its bookmark icon. The checkpoint is a full PostgreSQL copy, taken in seconds, with its attachments linked rather than copied. It is listed under the database with its age and size. Right-click it → **Restore Checkpoint** puts the database back exactly as it was, attachments included; the checkpoint is kept, so you can restore it again. Restore refuses while an interrupted earlier restore left `<db>__replaced` behind, and names it. **Checkpoint Current State, then Restore** keeps what you had too. A server running the database in this window is stopped after asking and restarted afterwards. Checkpoints refuse connections, so they cannot change, and Odoo's database list does not show them. Deleting a database asks whether to delete its checkpoints too; it stops a server running it in this window after asking, without restarting it, and removes its filestore folder.
- **Clone** and **Templates** copy the filestore as well, so a copy's attachments and stored assets work. They first ask to stop a server running the source, or to end other connections to it. A filestore folder found under a new copy's name, with no database behind it, is moved aside as `<name>.orphan-<id>` rather than deleted.
- **Creating a database asks which branch each project repo should use** — before anything is created or restored, so cancelling costs nothing. *Use current branches* is one of the answers; it is no longer an assumption. Cloning a database inherits its source's mapping.
- **Running databases are marked** in the list: `running :8017` for a server this extension started, on whichever port it runs, `running (external)` for one started from a terminal or another window. Each version also remembers the database it last launched, so switching versions restores the right `-d`.
- **Run several databases at once.** Right-click a database → **Run Alongside** (or **Run Alongside Without Debugging**) starts its server next to whatever already runs, with that database's own version and branches, on the first free port from 8100. It does not touch launch.json: F5 still runs each version's selected database. A database that already runs in this window is not started again; you are told where it runs. Starting a version's F5 entry on a database that runs alongside — from the command, F5 or the Run and Debug dropdown — stops the alongside run first. With `--workers` in the extra params, an alongside run also gets its own realtime port. **Stop This Database's Server** on a database's row stops that database's server. A database whose repository is a single checkout on another branch is not started — switching the branch would break the servers already running — and you are offered one copy per branch for that repository instead. Selecting another database never switches a branch under a server running alongside from that checkout: the checkout stays where it is, you are told so, and offered one copy per branch.
- **Reconcile Databases** finds stored references whose PostgreSQL database no longer exists and removes them in one pass. It also lists checkpoint records whose database is gone, and checkpoint databases whose source is gone.

### Modules

- Modules discovered from the project's repos; click to cycle install → upgrade → unmanaged. State reads by icon shape (down-arrow = install, up-arrow = upgrade, filled circle = installed, outline = not installed), so it stays legible even when a row is highlighted.
- **Multi-select** (Ctrl/Shift-click) to set install/upgrade/clear on several modules at once.
- **Configure Modules** (`Ctrl+Alt+O M`): a quick pick over all modules — Enter cycles install → upgrade → unmanaged, and per-item buttons set a state directly; stays open for several changes.
- Right-click a module to **Reveal in Explorer** (VS Code file tree) or **Reveal in OS**.
- Expand a module to see its manifest dependencies, and each dependency to see its own, as deep as you go (project module, core, or not found).
- Bulk actions: install all, update all, update installed, clear; browse the modules actually installed in the database.
- **Create Module** scaffolds a new module via `odoo-bin scaffold` into a chosen repo.
- `ps*-internal` directories appear as collapsible groups with an include/exclude toggle for the addons path.

### Testing

- Toggle testing mode (module selections are stashed and restored when you leave it).
- Configure test targets (tags, modules, classes, methods — click to cycle include/exclude/disabled), a test file, `--stop-after-init` and a log level.
- The view shows the exact test flags added to the launch configuration.

### Versions

- **Setup offers to build several versions at once.** The list comes from your repositories' branches and the source repository's branches, not a fixed table. The first is built while you wait; the rest queue up and build one at a time, surviving a window reload — the rows read `building…` and `queued` while they wait.
- **Upgrades** have their own view; see [Upgrade mode](#upgrade-mode).
- **Create a version and its environment in one step.** Pick a branch, confirm the name, and the extension provisions a git **worktree** for that branch, picks a Python interpreter the branch actually supports, builds a **virtualenv** and installs `requirements.txt` — with live progress and cancellation. Choose *Profile only* to create the version without building anything.
- Because each version owns its worktree, **several versions can be checked out at once** — useful for comparing a database before and after an upgrade — and activating a version no longer checks anything out, so it can't fail on a dirty working tree.
- Your configured `odooPath` is used **only as a source** to cut worktrees from; a version never runs out of it, even when it happens to be on the matching branch. That directory stays yours to switch freely. Each worktree gets its own `odt/<branch>` branch tracking `origin/<branch>`, so `git pull` works inside it.
- The required Python version is read from the branch itself (`setup.py`'s `python_requires` or `odoo/release.py`'s `MIN_PY_VERSION`, plus the distributions named in `requirements.txt`'s header), so 17.0 gets 3.10 and 19.0 gets 3.12 without any hand-maintained table. An interpreter already installed via pyenv or your system is reused when it fits; otherwise [uv](https://docs.astral.sh/uv/) installs the right one.
- After provisioning, a **dependency check** reports what's missing (`wkhtmltopdf`, PostgreSQL client tools, `rtlcss`, and the build headers `lxml`/`psycopg2`/`ldap` need) with a copy-paste install command for your platform. Nothing is installed for you and nothing runs `sudo`.
- Each version's **debugger name, HTTP port and shell port are filled in from its branch** — `odoo:17.0` on ports 8017/5017, `odoo:18.0` on 8018/5018 — and marked *automatic* in the tree. That is what lets two versions run at the same time, which is the point when you are comparing a database before and after an upgrade. `odooDebugger.debuggerNamePrefix` changes the `odoo` part; the ports follow the series and step upward if another version, or any other process, has already claimed one.
- **Set them yourself** by clicking the row: the value is then marked *set by you* and kept when the branch changes. Several versions may share one: a shared port means only one of them runs at a time, and a shared debugger name means they share one launch entry, which always runs the active version — so F5 runs whatever version and database are selected. You are warned when you pick a value another version uses. **Make Automatic Again**, on the row's right-click menu, hands it back to the branch.
- **Check Version Environments** (Versions view title bar) reports any version whose directories are missing, unprovisioned or sitting outside the current environments folder, and re-provisions the ones that need it. Versions built before provisioning — including any still running out of the source repository, which is unsafe rather than untidy — are offered a migration once on activation, and the offer remembers *Later*.
- Each version row shows whether it is provisioned. Deleting a version offers to remove the folders the extension created — and never the ones you made yourself.
- Clone, delete, activate; edit any setting inline from the tree.
- Reset settings to the configured defaults, or save a version's settings as the new defaults.

### Upgrade mode

An upgrade is two servers, on two databases, on two versions, running at the
same time. It is a mode with its own **Upgrade** view, toggled from that view or
with `Ctrl+Alt+O Shift+U` — the same shape as testing mode.

**Setting it up** asks for the two databases: the one you are upgrading from and
the one you are upgrading to (or *Create a new database*, which asks the target
series and creates an empty one). Everything else is deduced where it can be:
each side's Odoo series from the database itself, each side's version by
matching that series, and each repository's branch from its branch list. Only
what cannot be deduced is asked. A review screen lets you change any branch, and
one confirmation names what will be created on disk.

Applying the plan:

- gives each repository in the upgrade [one copy per branch](#one-copy-per-branch), so both sides run their own code — unless each version already has its own checkout of it (a folder or workspace per version, see [Repository layouts](#repository-layouts)): then no copies are made, and each side's checkout is switched to its branch;
- records each database's branch mapping and remembers which database each version launches against;
- queues any version that does not exist yet for provisioning;
- stages the source database's installed modules onto the target as `install` (not `-u all`). Modules with no counterpart in the target version are left out and named in the view.

**While the mode is on:**

- The Upgrade view shows both sides — version, database, port and each repository's branch — and **Start Both Servers** starts each side on its own database and port.
- **Across two workspaces**, each window runs its own side — the version it is bound to, else its active one. **Start This Side** starts only that side, so each window debugs the code it holds, and on a shared store **Open the Other Side** opens the workspace running the other version.
- **Install N modules from …** is a toggle: off gives the target database back its own modules, on restores the staged set as you left it.
- Selecting either database of the pair chooses whose modules the Modules view edits, without realigning the workspace. Databases outside the pair cannot be selected.
- Project Repos shows both copies of each repository, marked *upgrading from* / *upgrading to*.
- Actions that would break the pair are refused with an **Exit Upgrade Mode** offer: testing mode, changing either database's version or branches, renaming, restoring or deleting a paired database, changing or deleting a paired version, activating a version outside the pair, and changing a paired repository's branch mode. Open in Browser, psql, Clone and Copy Database Name stay available.

**Turning it off keeps the upgrade.** Only the target's modules go back to its
own; the pair, the branches, the copies and the versions stay, so turning it on
again resumes without a question. Anything removed while it was off is rebuilt
on the way back in. **Change the Upgrade** (pencil in the view title) reopens
setup with the current databases preselected.

### Comparing two databases

Every database can have a **comparison partner**: another database of the project, or one of its own checkpoints. The first compare asks for it and remembers it; **Set Comparison Partner…** and **Clear Comparison Partner** on a database's right-click menu change it, and the database's tooltip names it. In Upgrade mode the partner is always the other side of the upgrade, so it is set for you.

- **Compare with Partner** (the View Doctor) opens the same view in both databases in the diff editor: the partner on the left — the upgrade's original, or the checkpoint — and your database on the right, where saving fixes it. A checkpoint's side is a read-only snapshot of the stored arch.
- **Render** shows the view in both databases side by side when the partner is a database. With no partner, it shows the database alone, and asks only when there are databases to pick; the answer is remembered. With a checkpoint as partner it shows the database alone, with a notice. A side with no server offers **Run Both** (**Run Alongside** when the partner has no matching view), which runs alongside the databases shown that are not running yet; the tab then waits for them on the ports they were started on. **Reload** also follows a database whose server has moved to another port.
- **"Other inactive views" leaves out the views the partner has off too** when the partner is a copy of the database: a checkpoint, a clone made from it, or the upgrade's original. **Show/Hide Views Also Off in the Partner** toggles it. Clones made from now on are known as copies; older clones are not.
- **Run Partner Alongside** runs the partner next to your database. A checkpoint cannot be run: restore it, or clone it.

### Disabled views (View Doctor)

The **Views** view lists the views the selected database has turned off — while an upgrade is set up, the upgraded database. What the upgrade disabled comes first, then every other inactive view.

Click a view to open its arch as an XML file. Saving writes it to the database through an Odoo shell that runs the database's own version (started on first use, stopped after ten idle minutes). A view that was off is turned on when Odoo can build it; otherwise the arch is still saved and Odoo's reason shows as an error in the editor. Right-click a view to turn it on or off, copy its external id, or open its parent.

**Compare with Partner** (on a view's row) opens the same view of the database's comparison partner next to it in the diff editor; the partner opens read-only, so fix the right side and save. See [Comparing two databases](#comparing-two-databases). The view is found by external id, then id, then name; when none is certain, you pick it.

**Check XPaths** tells you whether a fix really works. Odoo turns a view on even when one of its locators matches nothing — it drops that patch and logs a line — so "the view is on" does not mean the patch applies. The check resolves every locator of the arch you have open (`<xpath expr>` and direct ones like `<field name="x" position="after">`) against the parent as Odoo builds it, without the view itself, and with the parent turned on if it is off: a locator that matches nothing or several nodes is a warning on its line, an invalid one an error, and a long one that works (Studio's `/form/sheet/...` paths) gets a faint hint. The light bulb swaps in a shorter locator that finds the same node. It runs after every save of an inheriting view (`odooDebugger.views.checkXpathsOnSave` turns that off), and on demand from a view's row or its editor's title. Other views inheriting the same parent are kept in, so a locator that only a later sibling breaks or fixes can be misjudged.

**Find View** (the search icon on the Views title) opens any view of the database by id or external id, or lists a model's views. **Views Inheriting This** lists every view below one, and **Open Root View** opens the top of its chain. In these lists, base views come first and each inheriting view sits under its parent; views that are off are marked. An arch editor's title has the row's actions too, so a view found this way can be compared, rendered and checked.

**Other inactive views** leaves out the views that are off in the partner too, when the partner is a copy of the database (compared by id), so what the upgrade broke stands out. The group says how many it hides; the eye icon on the Views title shows them again. See [Comparing two databases](#comparing-two-databases).

**Render** opens the view in Odoo, inside a VS Code tab, logged in as the database's first administrator. The admin session is created in the Odoo data folder of your user; a server started with another `--data-dir`, as another user or in a container cannot see it and shows its login page. When the partner is a database (always, in Upgrade mode), both databases show side by side, on the newest record they both have (see [Comparing two databases](#comparing-two-databases)); step to older records, or a new one, from the toolbar. Saving an arch reloads that side. The tab talks to Odoo through a local proxy that only that tab can use. A side whose server is not running offers to start it. Render leaves one action, named "[View Doctor] <model> #<id>", in each database it renders, the partner included. A report's template renders as the report itself, as HTML, on the newest record both databases have (for invoices, the newest that is not a plain journal entry); **PDF** fetches the PDF from that side's server into a private temporary folder and opens it in your system's viewer (local windows only, and the server needs wkhtmltopdf). Other QWeb templates are not rendered; open them from Odoo. The **Debug** box turns Odoo's debug mode on or off in both frames, and is remembered per workspace.

**Create Upgrade Script** (on the Views title) turns your fixes into an `upgrade-util` script, so the next upgrade of the original database does them for you. It covers every view the upgrade disabled that is on again, and every view you saved or turned on from VS Code (listed under **Edited here**). **Add to Upgrade Script** (right-click an active view) adds just that view. Choose one of the project's modules and a version folder — prefilled with the module's version one patch up, series first (`18.0.1.0.1`) — or an untitled editor. The script is written to `migrations/<version>/end-update_views.py`; when that file is already there, the new views are added to it, and a file you changed by hand is never overwritten (a numbered file is written next to it instead). Odoo runs the folder only once the module's version reaches it, so the extension offers to set the version in `__manifest__.py`. Once the version is set, every `-u` of that module runs the script, so upgrade-util must be on `--upgrade-path` for it too (otherwise `from odoo.upgrade import util` fails). Nothing is committed for you.

Each view is put back by external id, or by database id when it has none (the script says so: that id only holds in that database). A view whose arch was never edited is only turned back on; the others get their whole arch back, through `util.edit_view`. Views still off, deleted, or fixed before the extension first saw them off are left out, and the message says how many. The script needs [upgrade-util](https://github.com/odoo/upgrade-util) on the upgrade path (`--upgrade-path=<upgrade-util>/src`).

What the upgrade disabled is noted the first time the Views tree lists it, per database, on this machine only.

### One copy per branch

During an upgrade you need two versions running against **their own** custom
code. Upgrade mode sets this up for the repositories it involves; to do it by
hand, right-click a repository in Repos or Project Repos and choose **Use One Copy Per
Branch**: each branch that repository is mapped to gets its own working
directory under your environments folder, so 17.0 and 19.0 stop competing for
one checkout.

This is opt-in per repository, and off by default — ordinary development, where
a feature branch simply follows staging and prod, does not need it.

The confirmation names the exact directories that will be created, because that
is where you will edit that branch's code from then on. Your original checkout
becomes a **source**: never in the addons path, never run, and yours to switch
freely without changing what any version runs. Commits and pushes from a
worktree go to the real branch — it is the same repository, one object store,
so nothing needs syncing back.

Because git can only check a branch out in one place, the source checkout has
to let go of a branch a worktree needs. You are asked, never surprised: moving
it to another branch is offered first (it keeps working normally), detaching is
the alternative, and a checkout with uncommitted changes is refused with its
changed files named.

Two safeguards keep you out of the wrong copy: the repo views, Modules view and
generated workspace show only the active version's copies, and opening a file
belonging to another version offers to reopen the same file in the active one.

Turning the mode back off (**Use a Single Checkout**, from the Command Palette)
removes the copies the extension created, keeping any with uncommitted changes
and telling you which.

### Repository layouts

Developers keep custom code in different ways, and each version finds its own
copy of a project repository whichever way you use:

- **One clone for every version** — one custom addons folder, one checkout
  that switches branch. Every version finds the same clone, exactly as before.
- **A folder per version** — `~/v17/acme` and `~/v19/acme`, two clones of one
  repository, each version's **Custom Addons** setting pointing at its own
  folder. Each version finds its clone (by its `origin` remote, so the folder
  may be named differently, or else by name). Switching to a 19.0 database
  checks out in the 19.0 clone and never touches the 17.0 one; the addons
  path, Modules and Project Repos follow.
- **One copy per branch** — the extension's own copies, above. Unchanged.
- **A different home the folder cannot find** — **Set Repository Location for
  a Version…** (Command Palette, or a version's context menu) sets it by hand.
  The version's tooltip lists what is set that way.

### Project Repos (Explorer)

- Browse only the active project's repositories, with the current branch shown per repo.
- Right-click actions: reveal in Explorer/OS, copy path, open in terminal, new file/folder, rename. Destructive operations (delete, cut/paste) are intentionally left to the built-in Explorer.
- Repos whose folder was moved or deleted are flagged with a **Relocate Repository** action.
- Honors your `files.exclude` settings.

## Sharing data between workspaces

Odoo is version-based, and it is common to keep one workspace per version.
By default each workspace keeps its own data in `.vscode/odoo-debugger-data.json`.
To let several workspaces work from the same projects, versions and databases,
run **Odoo DevTools: Choose Data Store…** and pick the **shared store**
(`~/odoo-dev/odoo-devtools.db` by default), open an existing `.db` another
workspace uses, or create a new one — for every workspace or for this one only.
It offers to bring the current workspace's data along: a merge that fills gaps
and never overwrites what the store already holds. The workspace's own file is
left as it is. The Projects view shows which shared store it is reading.

- **Shared:** projects, repositories, databases and their module marks,
  versions (and their ports, which stay unique across windows), upgrades and
  database templates.
- **Per window:** the selected project, each project's selected database, the
  database each version last launched against, the active version, and testing
  mode. Selecting a database in one window never changes what another window
  launches. An active upgrade is the exception, on purpose: its two databases
  are the same in every window, so either window can start both sides.
- Without a shared store, the workspace's own file also keeps a copy of the
  last selection, so another profile, another editor or an older build opens
  the workspace where you left it.
- Windows sharing a store see each other's changes within a couple of seconds.
  When two windows change the same project at once, both changes are kept; only
  a value both changed differently goes to whichever saved last.
- **Export Data…** writes a portable JSON copy, and **Import Data…** merges one
  (or a plain `odoo-debugger-data.json`) into the current store, or replaces it.
  The preview says exactly what a merge adds, or that it adds nothing. Versions
  are matched by branch, so importing from another machine does not duplicate
  them.
- **Each workspace runs its own version.** The first time a workspace opens a
  shared store with several versions, it is asked once which version it runs,
  with a proposal from what it holds — "Use Odoo 19.0 in this workspace?
  (acme here is on main, which acme-db19 runs.)" — found through the
  databases' branch mappings, so `main`/`staging`/`dev` branches work, or else
  a branch named after a series. Choosing activates that version, and the
  workspace's own folders become its code: a clone the workspace opens is what
  that version runs, with nothing to configure. **Bind This Workspace to a
  Version…** changes it later; switching the active version works as always.
- **Workspaces find each other.** Each workspace on a shared store is recorded
  in it, with the version it runs. A version's tooltip in the Versions view
  names the other workspaces that run it, and **Open the Workspace for a
  Version…** (Command Palette, or a version's context menu) opens one. Entries
  unseen for 90 days, or whose folder is gone, are dropped.
- **Windows look out for each other.** Only one window builds queued versions
  at a time (a lease in the environments folder); starting a version whose
  port is already taken says it is probably running in another window;
  a project, database or version deleted in another window is named once
  rather than silently vanishing; and **Set as Default** on a shared store
  saves to your user settings, so it applies in every workspace.
- A workspace bound to one version asks before selecting another version's
  database switches it, and a workspace opened on a clone keeps the
  extension's `launch.json` out of that repository's git status (through the
  clone's own `info/exclude`).
- A store written by a newer Odoo DevTools opens read-only, and says so.
- Keep the store on a local disk: SQLite's locking is unreliable over network
  shares.
- The shared store needs VS Code 1.101 or later. An editor on an older runtime
  says so and keeps using the workspace's own file.

## Debugging & launch.json

The extension maintains **one launch configuration per provisioned version** in `.vscode/launch.json` — or, in a saved multi-root workspace (a `.code-workspace` file, such as the one Open Project Workspace generates), in that file's `launch` section, so nothing is written into your repositories — each named after that version's `debuggerName` and carrying its own port and database. Versions sharing a debugger name share one entry, written for the active one. Only those entries are rewritten — your own configurations and comments are preserved. It assembles `--addons-path`, `-d`, `-i`/`-u` from your module selections, ports, time limits, dev mode and testing flags automatically.

A version's entry only ever uses a database of that version: with none chosen, it is left out of the file until you pick one, and Start Server asks for one.

Because the entries are stable and unique, the Run and Debug dropdown works as a version switcher. **F5 follows whatever the dropdown has selected, while `Ctrl+Alt+O S` always follows the *active* version.** That divergence is deliberate: it is what lets you debug one version from the dropdown while launching another from the chord. **Stop Server** targets the active version's session, and asks only when several versions are running and none of them is the active one.

Generated project workspaces also include the active version's own `odoo`, `enterprise` and `design-themes` checkouts, so files you open belong to the version you are running and breakpoints bind to the right worktree.

Server commands: **Start Server**, **Run Server Without Debugging**, **Restart Server**, **Stop Server**, **Open Odoo in Browser** (uses the active version's port and the selected database), and **Copy Odoo Command** — copies the exact `python odoo-bin …` command line the debugger runs (assembled from the selected project, active version and database) to the clipboard, ready to paste into a terminal. With `odooDebugger.server.openBrowserOnStart` enabled, the browser opens automatically once the server port accepts connections.

## Editor Actions

Right-click inside a file that belongs to an Odoo module (toggle with `odooDebugger.editorActions.enabled`):

- **Run Odoo Tests for Current File** (on `test_*.py`) — enables testing mode, targets the file and its module, and starts the server.
- **Upgrade Current Module** — marks the module for `-u` and offers a server restart.
- **Reveal Module in Modules View** — highlights the module in the tree, including inside `ps*-internal` groups.

## Post-Switch Hooks

`postSwitchCommands` run **once per core repo** after a version's environment is aligned — whether or not a branch checkout was needed — with the repo folder as the working directory, logged in the `Odoo Debugger: Branch Hooks` output channel.

A version's own `postSwitchCommands` win; `odooDebugger.defaultVersion.postSwitchCommands` is the fallback for versions that define none.

```jsonc
{
  "odooDebugger.defaultVersion.postSwitchCommands": [
    "npm install"
  ]
}
```

Installing Python requirements no longer belongs here — provisioning owns that.

> Upgrading from 1.2: `postCheckoutCommands` is renamed automatically, in both your settings and your stored versions. **`preCheckoutCommands` is removed** — it guarded a checkout that was about to happen, and there is no longer one to guard; running it after the switch would discard uncommitted work rather than clear the way. A one-time notice names what was dropped so you can re-add anything that still makes sense as a post-switch command.

## Commands & Keybindings

| Keybinding | Command |
| --- | --- |
| **Server** | |
| `Ctrl+Alt+O S` | Start Server |
| `Ctrl+Alt+O X` | Stop Server |
| `Ctrl+Alt+O N` | Run Server Without Debugging |
| `Ctrl+Alt+O R` | Restart Server |
| `Ctrl+Alt+O H` | Start Odoo Shell |
| `Ctrl+Alt+O B` | Open Odoo in Browser |
| **Switch** | |
| `Ctrl+Alt+P` | Search Projects (quick switch) |
| `Ctrl+Alt+O D` | Search Databases (quick switch) |
| `Ctrl+Alt+O V` | Switch Active Version |
| `Ctrl+Alt+O W` | Open Project Workspace |
| **Create** | |
| `Ctrl+Alt+O C` | Create Project |
| `Ctrl+Alt+O Shift+D` | Create Database |
| `Ctrl+Alt+O Shift+M` | Create Module (scaffold) |
| `Ctrl+Alt+O Shift+V` | Create Version |
| **Work** | |
| `Ctrl+Alt+O M` | Configure Modules (quick pick) |
| `Ctrl+Alt+O U` | Upgrade Current Module |
| `Ctrl+Alt+O F` | Run Odoo Tests for Current File |
| `Ctrl+Alt+O T` | Toggle Testing Mode |
| `Ctrl+Alt+O Shift+U` | Toggle Upgrade Mode |
| `Ctrl+Alt+O L` | Manage (Link) Project Tickets |
| `Ctrl+Alt+O O` | Open Project Ticket |
| `Ctrl+Alt+O K` | Keyboard Shortcuts cheat sheet |

The scheme: plain letters act, `Shift` variants create the matching thing (`D` switches databases, `Shift+D` creates one). `Shift+U` is the exception: it toggles upgrade mode, next to `U` for upgrading the current module. Forgot a chord? `Ctrl+Alt+O K` (or **Odoo DevTools: Keyboard Shortcuts** in the palette / the Projects view `…` menu) lists every shortcut — picking one runs its command.

Every view also has search (`$(search)`) and sort (`$(sort-precedence)`) actions in its title bar. All palette commands live under the **Odoo DevTools** category.

## Settings Reference

- `odooDebugger.defaultVersion.*` — defaults applied to newly created versions (paths, params, post-switch hooks). Existing versions are edited from the Versions view. Note that `debuggerName`, `portNumber` and `shellPortNumber` are **not** among these: they are filled in from each version's branch, and edited per version.
- `odooDebugger.debuggerNamePrefix` — prefix for generated launch configuration names (`<prefix>:<branch>`, default `odoo`).
- `odooDebugger.sourceRepo.odoo` / `.enterprise` / `.designThemes` — the repositories per-version worktrees are cut from. Set once by **Set Up**, at user level.
- `odooDebugger.provisioning.root` — directory holding per-version worktrees and virtualenvs. Empty means `~/odoo-dev`.
- `odooDebugger.provisioning.uvPath` — path to an existing `uv` binary. Empty means look on `PATH`; when uv is absent, provisioning falls back to the standard library `venv` and `pip`.
- `odooDebugger.dataStore.path` — where the data lives. Empty means `.vscode/odoo-debugger-data.json`. A `.db` file is a shared store, honoured at user or workspace level; a `.json` file is honoured per workspace only. Set it with **Choose Data Store…** so the current data can come along; Open Project Workspace sets it so the workspace it opens keeps the same data.
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
