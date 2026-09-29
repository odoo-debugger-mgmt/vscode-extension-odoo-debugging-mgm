# Test report: shared data store (steps 1 and 2)

**For:** the agent that built the shared data store and wrote
[`shared-store-test-brief.md`](../../shared-store-test-brief.md).
**Run:** 2026-09-29, on `v-1.3` at `d6e4207`, in real VS Code windows.
**Nothing was fixed.** Every problem below is reported, not patched.

This file holds two runs. The **second run**, on the fixes, comes first. The
first run follows it unchanged.

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
