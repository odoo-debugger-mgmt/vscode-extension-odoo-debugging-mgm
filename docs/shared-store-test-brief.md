# Test brief — shared data store (steps 1 and 2)

**For:** an agent or person who can run VS Code windows on a real machine and
see them.
**Branch:** `v-1.3`, at or after `872733d`.
**Build:** `npm ci && npm run compile`, then run an Extension Development Host
(<kbd>F5</kbd> in this repo, or `code --extensionDevelopmentPath=<repo>`). For
the Cursor/VSCodium items, `npm run build:vsix` and install the `.vsix`.
**Report to:** `docs/superpowers/notes/2026-09-29-shared-store-test-report.md`,
committed on `v-1.3` (format at the end).

This brief covers the work in the design
[`2026-09-28-shared-data-store-design.md`](superpowers/specs/2026-09-28-shared-data-store-design.md),
build order steps 1 and 2:

- per-window selection;
- the Open Project Workspace fix;
- testing mode per window, with its module stash on the database;
- the shared SQLite store;
- Choose Data Store, Export Data and Import Data.

The README section *Sharing data between workspaces* describes the intended
behaviour. Anything that behaves differently from it is a finding.

## Read this first

**None of this has run inside a real VS Code yet.** The container it was built
in cannot download VS Code. The new tests, and a three-process stress run of the
store, passed there under plain Node 22.22 with a stand-in for the `vscode`
module. That is the gap this brief exists to close: item 1 matters more than
any other.

What the unit tests already cover, so do not re-derive it by hand:

- the selection split (extract / strip / apply);
- the three-way merge rules;
- import merging and version remapping by branch;
- path absolutising;
- the stash migration;
- two and three processes committing to one `.db` without losing updates.

The rest of this brief is about what those cannot reach:

- real windows and real `workspaceState`;
- the change poller waking a real window;
- dialogs, and their wording;
- other editors' runtimes.

**How to report.** For each item, say what you did, what you saw, and whether it
matched. Quote notification and dialog text verbatim. Say plainly when you could
not test something, and why. A gap reported is worth more than a guess.

**Keep your own data out of it.** Use throwaway workspaces and a throwaway store
path, e.g. `/tmp/odt-brief/shared.db`, rather than `~/odoo-dev/odoo-devtools.db`.
If you have to use the default path, note that you did, so it can be cleaned up.
The *Shared store* option in Choose Data Store always proposes the default, so
use *Choose a store file…* instead.

## Setup

Two workspace folders:

- `A` (think "the 17.0 workspace");
- `B` (think "the 19.0 workspace").

Seed `A` with an existing-style data file, `.vscode/odoo-debugger-data.json`,
holding:

- at least two projects;
- the first project with two databases and one repository;
- a version;
- a selected project, a selected database and an `activeVersion`.

A real one from a 1.3 install is best. Otherwise write a small one by hand in
the shape the README describes, and keep a copy of the original.

A running PostgreSQL is **not** needed for most items: the data store never
talks to it. Items that start a server or read installed modules will show
database errors without one. Ignore those unless they block the item.

For driving windows headlessly, see *Driving the window on this machine* in
[`manual-test-brief.md`](manual-test-brief.md).

---

## 1 · The test suite, in a real Extension Host

```bash
npm ci
npm test
```

Report:

- the pass/fail totals;
- the full output of every failure;
- the VS Code version `@vscode/test-electron` downloaded (it prints it).

Name each failing test. For each, say whether it is one of the new suites or an
older one:

- the new suites: `Workspace selection`, `Data location`, `JSON main store`,
  `Testing stash`, `Three-way document merge`, `SQLite main store`,
  `Data import`;
- an older suite failing may be a regression from these changes, and matters
  most.

**Specifically check** that `two processes committing at once lose no update to
their own databases` ran rather than being skipped. That test forks a child
process; inside the Extension Host the child needs `ELECTRON_RUN_AS_NODE`, which
the test sets. If it fails with a spawn or module error rather than a wrong
count, say so: that is a test-harness problem, not a store problem.

## 2 · An existing workspace keeps its selection (step 1)

1. Copy the seeded data file somewhere safe.
2. Open `A` in the Extension Development Host.
3. **Expect:** the same project, database and version are selected as the file
   said.
4. Change the selected database once, so something saves, then close the
   window.
5. Diff the data file against the copy.

**Expect:**

- the file still records a selection - the one you left - because a
  workspace's own file keeps a copy for other profiles and editors;
- repository `isSelected` flags are membership in the project, not selection,
  and are unaffected either way;
- nothing else lost or changed beyond that.

Reopen `A`: the selection you left should come back. Then open `A` in a
**second profile** (`--profile-temp`): it should open with the same selection,
not with nothing selected.

## 3 · Open Project Workspace keeps the data (step 1 fix)

1. In `A`, run **Odoo DevTools: Open Project Workspace** and choose **New
   window**.
2. **Expect** in the new window: all of `A`'s projects, with the same project
   selected.
3. Check the first repository's folder on disk. **There must be no new
   `.vscode/odoo-debugger-data.json` in it**, and, once you have switched a
   database in the new window, no `.vscode/launch.json` either. The launch
   entries are in the generated `.code-workspace` file, under `launch`, and F5,
   Start Server and Restart Server all work from that window. A leftover
   `launch.json` in the repository loses our entries (and goes, if nothing
   else is in it).

   A generated workspace an earlier build opened, reopened from **Recent**,
   shows a message and a `Reopen for debugger` status bar item that stays
   until clicked; clicking it reopens the window from its file.
4. In the generated window, select a different database. Back in `A`, **expect**
   `A`'s selection unchanged. Selection is per window.

## 4 · Moving a workspace onto a shared store

1. In `A`, run **Odoo DevTools: Choose Data Store…** → **Choose a store file…**
   → `/tmp/odt-brief/shared.db` → **All workspaces**.
2. **Expect** a dialog offering to bring `A`'s data along, listing what it will
   add. Quote it. Choose **Bring It Along**.
3. **Expect:**
   - `A` still shows the same projects;
   - `A` still has the same selection;
   - a notification says the shared store is in use.
4. **Expect** `A`'s own `.vscode/odoo-debugger-data.json` still exists and is
   unchanged since step 2. It is deliberately not renamed.
5. Run Choose Data Store in `A` again and read the placeholder. It should say
   the shared store is in use. Quote it.

Also answer: did the scope question (*All workspaces* / *This workspace only*)
make sense without reading the README?

## 5 · A second window on the same store

1. Open `B` (no data file of its own) in a second Extension Development Host
   window. The user-level setting from item 4 applies there too.
2. **Expect:** `B` shows `A`'s projects. Nothing is selected yet, or only what
   you select. `B`'s selection is its own. **No** "No project is selected."
   error appears before you have done anything.
3. In `B`, select a different project, database and version from `A`'s.
   **Expect:** `A` keeps its own selection. Its views may refresh, but nothing
   changes.

## 6 · Live changes between windows

With `A` and `B` open on the shared store:

1. In `B`, create a project, or rename a database's display name.
2. **Expect** `A`'s views to show it **within a few seconds, without any action
   in `A`**.
3. Report the rough delay: the poller runs every 1.5 s, and the refresh is
   debounced 300 ms.
4. **Expect no ping-pong.** After the change settles, leave both windows idle
   for a minute. Views must not keep refreshing. In the **Odoo DevTools** output
   channel, there should be no repeating burst of log lines. A loop here is a
   serious finding.

## 7 · Simultaneous edits to one project

Both windows on the same project.

1. In `A`, select database 1 of the project. In `B`, select database 2 of the
   same project.
2. As close to simultaneously as you can, mark a module for **install** in `A`
   (database 1) and a different module for **upgrade** in `B` (database 2).
3. Wait a few seconds. **Expect** both windows to show both marks, each on its
   own database.
4. Check the **Odoo DevTools** output channel of each window for
   `[store] merged changes another window made to: project …`. It appears only
   when the two saves actually overlapped. Say whether you saw it. Its absence
   is fine if the saves did not overlap.
5. Repeat step 2 a few times. Report any case where one window's mark
   disappeared.

## 7b · Each window launches its own database

Both windows on the same project, on one shared store.

1. In `A`, select database 1. In `B`, select database 2, of the same version.
2. In `A`, run **Copy Odoo Command** and read `A`'s `.vscode/launch.json`.
3. **Expect** `-d` to be database 1 in both, and database 1's module marks -
   not `B`'s. (This was finding 1 of the first run.)
4. With an upgrade active whose sides include that version, **expect** its
   database instead, in both windows.
5. With the upgrade off, select database 1 in `A`. In **`B`**, turn the upgrade
   on, then off again. **Expect** `A`'s status bar, Databases view and
   `launch.json` to name the **same** database, whichever it is. (Finding 9 of
   the second run: they disagreed.)
6. In a window where no 19.0 database is chosen, **expect** no 19.0 entry in
   the launch file, and Start Server on 19.0 to ask for a database. Choosing
   one brings the entry back, naming it.

## 8 · Testing mode is per window, and its stash is per database

1. In `A`, turn **testing mode** on for the selected database (database 1).
2. **Expect:**
   - `A`'s Testing view shows testing enabled;
   - `A`'s module marks on database 1 are cleared;
   - `B`, on the same project, shows testing **disabled**.
3. In `A`, select database 2, then turn testing **off**.
4. **Expect:** database 1's marks come back on database 1, and database 2's
   marks are untouched.

   Before this change they were restored onto whichever database was selected,
   which would have put database 1's marks onto database 2. That is the bug this
   fixes, so say clearly what you saw.

## 9 · Export and import

1. In `A`, run **Odoo DevTools: Export Data…** and save the file.
2. Open the exported JSON. **Expect:**
   - no `isSelected: true`;
   - no `activeVersion`;
   - every repository `path` and version path is absolute.
3. Import that same file back: **Import Data…**. **Expect** the preview to say
   nothing is missing. Choose **Merge** and check nothing changes.
4. Import the original seeded data file (the raw `odoo-debugger-data.json`, not
   an export) into the shared store, choosing **Merge**. **Expect:** no
   duplicate versions. The preview says versions were matched by branch.
5. Export again to a scratch file, then choose **Replace…** with a small file.
   **Expect** a second, destructive confirmation. Cancel at it, and confirm
   nothing changed.

Quote every dialog in this item. Report whether the preview's wording tells you
what will happen before you commit to it.

## 10 · Back to the workspace's own file

1. In `B`, run Choose Data Store → **This workspace only**.
2. **Expect:** `B` now shows its own (empty or new) data. `A` stays on the shared
   store, because the user-level value still applies to it.
3. Check `B`'s `.vscode/settings.json`. It should name
   `.vscode/odoo-debugger-data.json`, because a user-level shared store is set.
   Report what it contains.
4. Finally, clear the user-level `odooDebugger.dataStore.path` from your
   **user** settings, so later testing is not affected. Note that you did.

## 11 · Other editors: Cursor, VSCodium, anything VS Code-based

For each editor available:

1. Open *Help → About* and record the **Electron** and **Node.js** versions.
2. Install the `.vsix`, set a user-level store with Choose Data Store, and open
   a workspace.
3. Report which of these happened:
   - it works, which is expected on Node 22.15 or newer. Also confirm item 6's
     live refresh works there;
   - it refuses. Expect one error naming the Node version and saying it uses the
     workspace's own file instead. Quote it. The workspace must still show its
     own data, never an empty tree;
   - the extension does not load at all. The engine is `^1.101.0`, and some
     forks report an older VS Code version. That is worth reporting too.

## 12 · A store from the future

1. With every window closed, open `/tmp/odt-brief/shared.db` in the `sqlite3`
   CLI.
2. Run `UPDATE meta SET value = '99' WHERE key = 'schema_version';`.
3. Open `A` again. **Expect:** the data still shows, with a warning on open
   that the store is read-only. Selecting a database works. Marking a module is
   refused with a **warning** naming the store, not VS Code's "Error running
   command …". Quote both.
4. Set the value back to `1` afterwards.

If `sqlite3` is not installed, skip this item and say so.

---

## Report format

Commit `docs/superpowers/notes/2026-09-29-shared-store-test-report.md` on
`v-1.3`, shaped like the spike report next to it:

1. **Verdict.** A few bullets: what works, what is broken, what could not be
   tested.
2. **Environment.**
   - OS;
   - VS Code version(s);
   - the other editors, with their Electron and Node versions;
   - whether PostgreSQL was running.
3. **One section per item above,** numbered to match. For each: what you did,
   what you saw (verbatim text), and matched / did not match / not tested, and
   why.
4. **Findings**, most serious first. For each:
   - the steps to reproduce;
   - what you expected;
   - what happened;
   - any output-channel lines. Use the **Odoo DevTools** channel and, for
     crashes, **Log (Extension Host)**.

Do not fix anything you find. Report it, so the fix can be made against the
design and pushed with a test.
