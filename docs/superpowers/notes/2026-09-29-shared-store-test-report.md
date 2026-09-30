# Test report: shared data store (steps 1 and 2)

**For:** the agent that built the shared data store and wrote
[`shared-store-test-brief.md`](../../shared-store-test-brief.md).
**Run:** 2026-09-29, on `v-1.3` at `d6e4207`, in real VS Code windows.
**Nothing was fixed.** Every problem below is reported, not patched.

This file holds nine runs, newest first. The earlier runs are kept unchanged.

# Ninth run: finding 14 replayed (`ec04b14`)

**Scope:** as asked:
- the test suite;
- finding 14 replayed on the seed.

**Setup:**
- **Profile:** a new throwaway profile (`HOME=/tmp/claude/bo`), running as an
  Extension Development Host; nothing here involves Recent.
- **Data:** A's data file reset to the seed: acme-db1 selected (`isSelected`),
  `selectedDbByVersion` absent, 17.0 active. A had no `launch.json`.

## Verdict (ninth run)

**Finding 14 is fixed.**

## Test suite: matched

- VS Code 1.139.1: **459 passing, 0 failing, 0 pending**.

## Finding 14 replayed: matched

1. **Start:** A opened on "acme · acme-db1 · 17.0 :8069". acme-db1 had never
   been picked in this window.
2. **Switch Active Version → Odoo 19.0:**
   - the status bar read "no 19.0 database";
   - `launch.json` held only `odoo-debugger`, `-d acme-db1`.
3. **The status bar item** listed only acme-db19, under "Database for Odoo
   19.0". I picked it. `launch.json` then held **both**:
   - `odoo-debugger-19`, `-p 8079 -d acme-db19`;
   - `odoo-debugger`, `-p 8069 -d acme-db1`.

   The status bar read "acme-db19 · 19.0 :8079".
4. **Switch Active Version → Odoo 17.0:**
   - the status bar read **"acme · acme-db1 · 17.0 :8069"**;
   - `launch.json` is unchanged, with both entries.
   - The data now remembers
     `{"ver-19-0002": "acme-db19", "ver-17-0001": "acme-db1"}`. The selection
     flag stays on acme-db19, and 17.0 resolves acme-db1 through the memory.

# Eighth run: the status bar per version, and Recent once (`5269f35`)

**Scope:** as asked:
- the test suite;
- with 19.0 active and no 19.0 database chosen:
  - the status bar says so;
  - clicking it lists only 19.0 databases;
  - picking one updates the status bar and `launch.json`;
- Start Server on 19.0, then Select Database, lists only 19.0 databases;
- reopening an old-style workspace from Recent, then clicking the status bar
  item: Recent lists the workspace once afterwards.

**Setup:**
- **Profile:** a new throwaway profile (`HOME=/tmp/claude/bn`), with the
  Python extensions and the stub `odoo-bin`.
- **Builds:** `a106206` and `5269f35`, packaged and installed as in the sixth
  run.
- **Data:** A's data file reset to the seed: acme-db1 and acme-db2 on 17.0,
  acme-db19 on 19.0, acme-db1 selected, 17.0 active, no `selectedDbByVersion`,
  no upgrade.

## Verdict (eighth run)

- **Everything asked for matched.**
- **A new finding, 14 (moderate):** picking a 19.0 database in a window whose
  17.0 database was never picked in this build drops 17.0's database. Its
  launch entry is removed, and switching back to 17.0 shows "no 17.0
  database".

## Test suite: matched

- VS Code 1.139.1: **454 passing, 0 failing, 0 pending**.

## 19.0 active, no 19.0 database chosen: matched

1. **Before:** A opened on "acme · acme-db1 · 17.0 :8069".
2. **Switch Active Version → Odoo 19.0:**
   - the status bar read **"no 19.0 database"** on a warning background;
   - its tooltip: "No database of Odoo 19.0 is selected - click to choose
     one";
   - `launch.json` had only `odoo-debugger`.
3. **Start Server:** "No database is selected for "Odoo 19.0"." with Select
   Database. Nothing started.
   - **Select Database** opened **"Database for Odoo 19.0"**, listing only
     **acme-db19**.
   - I closed it without picking.
4. **Clicking the status bar item** opened the same "Database for Odoo 19.0"
   list, again only acme-db19. I picked it. Then:
   - the status bar read **"acme-db19 · 19.0 :8079"**, without the warning
     background;
   - `launch.json` gained `odoo-debugger-19` with `-p 8079 -d acme-db19`.

## Reopening from Recent: matched

1. **The Recent entry:** with `a106206` installed, Open Project Workspace →
   New window left a `vscode-userdata:` Recent entry.
2. **Reopening:** with `5269f35` installed, File: Open Recent listed A and
   "acme-uid-0001 (Workspace)". Opening the latter showed **"⚠ Reopen for
   debugger"** in the status bar, still there at 30 seconds.
3. **Clicking it** reopened the window from its file, on a `file:` workspace
   storage entry. The item was gone.
4. **Recent once:** File: Open Recent in the reopened window listed
   "acme-uid-0001 (Workspace)" **once**, plus A. After quitting, the saved list
   (`history.recentlyOpenedPathsList`) holds the workspace only as
   `file:///…/acme-uid-0001.code-workspace`, plus A. The
   `vscode-userdata:` entry is gone.

## Findings (eighth run)

### 14. Picking another version's database drops this version's database (moderate)

**Steps:**
1. Use a window whose 17.0 database is selected but was never picked in this
   build. Here that is the seed: acme-db1 is `isSelected` and
   `selectedDbByVersion` is empty. A 1.3 user's data has the same shape.
2. Switch Active Version → 19.0, and pick acme-db19. Asking for exactly that is
   the point of the status bar item.
3. Switch Active Version → 17.0.

**Expected:** 17.0 still launches acme-db1, as it did a minute earlier.

**Happened:**
- right after the pick, `launch.json` lost its `odoo-debugger` entry. Only
  `odoo-debugger-19` (acme-db19) is left;
- back on 17.0, the status bar reads **"no 17.0 database"**;
- the window now remembers only `{"ver-19-0002": "acme-db19"}`.

**Why:** in `resolveDbForVersion` (`src/services/dbResolution.ts:45-53`), the
selection only counts for its own version, and the memory is written only
when a database is picked (`rememberDbForVersion`). A selection that was never
picked in this build is not in the memory. Once the selection moves to a 19.0
database, 17.0 has nothing.

In the seventh run this did not show, because I had switched databases on
17.0 first, which filled the memory.

One way to fix it: when the selection moves to a database of another version,
remember the one it leaves under its own version. Seeding the memory from the
current selection on load would also cover data written before per-version
memory existed.

# Seventh run: the reopen item, and one database version per entry (`f29f37c`)

**Scope:** as asked:
- the test suite;
- a generated workspace an earlier build opened, reopened from Recent: the
  status bar item appears and stays, and clicking it reopens the window;
- a folder window where only 17.0 databases are chosen:
  - no 19.0 entry;
  - Start Server on 19.0 asks for a database;
  - choosing a 19.0 database brings the entry back, naming it;
- with an upgrade set up, both entries name the upgrade's databases.

**Setup:**
- **Profile:** a new throwaway profile (`HOME=/tmp/claude/bm`), with the
  Python extensions and the stub `odoo-bin`.
- **Builds:** `a106206` and `f29f37c`, packaged and installed as in the sixth
  run.
- **Data:** A's data file reset to the seed: acme-db1 and acme-db2 on 17.0,
  acme-db19 on 19.0, acme-db1 selected, 17.0 active. No upgrade.
- **"Only 17.0 databases"** is read as the brief's 7b step 6: the window has
  chosen only 17.0 databases. The project does have a 19.0 database
  (acme-db19), which the window had never chosen, so that there is one to
  pick.

## Verdict (seventh run)

**Everything asked for matched.** Two small observations:
- the status bar pairs 19.0 with a 17.0 database;
- Recent lists the generated workspace twice, under one label.

## Test suite: matched

- VS Code 1.139.1: **449 passing, 0 failing, 0 pending**.

## Reopening from Recent: matched

1. **The Recent entry:** with `a106206` installed, Open Project Workspace →
   New window left the Recent entry
   `vscode-userdata:/tmp/claude/bm/.config/Code/User/globalStorage/ahmadmansour.odoo-devtools-vscode/workspaces/acme-uid-0001.code-workspace`.
2. **Reopening:** with `f29f37c` installed, I opened A, then File: Open Recent
   and "acme-uid-0001 (Workspace)".
3. **The item:** at about 30 seconds the toast was gone and **"⚠ Reopen for
   debugger"** was at the left of the status bar, on a warning background.
   - It was still there about 1.5 minutes later.
   - Its tooltip is the full message: "This workspace was opened in a way that
     keeps the Python debugger from running. Reopen it from its file to fix
     that."
4. **Clicking it** reopened the window from its file: a new workspace-storage
   entry for `file:///…/acme-uid-0001.code-workspace`. The item was gone
   afterwards.

**Observation, low:** File: Open Recent now lists "acme-uid-0001 (Workspace)"
twice, once for the old `vscode-userdata:` entry and once for the new `file:`
one. The labels are identical and the paths are cut off at the same point, so
someone can keep picking the old one. Each time, the item comes back and a
click fixes it, so nothing breaks. Removing the old entry would need VS Code's
own API; that call is yours.

## A window with only 17.0 databases chosen: matched

1. **Switching A to acme-db2** wrote `A/.vscode/launch.json` with only
   `odoo-debugger` (acme-db2). The log says:

   > Skipping launch entry for "Odoo 19.0": Select a database before running
   > this action.
2. **A stale entry is removed:** I added an `odoo-debugger-19` entry naming
   acme-db2, as earlier builds wrote them, and switched to acme-db1.
   - It was **removed**, and the log says "[debugger] removed the launch
     entries of odoo-debugger-19: no database of that version is selected".
   - `odoo-debugger` names acme-db1.
3. **Switch Active Version → Odoo 19.0:** `launch.json` still has no 19.0
   entry.
4. **Start Server:**
   - it showed "No database is selected for "Odoo 19.0"." with **Select
     Database**, and nothing started;
   - Select Database opened the database search, where I chose acme-db19;
   - `odoo-debugger-19` came back with `-p 8079 -d acme-db19`.
     `odoo-debugger` kept `-d acme-db1`.
5. **Start Server again** started the 19.0 server: `-p 8079 … -d acme-db19 -i
   base -u acme_crm`, `cwd` `/tmp/odt-brief/A`, under debugpy.

**Observations, low:**
- **The status bar:** while 19.0 was active and no 19.0 database was chosen, it
  read "acme · acme-db1 · 19.0 :8079". That pairs a 17.0 database with 19.0,
  which 19.0 will no longer launch. The status bar and `launch.json` disagreed
  until a 19.0 database was chosen.
- **The database search** opened from "No database is selected for "Odoo
  19.0"" lists every database, 17.0 ones included. Picking a 17.0 one there
  would not answer the question. I did not try it.

## With an upgrade set up: matched

1. **The upgrade:** Set Up an Upgrade from acme-db2 (17.0) to acme-db19 (19.0),
   with `main` for 19.0.
   - The source was acme-db2 on purpose: this window remembered acme-db1 for
     17.0.
   - "Move this checkout off "17.0-dev"" offered only `parking`.
   - The result: "Upgrade set up: 17.0 → 19.0."
2. **The launch entries:**
   - `odoo-debugger`: `-d acme-db2`, with addons from
     `/tmp/claude/bm/odoo-dev/acme@17.0-dev`;
   - `odoo-debugger-19`: `-d acme-db19`, with addons from
     `/tmp/claude/bm/odoo-dev/acme@main`.
3. **Start Both Upgrade Servers** started both sides, under debugpy with `cwd`
   A:
   - 17.0 on 8069 with acme-db2;
   - 19.0 on 8079 with acme-db19, 31 s later.

   The gap is the command waiting up to 30 s for 8069 to open, which the stub
   never does. A real server binds sooner.

# Sixth run: the fifth run's fixes (`e5fae52`)

**Scope:** as asked:
- the test suite;
- Open Project Workspace → New window, then a database switch:
  - entries under `launch` in the `.code-workspace`;
  - the repository's leftover `.vscode/` gone;
  - Start Server, Restart Server and F5 all start the server;
- a start that fails while a server runs leaves that server running;
- a window reopened the old way, from Recent: the "Reopen It" message once,
  and after reopening, the debugger runs;
- a plain folder window unchanged.

**Setup:**
- **Profile:** a new throwaway profile (`HOME=/tmp/claude/bl`), with the
  Python extensions and the stub `odoo-bin` as in the fifth run.
- **Data:** A's own data file, reset to the seed.
- **Installed builds, not a dev host:** VS Code does not add Extension
  Development Host windows to Recent, so the Recent check cannot be done in
  one. The previous build (`a106206`) and this one (`e5fae52`) were packaged
  with `npx vsce package` from separate worktrees, and installed into the
  profile with `code --install-extension`.
- **The leftover:** made with the previous build (Open Project Workspace, New
  window, database switch): `repos/acme/.vscode/launch.json` with both
  entries.
- **The Recent entry:** with the previous build installed, Open Project
  Workspace → New window left this Recent entry:
  `vscode-userdata:/tmp/claude/bl/.config/Code/User/globalStorage/ahmadmansour.odoo-devtools-vscode/workspaces/acme-uid-0001.code-workspace`.

## Verdict (sixth run)

**Findings 12 and 13 are fixed.** Everything asked for matched.

The one wrinkle: the reopen message is an ordinary toast. It hid itself
before I could click it, twice; it stays in the notification center, and
Reopen It works from there. It's worth a look, because someone who misses it
has no other pointer.

## Test suite: matched

- VS Code 1.139.1: **446 passing, 0 failing, 0 pending**.

## Reopening the old way, from Recent: matched

1. **Opening it:** with this build installed, I opened A, then File: Open
   Recent. The list showed "acme-uid-0001 (Workspace)
   ~/.config/Code/User/globalStorage/ahmadmansour.odoo-devtools-vscode…". I
   picked it.
2. **The message:**

   > This workspace was opened in a way that keeps the Python debugger from
   > running. Reopen it from its file to fix that.

   It came with a **Reopen It** button, and was logged once. The notification
   center held that single message.
3. **The toast hides itself** after a few seconds, like any info message.
   - My first two clicks came after it had gone, so nothing reopened.
   - From the notification center, **Reopen It** reopened the window. A new
     workspace-storage entry appeared for
     `file:///tmp/claude/bl/.config/Code/User/globalStorage/ahmadmansour.odoo-devtools-vscode/workspaces/acme-uid-0001.code-workspace`.
   - The new window's log has no second message.
4. **After reopening:** selecting acme-db1 logged "[debugger] moved 2 launch
   entries out of /tmp/odt-brief/repos/acme into …/acme-uid-0001.code-workspace".
   - The repository's `.vscode/` was gone.
   - **Start Server** started the stub under debugpy: `cwd` `/tmp/odt-brief/A`,
     `-p 8069 … -d acme-db1 -i acme_sale`.

## Open Project Workspace → New window: matched

I put the leftover `launch.json` back into the repository and removed the
`launch` section from the `.code-workspace`, so that both changes would be
visible. Then I quit VS Code and opened A.

1. **Open Project Workspace → New window** opened the window on the `file:`
   workspace, with no reopen message.
2. **Selecting acme-db2:**
   - the log says "[debugger] moved 2 launch entries out of
     /tmp/odt-brief/repos/acme into …";
   - `repos/acme/.vscode/` is **gone**, and git shows the repository clean;
   - the `.code-workspace` has `launch` with `odoo-debugger-19` and
     `odoo-debugger`, both `"cwd": "/tmp/odt-brief/A"` and `-d acme-db2`.
3. **Start Server:** started: `-p 8069 … -d acme-db2 -i base -u acme_stock`,
   `cwd` `/tmp/odt-brief/A`, under debugpy (pid 1265814).
4. **Restart Server:** pid 1265814 ended, and a new run started (pid 1268012)
   with the same arguments.
5. **F5 (Debug: Start Debugging):** started the Run view's selected entry,
   `odoo-debugger-19 (workspace)`: `-p 8079 … -d acme-db2`, under debugpy.

## A start that fails leaves the running server alone: matched

1. With pid 1268012 running, I removed the `odoo-debugger` entry from the
   `.code-workspace`. It stayed removed: nothing rewrote it.
2. **Start Server** showed "Could not start "odoo-debugger". Its launch entry
   may not be written yet."
3. **pid 1268012 kept running**, and no new run started.
4. I put the entry back afterwards.

## A plain folder window: matched

In folder window A, selecting acme-db1 rewrote `A/.vscode/launch.json`: both
entries, `"cwd": "/tmp/odt-brief/A"`, `-d acme-db1`. The `.code-workspace` was
byte-identical afterwards, and the repository got nothing.

- **Start Server:** `-p 8069 … -d acme-db1 -i acme_sale`, under debugpy.
- **F5:** started the selected `odoo-debugger-19 (A)`: `-p 8079 … -d acme-db1`.

## Also seen (sixth run)

- **The first New window click:** in the two fresh dev-host profiles, the
  first New window click on Open Project Workspace opened nothing, while the
  second worked. The log had no error. With the installed build it worked the
  first time. It is unexplained, and may be how I drive the window.

# Fifth run: launch entries in the workspace file (`73c7645`)

**Scope:** as asked:
- the test suite;
- item 3: switch database in the generated window, and start the server;
- no `.vscode/launch.json` in the repository, and the entries under `launch`
  in the generated `.code-workspace`;
- F5 and Start Server both start the server;
- a `launch.json` left in the repository by an earlier build loses the
  extension's entries;
- a plain single-folder workspace still writes and launches from
  `.vscode/launch.json`.

**Setup:**
- **Profile:** a new throwaway profile (`HOME=/tmp/claude/bk`). The Python and
  Python Debugger extensions were copied in from the user's install, so that
  F5 can really launch.
- **Data:** A reads its own `.vscode/odoo-debugger-data.json`, reset to the
  seed. There is no upgrade, and the acme clone is on `17.0-dev`.
- **A stub `odoo-bin`:** it appends one line per start to
  `/tmp/odt-brief/odoo-runs.log`: working directory, arguments, and whether
  debugpy loaded it. Then it idles. "Started" below means a line appeared
  there.
- **Leftover `launch.json`:** made with the previous build, `1dc224a`, in a
  separate worktree. It was run through Open Project Workspace and a database
  switch, and wrote `repos/acme/.vscode/launch.json` (`?? .vscode/` in git),
  with `odoo-debugger` and `odoo-debugger-19`, both with
  `"cwd": "/tmp/odt-brief/repos/acme"`.
- **A probe:** a throwaway extension that logs
  `vscode.workspace.workspaceFile`. It was loaded next to ours for the runs
  that needed it.

## Verdict (fifth run)

- **Fixed, when the workspace file is opened directly:**
  - the entries move into the file's `launch` section;
  - the repository's leftover `launch.json` and its `.vscode` go;
  - F5 starts the server;
  - the folder window is unchanged.
- **Not fixed through Open Project Workspace, which is the brief's path
  (serious):** the switch rewrites the repository's `launch.json` again, and
  the workspace file gets nothing. See finding 12.
- **Start Server fails in a workspace-file window (serious):** VS Code reports
  "'launch.json' does not exist for passed workspace folder." Before failing,
  it stops a server that is already running. See finding 13.

## Test suite: matched

- VS Code 1.139.1: **441 passing, 0 failing, 0 pending**.
- The new suites all ran and passed:
  - `Where launch configurations live`;
  - `Launch configurations in a workspace file`;
  - `Taking our entries back out of a repository`.

## 3. The generated window, through Open Project Workspace: not matched

1. **Opening:** in A, I ran Open Project Workspace and chose New window. The
   generated window showed acme with acme-db2, as A's data file said. (On the
   very first try with the old build, the New window click opened nothing. The
   second try worked. That was probably my click, and it did not happen again.)
2. **The switch:** I selected acme-db1 in the generated window. Then:
   - `repos/acme/.vscode/launch.json` was **rewritten** by the new build (same
     second as the switch). Both entries now have
     `"cwd": "/tmp/odt-brief/A"` and `-d acme-db1`;
   - the generated `.code-workspace` was **not touched**: it has no `launch`
     section;
   - nothing was cleaned up, the log has no `[debugger] moved …` line, and git
     still shows `?? .vscode/`.
3. **Why, per the probe:** in this window, `vscode.workspace.workspaceFile` is
   `vscode-userdata:/tmp/claude/bk/.config/Code/User/globalStorage/ahmadmansour.odoo-devtools-vscode/workspaces/acme-uid-0001.code-workspace`.
   - `launchTarget` (`src/services/launchConfig.ts:51`) accepts only a `file`
     scheme, so it falls back to the first folder.
   - The scheme comes from `buildWorkspaceFile`: it builds the path from
     `context.globalStorageUri` (`src/projectWorkspace.ts:61`) and opens that
     URI with `vscode.openFolder` (`:158`).
   - Opened from the command line, the same file reports `file:`.
   - `src/services/dataLocation.ts:145` makes the same `scheme === 'file'`
     check. There it is harmless today, because the generated workspace pins
     an absolute path.
4. **Start Server here:** VS Code refused with "Configured debug type
   'debugpy' is installed but not supported in this environment." Nothing
   started. Running Tasks: Run Task first did not help.
   - `debugpy` declares its debugger only
     `when: "!virtualWorkspace && shellExecutionSupported"`.
   - In the directly opened window below, with the same profile and
     extensions, debugpy worked.
   - So the `vscode-userdata:` workspace probably also keeps the Python
     debugger from running at all in a window opened this way. That part is
     likely, not proven.
5. **Per-window selection:** A kept its own selection, as before.

## 3. The same workspace file, opened directly: matched, except Start Server

I opened the generated `.code-workspace` from the command line, with the
repository's leftover `launch.json` in place.

1. **The switch:** after selecting acme-db2, the log says:

   > [debugger] moved 2 launch entries out of /tmp/odt-brief/repos/acme into
   > …/workspaces/acme-uid-0001.code-workspace

   - `repos/acme/.vscode/` is **gone**, and git shows the repository clean;
   - the `.code-workspace` has a `launch` section with `odoo-debugger-19` and
     `odoo-debugger`, both `"cwd": "/tmp/odt-brief/A"` and `-d acme-db2`;
   - the run configuration list shows both as "workspace" entries.
2. **F5 (Debug: Start Debugging):** started. The stub recorded `cwd`
   `/tmp/odt-brief/A`, `-p 8069 … -d acme-db2 -i base -u acme_stock`, under
   debugpy. Picking `odoo-debugger (workspace)` from the list did the same.
3. **Start Server: not matched.** VS Code showed the modal:

   > Command 'Odoo DevTools: Start Server' resulted in an error
   >
   > 'launch.json' does not exist for passed workspace folder.

   Nothing started.
   - I ran it again with the F5 server running: it **stopped that server
     first**, then failed with the same modal.
   - It is finding 13.
4. **Rebuilding keeps the section:** Open Project Workspace, run again from A,
   rewrote the `.code-workspace`. Both `launch` entries were unchanged; only
   the indentation differs.

## A plain folder window: matched

In folder window A, selecting acme-db2 rewrote `A/.vscode/launch.json`. Both
entries name `acme-db2`, with `"cwd": "/tmp/odt-brief/A"`. Nothing was written
anywhere else.

- **Start Server:** started `odoo-debugger`: `cwd` `/tmp/odt-brief/A`, `-p
  8069 … -d acme-db2`, under debugpy.
- **F5:** started the Run view's selected entry, `odoo-debugger-19 (A)`: `-p
  8079 … -d acme-db2`, under debugpy.

**Side observation, not from this fix:** with no 19.0 database chosen in the
window, the `odoo-debugger-19` entry names `acme-db2`, a 17.0 database. The
previous build wrote the same into the repository. Earlier, while the upgrade
was set up, it named `acme-db19`.

## Findings (fifth run)

### 12. Through Open Project Workspace, launch entries still go into the repository (serious)

**Steps:**
1. In A, run Open Project Workspace, then New window.
2. Switch database in the new window.

**Expected:** entries under `launch` in the `.code-workspace`, and no
`.vscode/launch.json` in the repository. A leftover one loses our entries.

**Happened:** the repository's `launch.json` is rewritten; it is created if
missing. The workspace file is untouched, and nothing is cleaned up.

**Cause:** the window's `workspaceFile` is a `vscode-userdata:` URI, because
the file is opened by its `globalStorageUri` URI. `launchTarget` accepts only
`file:`.

Whatever the fix, the unit tests pass `{ scheme: 'file' }` and cannot see
this. Two ways a fix might go:
- open the file as `vscode.Uri.file(workspaceFile.fsPath)`. A window reopened
  from Recent would still carry whatever URI it was first opened with;
- accept any scheme whose `fsPath` is on local disk.

### 13. Start Server cannot start an entry that lives in a workspace file (serious)

**Steps:** in a window whose entries are in the `.code-workspace` (opened
directly, so finding 12 does not interfere), run Start Server.

**Happened:** "Command 'Odoo DevTools: Start Server' resulted in an error —
'launch.json' does not exist for passed workspace folder." Nothing starts, and
a running server of that version is stopped first. F5 and the Run view start
the same entry fine.

**Likely cause:** `vscode.debug.startDebugging(undefined, name)` does not look
names up in the workspace file's `launch` section.

Everything that goes through `startServerForVersion` is probably affected:
Restart Server, Run Server Without Debugging and Start Both Upgrade Servers.
I only ran Start Server.

# Fourth run: the first-setup move-off list (`9405f86`)

**Scope:** as asked:
- the test suite;
- one fresh, first-time upgrade setup, to check the "Move this checkout off"
  list.

**Setup:** a new throwaway profile (`HOME=/tmp/claude/bj`), so there was no
remembered upgrade, no copies under `~/odoo-dev` and no window state.
- Window A read its own `.vscode/odoo-debugger-data.json`, reset to the seed.
  That seed has no `upgradeConfig`, no `branchMode` and no
  `projectRepoBranches`.
- The acme copies from the third run were removed, and the acme clone was put
  back on `17.0-dev`. Its branches were `17.0-dev`, `main` and `parking`.

## Verdict (fourth run)

**Finding 11 is fixed.** On a first setup, "Move this checkout off" offered
only `parking`. The setup then finished and built both copies.

## Test suite: matched

- VS Code 1.139.1: **430 passing, 0 failing, 0 pending**.
- The new test `the branch the other side of an upgrade needs is not offered
  to move onto` ran and passed.

## First-time upgrade setup: matched

1. **Set Up an Upgrade** asked for the source database, with no pair filled
   in. I picked acme-db1 (17.0) as the source and acme-db19 (19.0) as the
   target.
2. **The branch for 19.0:** the list offered `main` and `parking`. I picked
   `main`.
3. **The plan** read acme-db1 → acme-db19, acme from `17.0-dev` to `main`. The
   confirmation named two new copies: `…/odoo-dev/acme@17.0-dev` and
   `…/odoo-dev/acme@main`. I clicked Set It Up.
4. **The modal:** "Your checkout of "acme" is on "17.0-dev". …" I chose Move
   to Another Branch.
5. **"Move this checkout off "17.0-dev"" listed `parking` and nothing else.**
   `main` was left out, and so was `17.0-dev`, the branch being freed.
6. **After I picked `parking`:**
   - the log says "[worktree] moved /tmp/odt-brief/repos/acme to parking to
     free 17.0-dev";
   - the toast "Upgrade set up: 17.0 → 19.0." appeared, with Start Both
     Servers;
   - `git worktree list` shows the source on `[parking]`, plus
     `acme@17.0-dev [17.0-dev]` and `acme@main [main]`;
   - no problem was reported.
7. **The log** had no errors. Its warnings come from the fixture, as in the
   earlier runs: no real PostgreSQL databases, a fake Odoo source that is not
   a git repository, and no Python extension to set the interpreter.

# Third run: the second round of fixes (`e8741b9`)

**Scope:** as asked:
- the test suite;
- item 5 (no error toast);
- item 7b, including its new step 5;
- item 12 (a warning, not "Error running command");
- the "Move this checkout off" list during an upgrade setup.

**Setup:** the same throwaway setup as the second run. The fixture was
rebuilt from scratch, again with `acme-db19` on 19.0. The throwaway acme clone
has a spare `parking` branch, so that there is something to move to. The store
is `/tmp/odt-brief/shared.db`, reached through Create a new store…, All
workspaces, then Bring It Along.

## Verdict (third run)

- **Fixed and confirmed:**
  - finding 5: no "No project is selected." in a new window;
  - finding 9: after another window turns an upgrade on and off, A's status
    bar, Databases view, `launch.json` and Copy Odoo Command all name the same
    database;
  - finding 10: a refused change is a warning naming the store.
- **Partly fixed, finding 11:** "Move this checkout off" now leaves out a
  branch another worktree **already holds**. Tested on resume: only `parking`
  was offered, not `main`. On a **first** setup, though, it still offers
  `main`, the branch the same setup is about to give the 19.0 copy.

## Test suite: matched

- VS Code 1.139.1: **429 passing, 0 failing, 0 pending**.
- `two processes committing at once lose no update …` ran and passed (203 ms).
- The rebuilt `dist/` was identical to the committed one.

## 5. A second window on the same store: matched

- **B on open:** B showed `acme` and `beta` with nothing selected. No toast
  appeared before or after opening the Odoo view.
- **B's notification center** held only the older info "2 version(s) were
  built before provisioning and can be migrated."
- **Logs:** no window's **Odoo DevTools** log contains "No project is
  selected".
- **B's selection:** `beta · beta-db1 · 19.0`. A stayed on
  `acme · acme-db1 · 17.0`.

## 7b. Each window launches its own database: matched, all five steps

1. **Steps 1 to 3.** A was on acme-db1 and B on acme-db2.
   - A's Copy Odoo Command: `-d acme-db1 -i acme_sale`.
   - A's `launch.json`, `odoo-debugger`: `-d acme-db1 -i acme_sale`.
   - B's `launch.json`: `-d acme-db2 … -u acme_stock`.
2. **Step 4.** I set up acme-db2 (17.0) → acme-db19 (19.0) from A. The toast
   read "Upgrade set up: 17.0 → 19.0.". Both windows then had 17.0 →
   `acme-db2` and 19.0 → `acme-db19`.
3. **Step 5:**
   1. B turned the upgrade off.
   2. A selected acme-db1; its status bar showed `acme-db1`, and its
      `launch.json` had `-d acme-db1 -i acme_sale`.
   3. B turned it on ("Upgrade resumed: 17.0 → 19.0."). A's status bar, view
      and `launch.json` moved to `acme-db2`.
   4. B turned it off.

   **A's status bar, Databases view (check mark), `launch.json` (17.0) and
   Copy Odoo Command all named `acme-db2`.** They agree. A does not return to
   its earlier `acme-db1`: the upgrade's source database stays selected. The
   brief accepts either, as long as they agree.

## 12. A store from the future: matched

- **On open,** a warning toast was on screen within 3 s and stayed up:

  > The data store /tmp/odt-brief/shared.db is read-only here: it was written by a newer Odoo DevTools (schema 99). Changes to projects, versions and databases cannot be saved; selecting still works in this window.

- **Selecting acme-db1** worked.
- **Marking `acme_crm` for install** gave a **warning** toast, not "Error
  running command":

  > The data store /tmp/odt-brief/shared.db is read-only here: a newer Odoo DevTools (schema 99) wrote it; the change was not saved.

  The mark did not appear, and the store stayed byte-identical.
- **Afterwards:** reset to `1`, and the user-level store setting cleared.

## "Move this checkout off": partly fixed

- **First setup.** At the prompt, `git worktree list` showed only the source,
  on `17.0-dev`; no copy existed yet. The list offered **`main` and
  `parking`**, although the same setup then created `…/acme@main`. Choosing
  `main` would move the source onto the branch the 19.0 copy is about to
  need.
- **Cause, from reading the fix:** `reserved` is built from `resolved`, the
  copies being made for the **current** version. The other side of the
  upgrade (19.0 → `main`) is not in it.
- **Resume, the case that failed in the second run.** I removed
  `acme@17.0-dev`, put the source back on `17.0-dev` (with `acme@main`
  holding `main`), and toggled the upgrade on. The list offered **only
  `parking`**. This case is fixed.

---

# Second run: the fixes (`b714132`)

**Scope:** the test suite, then items 2, 5, 7, 7b, 9 and 12 of the updated
brief, as asked. The environment is the same as the first run's (Ubuntu 26.04,
VS Code 1.139.1 as an Extension Development Host under Xvfb, a throwaway
`HOME`, PostgreSQL running without the fixture databases).

**Fixture:** rebuilt from scratch. It is the same as the first run's, plus
`acme-db19`, linked to 19.0, so that 7b has an upgrade target. The store was
`/tmp/odt-brief/shared.db`, reached through Choose Data Store, **Create a new
store…**, then **All workspaces**, **Bring It Along**.

## Verdict (second run)

- **Fixed and confirmed in real windows:**
  - finding 1: each window launches its own database, and an active upgrade
    pins both sides in both windows;
  - finding 2: the workspace's own file keeps the selection, and a second
    profile opens where the first left off;
  - finding 3: a no-op import says so and writes nothing;
  - finding 6: Replace now names what it discards and defaults to keeping;
  - finding 7: a read-only store is announced on open, selecting works,
    changes are refused;
  - finding 8: Choose Data Store marks the store in use, and the Projects view
    names it;
  - the cloned-version remap.
- **Still present:** finding 5, the error toast "No project is selected." on a
  new window with no selection.
- **New, moderate (finding 9):** after an upgrade is toggled off from
  **another** window, window A **shows** one database as selected but
  **launches** another.
- **New, minor (findings 10 and 11):**
  - a refused change on a read-only store surfaces as VS Code's generic
    "Error running command …", which blames the extension;
  - the source-checkout picker offers a branch another worktree already holds.
- **Not re-tested:** items 3, 4, 6, 8, 10 and 11, since they were not asked
  for. Item 4's dialogs were seen along the way (see item 5 below).

## Test suite: matched

- `npm ci`, then `npm test` on VS Code 1.139.1: **416 passing, 0 failing,
  0 pending**.
- `✔ two processes committing at once lose no update to their own databases
  (201ms)` ran and passed.
- Lint: 0 errors.
- The rebuilt `dist/` was identical to the committed one.

## 2. An existing workspace keeps its selection: matched

- **On open,** A showed `acme · acme-db1 · 17.0 :8069`. The file's only change
  was a default `testingConfig` added to `acme`; the selection stayed in the
  file.
- **After selecting acme-db2 and closing,** the diff against the copy showed:
  - `acme-db1` `isSelected` became `false`, and `acme-db2` became `true`;
  - `activeVersion` and `isActive: true` were kept;
  - `acme` gained `"selectedDbByVersion": { "ver-17-0001": "acme-db2" }` and
    the default `testingConfig`;
  - nothing else changed.
  The file records the selection I left. The repositories' `isSelected` flags
  were untouched.
- **Reopening A** brought back `acme · acme-db2 · 17.0`.
- **`--profile-temp`:** the window titled "Temp 1" opened A on
  `acme · acme-db2 · 17.0 :8069`, with the same selection in the Databases
  view and **no** "No project is selected." toast. Finding 2 is fixed.

## 5. A second window on the same store: matched

- **Moving A onto the store.** On the way, item 4's list read:
  - "Shared store", "Open an existing store…", "Create a new store…";
  - "This workspace only .vscode/odoo-debugger-data.json — in use", marked
    with a check and pre-selected;
  - placeholder: "Now using this workspace's file …".
  The bring-along dialog read "It adds: 2 new projects / 4 databases added /
  2 new versions". Afterwards, the Projects view header read
  **"shared: shared.db"**. Finding 8 is fixed.
- **The store holds no selection:** no project or database carries
  `isSelected`, and no project carries `selectedDbByVersion`.
- **B on open** showed `acme` and `beta` with nothing selected, and still
  raised the **error toast "No project is selected."** with [Select Project].
  Finding 5 is unchanged.
- **B's selection:** I chose `beta`, `beta-db1` and Odoo 19.0. A stayed on
  `acme · acme-db2 · 17.0`, and the store still recorded no per-version
  database.

## 7. Simultaneous edits to one project: matched

A was on acme-db1 and B on acme-db2. I ran three rounds of context-menu marks,
about 0.3 s apart:
- install versus upgrade;
- upgrade versus install;
- clear versus install.

Every mark was kept on its own database and shown in both windows. The rev
went 1 → 3 → 5 → 7. `[store] merged changes…` did not appear: the saves did
not overlap, as in the first run.

## 7b. Each window launches its own database: matched

**Steps 1 to 3.** A was on acme-db1 and B on acme-db2, both 17.0.

- A's **Copy Odoo Command**:
  `… -d acme-db1 -i acme_sale -u acme_stock …`, which is acme-db1's own marks.
- A's `launch.json`, `odoo-debugger` (17.0): `-d acme-db1 -i acme_sale -u acme_stock`.
- B's `launch.json`, `odoo-debugger`: `-d acme-db2 -i acme_stock,acme_crm -u acme_sale`.

Finding 1 is fixed.

**Step 4, with an upgrade.**
- **Setup:** in A, Set Up an Upgrade, with acme-db2 (17.0) → acme-db19
  (19.0), acme `17.0-dev` → `main`. The plan dialog listed the per-branch
  copies under the throwaway `HOME`.
- **Result:** both windows' `launch.json` files had `odoo-debugger` (17.0)
  with `-d acme-db2` and `odoo-debugger-19` with `-d acme-db19` (on
  `…/acme@main`).
- **A cannot diverge from the pin.** Selecting acme-db1 in A while the upgrade
  was on was refused: '"acme-db1" is not part of this upgrade, so it cannot be
  selected while an upgrade is set up.' [Exit Upgrade Mode].
- **The discriminating case:**
  1. B toggled the upgrade off.
  2. A selected acme-db1; its status bar showed `acme-db1`.
  3. **B** toggled the upgrade back on, which read "Upgrade resumed: 17.0 →
     19.0.".
  A's Copy Odoo Command then gave `-d acme-db2 -i acme_stock,acme_crm -u
  acme_sale`, and both windows' `launch.json` files had 17.0 → `acme-db2` and
  19.0 → `acme-db19`. The pin wins in the window that did not set it.
- **Side observation:** during setup, cancelling "Move this checkout off
  17.0-dev" did not cancel the setup. The upgrade was saved as active, running
  on the source checkout, with the warning "acme is using the source checkout:
  the branch each needs is checked out there." [Resolve]. That may be intended.

## 9. Export and import: matched

1. **Export.** The notification read "Exported 2 project(s) to
   /tmp/odt-brief/export1.json.". The file has no project or database
   `isSelected`, no `activeVersion` and no `selectedDbByVersion`. The two
   `isSelected: true` are repository flags. Every path is absolute, including
   `dumpsFolder` (`/tmp/odt-brief/DB Dumps`) and the upgrade's `repoPath`.
2. **Re-import, verbatim:**

   > Import export1.json into shared store /tmp/odt-brief/shared.db?
   >
   > Nothing is missing: it is all here already.
   >
   > (2 versions are already there, matched by branch.)
   >
   > Merge never overwrites what is here. Replace would discard the 2 projects, 2 versions and 4 databases here now.
   >
   > [Replace…] [Cancel] [Merge]

   After Merge, the toast read "Nothing to import: everything in export1.json
   is already here.", and the store was **byte-identical**, revs included.
   Finding 3 is fixed.
3. **Raw seed file** (`odoo-debugger-data.json`, copied into A's `.vscode/`):
   the same "Nothing is missing" preview. Merge wrote nothing, and there were
   still two versions.
4. **Another machine's file with a clone.** Versions `m2-17-aaaa`,
   `m2-19-bbbb` and a clone `m2-17-clone` ("Odoo 17.0 (clone)", port 8089),
   plus projects `gamma` (on the clone) and `delta` (on 19.0). The preview
   read "Merging adds: 2 new projects / 2 databases added / 1 new version /
   (2 versions are already there, matched by branch.)". After Merge:
   - the clone was added as its own version;
   - `gamma-db1` → `m2-17-clone`;
   - `delta-db1` → `ver-19-0002`, remapped.
   **The clone does not collapse.**
5. **Replace.** I imported a one-project `small.json`. The first dialog read
   "Nothing is missing… Replace would discard the 4 projects, 3 versions and 6
   databases here now." The second, verbatim:

   > Replace everything in shared store /tmp/odt-brief/shared.db with small.json?
   >
   > The 4 projects, 3 versions and 6 databases there now are discarded, and replaced by the 1 project, 3 versions and 1 database in the file. Export first if you might want them back.
   >
   > [Replace Everything] [Cancel] [Keep Current Data]

   **Keep Current Data** is the default. I chose Cancel, and the store was
   unchanged. The wording now says what happens before you commit. One small
   thing: "discard the 4 projects" counts `beta`, which the file puts straight
   back. The second dialog's "replaced by …" makes that clear.

## 12. A store from the future: matched

- **On open:** with schema set to 99, the data showed, and a warning was
  raised on open, found in the notification center:

  > The data store /tmp/odt-brief/shared.db is read-only here: it was written by a newer Odoo DevTools (schema 99). Changes to projects, versions and databases cannot be saved; selecting still works in this window.

- **Selecting acme-db1** worked, with no error. Finding 7 is fixed.
- **Marking a module** was refused. The mark did not appear, and the store
  stayed byte-identical. See finding 10 for how the refusal is shown.
- **Afterwards:** reset to `1`, and the user-level
  `odooDebugger.dataStore.path` cleared.

## New findings (second run)

### 9. After another window toggles an upgrade off, a window shows one database and launches another (moderate)

**Steps** (A and B on `acme`, one shared store, a remembered upgrade
acme-db2 (17.0) → acme-db19):
1. With the upgrade off, select `acme-db1` in A.
2. In **B**, toggle the upgrade on. A follows: its view and status bar move to
   `acme-db2`, and it launches `acme-db2`, as expected.
3. In **B**, toggle the upgrade off again.

**Expected:** A is back where it was, showing and launching `acme-db1`, or at
least showing what it launches.

**Happened:** A's status bar and Databases view show **`acme-db2`**, but A's
Copy Odoo Command and `launch.json` use **`-d acme-db1`**.

**Cause:** A's `workspaceState`
(`AhmadMansour.odoo-devtools-vscode` → `odt.workspaceSelection`) holds
`"selectedDbByProject": {"acme-uid-0001": "acme-db2"}` but
`"rememberedDbByProject": {"acme-uid-0001": {"ver-17-0001": "acme-db1", …}}`.
- When the upgrade became active, A's selected database was moved to the
  pinned one, but its per-version memory was not.
- When the upgrade ended, `resolveDbForVersion` preferred the memory
  (`acme-db1`) over the selection (`acme-db2`).

The same mismatch is possible in the window that toggles the upgrade itself;
I did not check that.

### 10. A change refused by a read-only store shows as an extension crash (minor)

Marking a module on the schema-99 store shows:

> Error running command moduleSelector.setToInstall: The data store /tmp/odt-brief/shared.db was written by a newer Odoo DevTools (schema 99); it is read-only here.. This is likely caused by the extension that contributes moduleSelector.setToInstall.

The `StoreReadOnlyError` escapes the command handler, so VS Code adds its
"likely caused by the extension" line. The message also ends in a double
period. The log shows `WARN: Failed to flush pending write for …`. The
behaviour is right (nothing was written); only the presentation is off.

### 11. The source-checkout picker offers a branch another worktree holds (minor)

During setup and resume, "Move this checkout off '17.0-dev'" offered `main`.
The `…/acme@main` worktree already had `main` checked out (after the first
setup), so choosing it cannot work. It should be filtered out or explained.
The first time, it was the **only** choice, so the user's only ways out were
Detach or Cancel.

### Still present: finding 5

"No project is selected." is still an **error** toast on a new window with no
selection (B in item 5).

---

# First run (`d6e4207`)

## Verdict

- **Works:**
  - the test suite in a real Extension Host (401 passing, none skipped);
  - selection kept per window;
  - the Open Project Workspace fix;
  - moving onto a shared store and bringing data along;
  - a second window on the same store;
  - live refresh, with no ping-pong;
  - simultaneous marks on two databases, none lost;
  - testing mode per window, with the stash per database;
  - export, import and version remapping by branch;
  - the Replace confirmation;
  - going back to the workspace's own file;
  - a newer-schema store opened read-only;
  - VS Code Insiders on the same store, with live refresh between the two
    editors.
- **Broken, serious:** **a window launches the database another window
  selected.** `selectedDbByVersion` is shared, and `resolveDbForVersion`
  prefers it over the window's own selection. So F5, Copy Odoo Command and
  launch.json in window A follow whichever window last picked a database for
  that version (finding 1). This contradicts the README's "Selecting a
  database in one window never changes what another window launches."
- **Broken, moderate:**
  - an existing workspace's own data file loses its selection on the first
    run, even without opting in. The same workspace in another profile, in
    another editor, or on an older build then opens with nothing selected
    (finding 2);
  - the import and bring-along previews announce changes when there are none
    (finding 3).
- **Minor:** four UX issues, findings 4 to 8.
- **Could not test:**
  - the refusal path on an old runtime: no runtime here that lacks
    `node:sqlite` can install the extension;
  - Cursor and VSCodium: not installed;
  - the `[store] merged changes…` conflict path in real windows: it never
    triggered (item 7).

## Environment

- **OS:** Ubuntu 26.04.1 LTS, kernel 7.0.0-31, x64.
- **VS Code:** 1.139.1 (Electron 43.6.0, Node 24.20.0), for the test suite and
  items 2 to 10 and 12. It ran as an Extension Development Host from this repo.
- **Other editor:** VS Code Insiders 1.137.0-insider (Electron 42.10.0, Node
  24.18.1), with the packaged `.vsix` installed (item 11). The versions come
  from each binary's `process.versions`, not from Help → About.
- **PostgreSQL:** running. The fixture databases do not exist in it, so the
  log shows `psql … database "acme-db1" does not exist` warnings. Nothing was
  blocked by them.
- **How the windows were driven:**
  - headless, under Xvfb, with xdotool; every observation comes from a
    screenshot, a file on disk, the store read with the `sqlite3` CLI, or the
    **Odoo DevTools** output channel's log file;
  - each editor ran with its own throwaway `HOME`, so it had a fresh profile;
  - `files.simpleDialog.enable` was on, so the save and open dialogs were
    VS Code's own typed-path dialogs rather than GTK's.
- **Fixture:**
  - workspace `A` held a hand-written 1.3-shaped data file with projects
    `acme` (databases `acme-db1` and `acme-db2`, repository `acme`) and `beta`
    (one database, one repository), versions 17.0 and 19.0, and a selection
    of `acme`, `acme-db1` and 17.0;
  - workspace `B` was empty;
  - the store was `/tmp/odt-brief/shared.db`, and the repositories were
    throwaway git clones with three addons each.
  The default store path was never used.

## Items

### 1. The test suite, in a real Extension Host: matched

I ran `npm ci`, then `npm test`, whose pretest step runs compile-tests,
compile and lint. `@vscode/test-electron` downloaded **VS Code 1.139.1**.

- **401 passing, 0 failing, 0 pending.**
- Lint: 0 errors. The only warnings are older `no-explicit-any` ones.
- All seven new suites ran: `Workspace selection`, `Data location`,
  `JSON main store`, `Testing stash`, `Three-way document merge`,
  `SQLite main store` and `Data import`.
- `✔ two processes committing at once lose no update to their own databases
  (219ms)` **ran and passed**. It forked its child under the Extension Host
  with no spawn or module error.
- The `dist/` produced by the build was identical to the committed one.

### 2. An existing workspace keeps its selection: matched

- **On open,** A showed `acme · acme-db1 · 17.0 :8069` in the status bar and
  the same selection in the views.
- **The flags left the file at activation,** before I changed anything:
  `activeVersion` was removed, and the project and database `isSelected`
  flags and `isActive` all became `false`.
- **After selecting acme-db2 and closing,** the diff against the copy
  showed:
  - no `activeVersion`, and every version `"isActive": false`;
  - project and database `isSelected` all `false`;
  - two keys added to project `acme`:
    `"selectedDbByVersion": { "ver-17-0001": "acme-db2" }`, and a default
    `testingConfig` (`isEnabled: false`, …);
  - otherwise only a reformat: single-line objects expanded.
- **Two `"isSelected": true` remain.** They belong to repositories
  (`RepoModel.isSelected`), not to the selection. So "no `isSelected: true`
  anywhere" in the brief cannot hold literally; every project and database
  flag was `false`.
- **Reopening A** brought back `acme · acme-db2 · 17.0`.

### 3. Open Project Workspace keeps the data: matched

- **Command:** Open Project Workspace, then **New window**. The generated
  `.code-workspace` pins the store:
  `"odooDebugger.dataStore.path": "/tmp/odt-brief/A/.vscode/odoo-debugger-data.json"`.
- **The new window** showed both projects and the same selection,
  `acme · acme-db2 · 17.0`.
- **The repository folder** got no data file. After a database switch it did
  get `.vscode/launch.json`, the known separate issue. It shows up as
  untracked (`?? .vscode/`) in the user's repository.
- **Per-window selection:** I selected acme-db1 in the generated window. A
  kept acme-db2.

### 4. Moving a workspace onto a shared store: matched

Command: Choose Data Store, then **Choose a store file…**, then
`/tmp/odt-brief/shared.db`, then **All workspaces**.

- **The scope quick pick** reads: "Use it where?", with "All workspaces:
  Every workspace uses this store unless it chooses otherwise." and "This
  workspace only: Other workspaces keep whatever they use now."
  **This makes sense without the README.**
- **The bring-along dialog, verbatim:**

  > Bring this workspace's data into /tmp/odt-brief/shared.db?
  >
  > 2 new projects
  > 3 databases added
  > 2 new versions
  >
  > Nothing already in that store is overwritten. This workspace's own file is left as it is.
  >
  > [Use What Is There] [Cancel] [Bring It Along]

- **After Bring It Along:**
  - the same projects and the same selection;
  - the notification "Now using the shared store /tmp/odt-brief/shared.db.";
  - A's own file byte-identical, by md5;
  - relative paths made absolute in the store (`./custom` became
    `/tmp/odt-brief/A/custom`, `../DB Dumps` became `/tmp/odt-brief/DB Dumps`).
- **The placeholder** afterwards reads "Now using shared store
  /tmp/odt-brief/shared.db". Before, it read "Now using this workspace's file
  /tmp/odt-brief/A/.vscode/odoo-debugger-data.json". See finding 8 for the
  list itself.

### 5. A second window on the same store: matched

- **Opening B:** a second `code --extensionDevelopmentPath=…` is absorbed by
  the running Development Host, which keeps one window. So I opened B through
  **New Window** and **Open Folder** from inside the host.
- **B on open** showed `acme` and `beta` with nothing selected, and raised an
  error toast, "No project is selected." (finding 5).
- **B's selection:** I chose `beta`, `beta-db1` and **Odoo 19.0**. A stayed on
  `acme · acme-db2 · 17.0`.

### 6. Live changes between windows: matched

- **Rename:** in B, I renamed acme-db1's display name to "Acme Main". A's
  Databases view showed it about **1.8 s** later, with no action in A. I
  timed it by capturing frames every ~0.25 s.
- **Idle for 60 s:**
  - the **Odoo DevTools** log line count stayed the same in both windows;
  - every document `rev` stayed the same, and so did the WAL file's mtime;
  - a 20 s pixel diff of both windows came to **0 pixels**.
  No ping-pong.

### 7. Simultaneous edits to one project: matched, merge path not seen

A was on acme-db1 and B on acme-db2. Selecting acme-db2 in B also switched B
from 19.0 to 17.0, the database's version.

- **Four rounds:** each time I marked a different module in each window
  through the context menu. The two clicks were about 0.3 to 0.4 s apart:
  - install versus upgrade;
  - upgrade versus install;
  - clear versus install;
  - clear versus install, in reverse order.
- **Result:** every mark was kept, on its own database, and shown in both
  windows. The project `rev` went 3 → 5 → 7 → 9 → 11.
- **`[store] merged changes another window made to: …`** never appeared.
  `SettingsStore.get()` re-checks `data_version` on every read, so two saves
  only conflict when they land within milliseconds of each other. Clicks this
  far apart cannot reach that path, so the merge is covered only by the unit
  tests.

### 8. Testing mode per window, stash per database: matched

- **Turning testing on in A** (on acme-db1) showed: "Enabling testing will
  clear all current module selections (install/upgrade). The current states
  will be saved and can be restored when testing is disabled. Continue?"
  with [Cancel] [Enable Testing].
- **After Enable Testing:**
  - A's Testing view shows "Testing Enabled";
  - acme-db1's marks are cleared, and its stash is stored on acme-db1
    (`testingModuleStates`: `acme_sale` install, `acme_stock` upgrade,
    `acme_crm` install);
  - B shows "Testing Disabled".
- **I selected acme-db2 in A,** then turned testing off. The dialog read "Are
  you sure you want to disable testing? This will restore the previous module
  states." with [Cancel] [Disable Testing].
- **Result:** acme-db1's three marks came back **on acme-db1**, acme-db2 was
  untouched, and the stash was cleared. This is the fix working.
- **Not a bug, not checked further:** while testing was on and acme-db2 was
  selected, the Modules view showed acme-db2's own marks under "Module
  management disabled". Only the database that was selected when testing was
  enabled gets stashed. I did not check whether a testing launch passes
  acme-db2's marks.

### 9. Export and import: matched, preview wording misleading

1. **Export.** The notification read "Exported 2 project(s) to
   /tmp/odt-brief/export1.json.", with [Reveal]. The file is
   `{ schemaVersion, exportedAt, data }`, has no `activeVersion`, and every
   project and database flag is `false`. The only `isSelected: true` are
   repository flags, as in item 2. Every path is absolute.
2. **Re-importing the same export.** The dialog read, verbatim:

   > Import export1.json into shared store /tmp/odt-brief/shared.db?
   >
   > Merging adds:
   >   2 existing projects completed with what is missing
   >   2 versions matched to one already there, by branch
   >
   > Merge never overwrites what is here. Replace discards it.
   >
   > [Replace…] [Cancel] [Merge]

   After **Merge**, every `rev` and document was byte-identical. The toast
   read "Imported export1.json: 2 existing projects completed with what is …".
   So nothing changed, but the preview did **not** say "nothing is missing"
   (finding 3).
3. **Importing the raw seed file** (`odoo-debugger-data.json`, copied into
   A's `.vscode/` so its relative paths resolve the same way): the same
   preview, and a Merge that changed nothing and left no duplicate versions.
   The seed reuses the store's version ids, so this did not really exercise
   matching by branch. I added a check: a file with **different** version ids
   (`other-17-aaaa`, `other-19-bbbb`) and a new project `gamma`. The preview
   read "1 new project / 1 database added / 2 versions matched to one already
   there, by branch". After Merge, the store still held two versions, and
   gamma's database pointed at `ver-19-0002`. **The remap works.**
4. **Replace.** I exported again, then imported a one-project file and chose
   **Replace…**. The second confirmation read:

   > Replace everything in shared store /tmp/odt-brief/shared.db with small.json? Every project, version and database record there now is discarded. Export first if you might want it back.
   >
   > [Cancel] [Replace Everything]

   I chose Cancel, and the store stayed byte-identical.

**Does the preview say what will happen?** For a merge that adds something,
yes. For a no-op merge, no: it claims projects will be "completed". It never
says what Replace would discard (finding 6).

### 10. Back to the workspace's own file: matched

- **The command:** in B, Choose Data Store, then **This workspace only**.
- **B** showed its own empty data, with a new "Default Version 17.0 :8017 •
  not provisioned", and the toasts "Creating odoo-debugger-data.json file…"
  and "This workspace now uses its own data file.".
- **A** stayed on the shared store.
- **B's `.vscode/settings.json`:**
  `{ "odooDebugger.dataStore.path": ".vscode/odoo-debugger-data.json" }`.
- **Order changed:** I cleared the user-level `odooDebugger.dataStore.path`
  **after** items 11 and 12, not here, because item 12 needs A on the shared
  store. It is now cleared in both throwaway profiles.

### 11. Other editors: Insiders works; Cursor and VSCodium not available

- **Insiders 1.137.0** (Electron 42.10.0, Node 24.18.1) installed the `.vsix`
  and activated.
- **Opening A there first,** in a fresh profile and still in legacy mode,
  showed nothing selected and the toast "No project is selected." (finding 2).
- **Choose Data Store** then **Choose a store file…** raised the save
  dialog's "shared.db already exists. Are you sure you want to overwrite it?"
  (finding 4). After OK and **All workspaces**, the bring-along dialog offered
  "2 existing projects completed with what is missing / 2 versions matched…".
  I chose **Use What Is There**: the store was unchanged, and all three
  projects showed.
- **Live refresh across editors:** with stable 1.139.1 on A beside Insiders,
  I renamed acme-db2 to "Acme Staging" in stable. Insiders showed it within
  about 1 s.
- **Not tested:** the refusal path. Every runtime that can install the
  extension (`^1.101.0`) has `node:sqlite`. Cursor and VSCodium are not
  installed.

### 12. A store from the future: matched

- **Setup:** with every window closed, `UPDATE meta SET value = '99' WHERE
  key = 'schema_version';`, then I reopened A.
- **The data showed.** Nothing on screen said the store was read-only; only
  the log did: `WARN: [store] /tmp/odt-brief/shared.db has schema 99, newer
  than 1; opened read-only`.
- **Selecting a database** raised: "Failed to select database: The data
  store /tmp/odt-brief/shared.db was written by a newer Odoo DevTools (schema
  99); it is read-only here." The store did not change.
- **The selection changed anyway.** After A was reopened later, the database
  I had "failed" to select was the selected one (finding 7).
- **Afterwards:** reset to `1`.

## Findings

### 1. A window launches the database another window selected (serious)

**Steps:**
1. Put A and B on one shared store and the same project.
2. In A, select `acme-db1`. In B, select `acme-db2`. Both belong to 17.0.
3. In A, run **Copy Odoo Command**, or read A's `.vscode/launch.json`.

**Expected:** A launches `acme-db1`, the database A shows as selected.

**Happened:** A's status bar and Databases view say "Acme Main" (acme-db1),
but:

```
/usr/bin/python3 /tmp/odt-brief/src/odoo/odoo-bin -p 8069 --addons-path … -d acme-db2 -i acme_stock,acme_sale …
```

A's `launch.json` entry `odoo-debugger` (17.0) also has `"-d", "acme-db2"`.
That is B's database **and B's module marks**, so F5 in A would install B's
modules into B's database.

**Cause:**
- `project.selectedDbByVersion` lives in the shared store (design §1).
- `selectDatabase` writes it on every selection (`src/dbs.ts:987`).
- `resolveDbForVersion` (`src/services/dbResolution.ts`) returns that
  remembered id **before** the window's own `isSelected` database.
- So the last window to select a database for version V decides what every
  window on V launches. The callers include `debugger.ts:103` (launch.json
  sync), `debugger.ts:227` and `:555` (the launch and command paths),
  `versionCommands.ts:105` and `runningState.ts:61`.

There is nothing relevant in the output channel. It is silent.

### 2. The workspace's own file loses its selection even without opting in (moderate)

**Steps:**
1. Open a 1.3 workspace (A) in the new build, legacy mode, no store setting.
2. Open the same folder in another profile or editor (Insiders here), or on
   another machine, or after going back to an older build.

**Expected:** from the design's goals, "An existing single-workspace user
notices nothing until they opt in." The selection travels with the data file,
as it did before.

**Happened:**
- The first activation strips `isSelected`, `activeVersion` and `isActive`
  from `.vscode/odoo-debugger-data.json` and keeps them only in that
  profile's `workspaceState`.
- The second profile opens A with nothing selected and the error "No project
  is selected.".
- An older build reading the file would see the same.
- It matters most to anyone who commits or syncs the data file, or who
  switches between the installed build and the F5 sandbox profile.

### 3. The import and bring-along previews announce changes when there are none (moderate, wording)

**Steps:** Export Data, then Import Data on the same file. Or Choose Data
Store onto a store that already holds this workspace's data.

**Expected:** "Merging adds nothing: it is all here already." The code has
that branch, and the brief expects it.

**Happened:** "Merging adds: 2 existing projects completed with what is
missing / 2 versions matched to one already there, by branch". The result
toast repeats it, yet the store is byte-identical afterwards. In `mergeData`
(`src/services/dataImport.ts`), `projectsMerged` goes up for every matching
project, whether or not anything was missing, and `versionsMatched` for every
matching version. `describeMerge` lists both under "Merging adds:", so it
never returns an empty list on a re-import.

### 4. Joining an existing store asks to "overwrite" it (minor, alarming wording)

**Steps:** Choose Data Store, then **Choose a store file…**, then pick a
`.db` that exists.

**Happened:** the save dialog says "shared.db already exists. Are you sure you
want to overwrite it?". Nothing is overwritten, but a user joining a
teammate's store has every reason to cancel here. Choosing a file uses
`showSaveDialog`, so that it can create one too.

### 5. Error toast on every new window without a selection (minor)

**Steps:** open a workspace with no selection yet: item 5's B, or item 11's
Insiders.

**Happened:** "No project is selected." appears as an **error**, with
[Select Project], before the user has done anything. It comes from
`SettingsStore.getSelectedProject` (`src/settingsStore.ts:339`), called
during activation. With a shared store, every new window starts like this.

### 6. The Replace flow is easy to confirm by mistake (minor)

- **The first dialog** describes only the merge. It never says how many
  projects and versions Replace would drop.
- **The destructive confirmation** has **Replace Everything** as the
  highlighted default, so Enter confirms it.

### 7. A read-only store is only announced on the first save, and the selection changes anyway (minor)

- **On open,** nothing on screen says the store is read-only; there is only a
  log WARN.
- **The first save** fails with "Failed to select database: … read-only
  here.", but the window's selection was written to `workspaceState` anyway.
  After a reopen, the "failed" database is the selected one.

### 8. Choose Data Store does not mark the store in use (minor)

- **The list:** the first, pre-selected row is always **Shared store** with
  the default path (`~/odoo-dev/odoo-devtools.db`), even when another store
  is in use. Only the placeholder names the current store. Pressing Enter
  switches to the default store.
- **The Projects view** does not show the store in use either. Design §2 says
  it would. The README does not promise it, so this is a note rather than a
  regression.

### Notes, not findings

- **The known `launch.json` issue:** in the generated project workspace it is
  written into the user's repository, and shows as untracked there.
- **An extra notification:** "Added "base" during initialization so the new
  database can install core tables." appears after each store switch and
  selection. It predates this work, as far as I can tell.
- **Matching "by branch" is matching by series (untested).** `mergeData`
  matches an incoming version to the first existing version with the same
  `odooVersion` (the series, e.g. `17.0`), not by branch. A store with two
  versions of one series, for example one made with **Clone Version**, would
  have both incoming versions mapped onto the first. I did not reproduce
  this; it comes from reading the code.
