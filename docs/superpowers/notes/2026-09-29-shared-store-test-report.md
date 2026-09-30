# Test report: shared data store (steps 1 and 2)

**For:** the agent that built the shared data store and wrote
[`shared-store-test-brief.md`](../../shared-store-test-brief.md).
**Run:** 2026-09-29, on `v-1.3` at `d6e4207`, in real VS Code windows.
**Nothing was fixed.** Every problem below is reported, not patched.

This file holds fourteen runs, newest first. The earlier runs are kept unchanged.

# Fourteenth run: the thirteenth run's fixes (`d053e72`)

**Scope:** the brief's new list, in its order:
- `npm test` with the normal git config;
- items 16.1 and 16.3;
- item 17.1: the queue, Create Version in both windows, and the freeze repro;
- item 19, all six steps;
- spot checks of items 6, 14, 15.1 and 17.3.

Everything on the list was reached.

**Setup:**
- **The build:** `d053e72`, packaged and installed in a new throwaway profile
  (`HOME=/tmp/claude/bt`) that had never answered the version question.
- **The store:** `shared14.db`, put back to its state before the thirteenth
  run (acme-db1 → `staging`, acme-db2 → `17.0-dev`, acme-db19 → `main`, no
  upgrade, no registry).
- **The clones:** `W17/acme` on `staging`, `W19/acme` on `main`, `v17/acme`
  on `17.0-alt`, `v19/acme-19` on `19.0-alt`.
- **For 17.1 and 19.1:** the thirteenth run's throwaway git source, rebuilt
  empty (`/tmp/odt-brief/odoo-src`, branches `4.0`–`18.0`, `saas-18.1` and
  `saas-18.2`), and the wheel server that waits 30 s. The profile's
  `odooDebugger.sourceRepo.odoo` pointed at it for the whole run.
- **The store afterwards:** it holds 17 versions (the throwaway builds) and
  no acme-db1. The baseline copy is still
  `/tmp/claude/shared14-before-run13.db`.

## Verdict (fourteenth run)

- **Findings 18 to 23 are fixed**, as far as each could be tested here.
- **Matched:** the test suite, 16.1, 16.3, 17.1 (all three parts), 19.1,
  19.3, 19.4, 19.5, 19.6, and the four spot checks.
- **19.2 matched in part.** The store is protected: no "Default Version" was
  written, and the documents were byte-identical afterwards. But:
  - a window **opened** on an unreadable store does not activate at all
    (finding 24, moderate), so the "any save warns" half could not be tried
    there;
  - in a window that was **already open**, the save is refused with the
    expected warning.
- **Two low findings:**
  - **25:** the upgrade's branch pickers still mark the Custom Addons
    clone's branch as "current branch";
  - **26:** the "took over" log line only appears when the stalled window
    wakes while the other is still building. The brief's steps, as written,
    do not produce it.

## Test suite: matched

- VS Code 1.139.1, with the normal `~/.gitconfig` (its `init.templateDir` is
  still the unresolved `../../.git-templates`): **524 passing, 0 failing**.

## Spot check 14 and 15.1: matched

- **`W19/acme`,** asked on open: "Use Odoo 19.0 in this workspace? (acme here
  is on main, which acme-db19 runs.)", with "Which version here?" in the
  status bar.
- **`W17/acme`,** asked on open: "Use Odoo 17.0 in this workspace? (acme here
  is on staging, which acme-db1 runs.)".
- **Answering:** both toasts hid before my click, as in earlier runs. I
  answered through the status bar item, which lists the proposal first.
- **The registry:**
  - one row for `W19/acme` (`ver-19-0002`);
  - one row for `W17/acme`, with an empty `version_id` before it was bound
    and `ver-17-0001` after.

## 16.1 Set Up an Upgrade in `W17`: matched

- **The branch pickers** now offer both branches:
  - for 17.0: `17.0-alt` (marked "current branch"), `17.0-dev`, `19.0-alt`,
    `19.0-dev`, `base`, `main`, `origin`, `staging`;
  - for 19.0: the same without `staging`, with `19.0-alt` marked "current
    branch".
  - I picked `staging` and `main` from the lists. The "current branch" marks
    are the Custom Addons clones' branches (finding 25).
- **The confirmation,** quoted:

  > Databases     acme-db2 (Odoo 17.0) → acme-db19 (Odoo 19.0)
  > Versions      Odoo 17.0 (exists), Odoo 19.0 (exists)
  > Branches
  >     acme: staging → Odoo 17.0, main → Odoo 19.0
  >
  > Each version already has its own checkout of these, so no copies are
  > made:
  >     acme: /tmp/odt-brief/W17/acme (Odoo 17.0), /tmp/odt-brief/W19/acme
  > (Odoo 19.0)

  It has Cancel and Set It Up, and names no `acme@…` directory.
- **After Set It Up:**
  - "Upgrade set up: 17.0 → 19.0.", with no error;
  - no `acme@…` directories under the provisioning root;
  - `acme` still has no branch mode (single checkout);
  - `W17/acme` on `staging` and `W19/acme` on `main`;
  - `v17/acme` and `v19/acme-19` untouched.
- **Turning the upgrade off and on from `W19`:**
  - the same confirmation, with a Resume button;
  - then "Upgrade resumed: 17.0 → 19.0.", without the `staging` pathspec
    error of the thirteenth run.

## 16.3 Start This Side and Start Both Servers: matched

| From | Command | Started |
|---|---|---|
| `W17` | Start This Side | `-p 8069 -d acme-db2`, addons `W17/acme` |
| `W19` | Start This Side | `-p 8079 -d acme-db19`, addons `W19/acme` |
| `W17` | Start Both Servers | 17.0 with `W17/acme`, 19.0 with **`W19/acme`** |
| `W19` | Start Both Servers | 17.0 with **`W17/acme`**, 19.0 with `W19/acme` |

Each side now runs from its own workspace's clone, from either window.

## 17.1 One builder: matched

- **Create Version (Provision) in both windows.** 13.0 in `W19` and 12.0 in
  `W17`, confirmed 0.42 s apart.
  - **The second window:** `W17` showed "Provisioning Odoo 12.0: Waiting for
    another window to finish building…", with Cancel.
  - **The first build:** only `odoo-13.0` existed, under `W19`'s lease, until
    13.0 finished at 11:44:29.
  - **The second build:** 12.0 then took the lease (by 11:44:32) and finished
    at 11:45:05.
  - **The store:** both versions are there.
- **Cancel while waiting.** 14.0 building in `W19`, 15.0 waiting in `W17`. I
  clicked Cancel in `W17`.
  - No `odoo-15.0` or `venv-15.0` directory, and no 15.0 version.
  - 14.0 finished normally.
  - `W17` said nothing about the cancel.
- **The queue.** Set Up in both windows, confirmed 0.52 s apart: `W19` with
  18.0 + 16.0, `W17` with 15.0 + 11.0.
  - **One at a time:**
    - `W19`'s lease: 18.0, then 16.0, until 11:49:06;
    - then `W17`'s lease: 15.0, then 11.0, until 11:50:21.
    - Four worktrees appeared one after the other.
  - **All four versions** are in the store.
  - **The log line.** Neither window logged "[queue] another window is
    building versions; waiting for it" here. `W17`'s first pick now waits in
    its own progress notification, and its second pick is only queued after
    that. The line did appear in the freeze repro below, where a window tried
    to drain while the other held the lease.
- **The freeze repro, as the brief writes it.** Set Up in `W17` with 10.0 +
  9.0 + 8.0. With 9.0 building, I reloaded `W19` ("waiting" at 11:51:50) and
  froze `W17`'s host at 11:51:56.
  - **The takeover:** `W19` took the lease at 11:53:22 (86 s), built 9.0 and
    8.0, and released it at 11:54:31.
  - **The resume** at 11:54:40, **after** `W19` had finished. `W17` logged:

    > [versions] 9.0 at /tmp/claude/bt/odoo-dev/odoo-9.0 is already "Odoo
    > 9.0"; not adding another

  - **One version per series:** no second "Odoo 9.0".
  - **The expected line** "another window took over building; stopping here"
    did **not** appear, and `W17` showed "Provisioned 9.0." (finding 26).
- **The freeze repro, resumed while the other still builds.** Set Up in `W17`
  with 7.0 + 6.0 + 5.0 + 4.0, frozen during 6.0 at 11:56:55.
  - **The takeover:** `W19` took over at 11:58:20.
  - **The resume** at 11:58:26, while `W19` was rebuilding 6.0. `W17` logged:

    > [queue] another window took over building; stopping here

    and built nothing more.
  - **`W19`** built 6.0 ("already "Odoo 6.0"; not adding another"), 5.0 and
    4.0.
  - **One version per series.**
- **Not re-run:** the `kill -9` case. It was not on this run's list.

## 19 · The thirteenth run's other findings

1. **Versions created at once: matched.**
   - **The steps:** Create Version → Profile only, `saas-18.2` in `W19` and
     `saas-18.1` in `W17`, confirmed 0.37 s apart.
   - **Both are in the store,** and both windows then logged "Saved 18
     versions".
   - **After Switch Active Version** in `W17`: still 18 versions, both
     included.
2. **An unreadable store: matched in part (finding 24).**
   - **A window opened on it:**
     - **The error:** the toast "Failed to read /tmp/odt-brief/shared14.db:
       SyntaxError: Unexpected non-whitespace character after JSON at position
       3 (line 1 column 4)", cut off in the toast after "Unexpect…".
     - **The store:** no "Default Version", still 17 versions.
     - **The window:** the extension did not activate. Every view says "There
       is no data provider registered that can provide view data.", and every
       command fails with VS Code's own dialog, for example "command
       'odoo.createVersion' not found". So no save could be tried in that
       window.
   - **A window already open when the document went bad:**
     - **On refresh:** the same read error, and the window kept showing its
       last state.
     - **A save:** Create Version → Profile only said:

       > Failed to create version: The data store /tmp/odt-brief/shared14.db
       > could not be read, so nothing was saved to it

     - **The store:** unchanged.
   - **Afterwards:** with the document restored, the open window refreshed by
     itself with no error. The store's documents were byte-identical to the
     copy taken before the test.
3. **A binding to a deleted version: matched.**
   - **The steps:** an empty-folder window bound to the throwaway Odoo 4.0,
     then 4.0 deleted from `W19`.
   - **The notice:** "Odoo 4.0" was deleted in another window; this window
     now runs Odoo 17.0.
   - **The question again:** "Which version does this workspace run? It is
     asked once; the store has several.", with "Which version here?" back in
     the status bar.
   - **The stored state:** the binding is `{asked: false}`, and the registry
     row's `version_id` is empty.
4. **Switch Active Version in a bound window: matched.** In `W17`, switching
   to 19.0 asked:

   > This workspace runs Odoo 17.0. Switching makes this window run Odoo
   > 19.0.

   with Run Odoo 19.0 Here From Now On, Cancel and Switch for Now.
   - **Cancel** kept 17.0.
   - **Switch for Now** moved to 19.0, with the binding still 17.0.
   - **Not asked again** when:
     - switching to 19.0 while already on it;
     - selecting acme-db19 while on 19.0;
     - re-selecting acme-db19.
   - **Going back:** selecting acme-db2 returned to 17.0 without a question.
5. **Start Server → Select Database: matched.**
   - **The steps:** in the empty-folder window, with acme selected and no
     17.0 database, Start Server said "No database is selected for "Odoo
     17.0".". Select Database listed acme-db1 and acme-db2.
   - **The result:** picking acme-db1 started the server at once
     (`-p 8069 -d acme-db1`), with no second Start Server.
   - **The clone:** its addons path was `W17/acme`. An unbound window now
     finds 17.0's code through the registry too.
6. **Stop Both Servers: matched.**
   - After Start Both Servers, from either window: "Stopped Odoo 17.0 and
     Odoo 19.0.", and both ports were free.
   - With one side running, it said "Stopped Odoo 17.0." (or 19.0).

## Spot checks 6 and 17.3: matched

- **Item 6:** with three windows open, 75 s of idle: no log line in any
  window, and the sum of the documents' revisions did not move.
- **17.3, a database:** with acme-db1 selected in the empty-folder window, I
  deleted it from `W19` (no PostgreSQL database behind it, checked first).
  That window said, once: "acme-db1" was deleted in another window, so no
  database is selected here. `W17`, on acme-db2, said nothing.
- **17.3, a version:** covered by 19.3.

## Also seen (fourteenth run)

- **Resuming an upgrade now asks each time.** With own checkouts, turning the
  upgrade back on opens the plan with a Resume button. That is consistent with
  16.1, but it is one more click than before.
- **Cancelling a waiting build is silent.** There is no message after Cancel.
- **The read error is cryptic.** "SyntaxError: Unexpected non-whitespace
  character after JSON at position 3" does not say which document is bad, and
  the toast cuts it off.
- **Fixture noise:** the stub Odoo source for 17.0 and 19.0 is still not a
  git repository, so each switch to them warns about it.

## Findings (fourteenth run)

### 24. A window opened on an unreadable store does not activate (moderate)

**Steps:**
1. With every window closed, make one version document unreadable:
   `update documents set doc = CAST(doc AS BLOB) where key='ver-17-0001'`.
2. Open `W17/acme`.

**Expected** (brief 19.2): the read error, no "Default Version", and a
warning on any save.

**Happened:**
- **The read error and the protected store:** as expected.
- **Activation failed.** The extension host log:

  ```
  Activating extension AhmadMansour.odoo-devtools-vscode failed due to an error:
      at g.saveWithoutComments
      at v.saveVersions
      at async v.validateAndRepairVersions
      at async v.initialize
      at async t.activate
  ```

  The Odoo DevTools log just before it:

  ```
  ERROR: Failed to load versions: StoreUnreadableError: The data store … could not be read, so nothing was saved to it
  INFO: [identity] Default Version:  -> odoo:17.0 (ports 8017/5017)
  DEBUG: Version data repaired, saving...
  ERROR: Failed to save versions: StoreUnreadableError: …
  ```

- **The window is left without the extension:**
  - the views say "There is no data provider registered that can provide
    view data.";
  - every command gives "command 'odoo.…' not found";
  - that includes Choose Data Store…, the one command that could move the
    window off the bad store.

**Why:** the new `StoreUnreadableError` from `saveVersions`, reached through
`validateAndRepairVersions` during `initialize`, is not caught on the
activation path. The refusal to save is right; letting it end activation is
what leaves the window empty.

**Not a data problem:** nothing was written, and an already-open window
handles the same condition well (19.2).

### 25. The upgrade's branch pickers mark the Custom Addons clone's branch as current (low)

- **Seen in 16.1:**
  - the 17.0 picker marks `17.0-alt` "current branch". That is `v17/acme`'s
    branch, while `W17/acme`, the clone the plan names for 17.0, is on
    `staging`;
  - the 19.0 picker marks `19.0-alt` (`v19/acme-19`), while `W19/acme` is on
    `main`.
- **The lists themselves** now include `staging` and `main`.
- **The effect:** the default row is the wrong branch, so accepting the
  default would plan a checkout of `17.0-alt` in `W17/acme`.

### 26. The "took over" line needs the other window to still be building (low)

- **The brief's steps:** freeze the builder, let the other window take over
  **and finish**, then resume.
- **What that gives:** the resumed window's `lease.held()` finds no lease file
  and takes the lease back (`src/services/provisionLease.ts:158`). So it
  logs nothing about a takeover, and shows "Provisioned 9.0." for the build it
  had in flight.
- **No harm came of it:** the version was not duplicated, and there was
  nothing left to build.
- **When the line does appear:** resumed while the other window was still
  building, it said "another window took over building; stopping here", as
  expected.
- **Either** the brief should say "resume it while the other is still
  building", **or** the resumed window should notice the takeover from the
  lease having changed hands, not only from who holds it now.
- **One more thing:** in both repros the interrupted series was built twice
  into the same directory, once by each window, overlapping by a few
  seconds in the second repro. Only the version is de-duplicated.

# Thirteenth run: the final-run list (`0aba4da`)

**Scope:** the brief's "final run" list, in its order:
- `npm test`;
- item 14 again (asked on open, the Repos view, the status bar question);
- items 15, 16, 17 and 18;
- spot checks of items 6, 7b step 5 and 13.1–13.3.

Everything on the list was reached.

**Setup:**
- **The build:** `0aba4da`, packaged and installed in a new throwaway profile
  (`HOME=/tmp/claude/bs`) that had never answered the version question.
- **The store:** item 14's `shared14.db` (backed up first), with `W17/acme`
  on `staging`, `W19/acme` on `main`, A pinned to its own file, and item 13's
  `v17`/`v19` as Custom Addons.
- **Fixture changes, all under `/tmp`:**
  - The stub `odoo-bin` now also listens on its `-p` port, so item 17.2's port
    probe has something to find.
  - For 17.1, a git source repository `/tmp/odt-brief/odoo-src` with branches
    `6.0`–`18.0`. Its `requirements.txt` pulls one wheel from a local server
    that waits 30 s, so each build lasts about 40 s and can be watched and
    killed. `odooDebugger.sourceRepo.odoo` pointed at it only for 17.1.
  - For the 13.x spot check, acme-db2 and acme-db19 were remapped to
    `17.0-dev` and `19.0-dev` (item 14 had moved them to `staging`/`main`,
    which the item 13 clones do not have). I did this in the store with every
    window closed. My first attempt stored the document as a BLOB, which
    caused one side effect, reported under "Also seen".
- **The store afterwards:** `shared14.db` no longer has acme-db1 (deleted in
  17.3), and its databases carry the 13.x mapping. The copy from before this
  run is `/tmp/claude/shared14-before-run13.db`.

## Verdict (thirteenth run)

- **Both twelfth-run findings are fixed.** Windows are asked on open (16), and
  the Repos view shows the bound workspace's clone (17).
- **Matched:**
  - 14 and 18.3: the question on open, and the status bar question;
  - 15: the registry, "Also runs in", Open the Workspace, pruning, A's
    message, and no ping-pong;
  - 17.1's queue path: one builder, the lease, and takeover after a freeze;
  - 17.2, 17.3 and 17.4;
  - 18.1 and 18.2;
  - 16.2, 16.4, 16.5 and 16.6;
  - the spot checks: item 6, 7b step 5, and 13.1–13.3.
- **Finding 18 (serious):** when two windows create a version at nearly the
  same moment, one version is lost. It happened three times out of three
  (13.0, 15.0 and 6.0), with no merge line in the log.
- **Finding 19 (moderate):** a window sees the other side of an upgrade in
  the Custom Addons clone, not in the other workspace's clone. So item 16.1
  and 16.3 do not match:
  - the plan pairs `W17/acme` with `v19/acme-19`, and its checkout of `main`
    there fails;
  - Start Both Servers runs the other side from the wrong clone;
  - the confirmation the brief quotes never appears, because the dialog only
    opens when something is created.
- **Finding 20 (moderate):** a lease holder that stalls without dying keeps
  building after another window took over. The result was a duplicate
  "Odoo 9.0" version.
- **Low:**
  - **21:** Create Version builds outside the queue, so the one-builder guard
    does not cover it;
  - **22:** a binding to a deleted version stays;
  - **23:** one test assumes `git init` makes `.git/info/`.

## Test suite: matched, with one environment failure

- VS Code 1.139.1: **511 passing, 1 failing**.
  - The failure is "Keeping launch.json out of a clone's git status —
    against real git…": `ENOENT … /team/.git/info/exclude`.
  - This machine's `~/.gitconfig` sets `init.templateDir` to a relative path
    that does not resolve, so `git init` creates no `.git/info/`. The test
    then reads `info/exclude` in the tracked-repository case, where the code
    rightly writes nothing (finding 23).
- With `GIT_CONFIG_GLOBAL=/dev/null`: **512 passing, 0 failing**.

## 14 again: matched

- **Asked on open** in `W19/acme`, with no setting toggled:

  > Use Odoo 19.0 in this workspace? (acme here is on main, which acme-db19
  > runs.)

  It came with Use It, Choose Another… and Not Now, and "Which version here?"
  showed in the status bar.
- **Use It:**
  - "This workspace runs Odoo 19.0.";
  - the tooltip reads "Bound to this workspace";
  - the status bar question went away.
- **The Repos view** (finding 17 fixed): it lists `acme main`, marked, and
  its tooltip reads "acme (in project) / Path: /tmp/odt-brief/W19/acme /
  Branch: main". There is no `acme-19` row. The 19.0 entry uses `W19/acme`.
- **`W17/acme`:**
  - asked on open: "Use Odoo 17.0 in this workspace? (acme here is on
    staging, which acme-db1 runs.)";
  - Not Now stored `asked: true` and removed the status bar question;
  - after Reload Window, there was no question;
  - Bind This Workspace to a Version… listed 17.0 first with "acme here is
    on staging, which acme-db1 runs";
  - after choosing 17.0: 17.0 active, the entry uses `W17/acme`, and Repos
    shows `acme staging` at `W17/acme`. `W19` kept 19.0.
- **A, on its own file:** no question and no status bar item.
- **The empty folder:** "Which version does this workspace run? It is asked
  once; the store has several." (see 18.3).
- **Toasts:** as before, they hide after a few seconds. Twice I answered from
  the notification center.

## 15 · Workspaces find each other: matched

1. **Rows:** after opening both, `SELECT … FROM workspaces` gave one row each
   for `W19/acme` (`ver-19-0002`) and `W17/acme` (`ver-17-0001`), and none
   for A. Rebinding `W17` to 19.0 and back moved its `version_id` to
   `ver-19-0002` and back to `ver-17-0001`.
2. **Hover:** in `W17`, hovering Odoo 19.0 shows "Also runs in: acme (Open
   the Workspace for a Version…)". Both workspaces are named `acme`, so the
   name alone does not tell them apart. The path would.
3. **Open the Workspace for a Version…:**
   - from the right-click menu on 19.0, it raised `W19`'s existing window,
     with no new window;
   - from the palette, it lists "acme  Odoo 19.0 / /tmp/odt-brief/W19/acme"
     under "Which workspace?".
4. **Pruning:** I quit, renamed `W17` to `W17.moved` and reopened `W19`. Only
   the `W19` row was left. Then I put `W17` back.
5. **In A:** "Only a shared data store keeps a list of the workspaces that use
   it. Choose one with Choose Data Store…."
6. **Refresh:**
   - with `W19` open, opening `W17` refreshed `W19` once, 1.3 s after `W17`
     activated;
   - over 110 s of idle afterwards, neither window logged a line;
   - the documents' revisions did not move.

## 16 · An upgrade across two workspaces: partly matched (finding 19)

1. **Set Up an Upgrade in `W17`,** acme-db2 → acme-db19:
   - **The branch pickers** read the wrong clones:
     - the 17.0 side listed `v17/acme`'s branches ("17.0-alt current
       branch", no `staging`);
     - the 19.0 side listed `v19/acme-19`'s ("19.0-alt current branch").
     - I entered `staging` and `main` by hand.
   - **No confirmation was shown.** The flow went straight to:

     > Upgrade set up: 17.0 → 19.0. acme: error: pathspec 'main' did not
     > match any file(s) known to git.

   - **Afterwards:**
     - no `acme@…` directories;
     - `acme` still in single-checkout mode;
     - `W17/acme` on `staging`, `W19/acme` on `main`;
     - `v19/acme-19` unchanged on `19.0-alt`: it has no `main`, which is where
       the checkout failed.
   - **Not matched** (finding 19).
2. **The Upgrade view:** `W17` lists Start This Side (Odoo 17.0) and Open the
   Other Side (Odoo 19.0), and `W19` the reverse. **Matched.**
3. **Start This Side and Start Both Servers:**
   - **Start This Side:**
     - from `W19`: `-p 8079 -d acme-db19`, addons `W19/acme`;
     - from `W17`: `-p 8069 -d acme-db2`, addons `W17/acme`.
     - **Matched.**
   - **Start Both Servers** starts both from either window, but the other
     side runs from the Custom Addons clone:
     - from `W17`: 19.0 with `v19/acme-19`;
     - from `W19`: 17.0 with `v17/acme`, which is on `17.0-alt`, not
       `staging`.
     - **Not matched** (finding 19).
4. **Open the Other Side** in `W17` raised `W19`'s window, with no new
   window. **Matched.**
5. **The single-clone layout:** in a window bound to neither side, I pointed
   19.0's Custom Addons at `v17`. I had to exit upgrade mode first; Custom
   Addons said '"Custom Addons" cannot be changed on a version in this upgrade
   while an upgrade is set up.'. The same setup then proposed, **as before**:

   > acme will keep one copy per branch. These directories will be created,
   > and this is where you will edit that branch's code:
   >     /tmp/claude/bs/odoo-dev/acme@staging
   >     /tmp/claude/bs/odoo-dev/acme@main

   I cancelled and restored `v19`. **Matched.**
6. **A window running neither side** (the empty folder, bound to a throwaway
   8.0):
   - Start This Side said "This window runs neither side of the 17.0 → 19.0
     upgrade. Start Both Servers starts them from here." with Start Both
     Servers;
   - Open the Other Side asked "Which side?" with Odoo 17.0 (upgrading from)
     and Odoo 19.0 (upgrading to).
   - **Matched.**

## 17 · Guards between windows

### 17.1 One builder: matched on the queue path; Create Version is not covered

- **As written: Create Version in both windows.** I created 12.0 in `W17` and
  13.0 in `W19`, confirmed 1 s apart.
  - **Both built at once.** Both worktrees appeared in the same second, both
    wheel downloads started at 14:21:47, and both finished at 10:22:19.
  - **No lease file** at any point, and no "[queue]" line.
  - Create Version builds in the foreground, not through the queue (finding
    21).
  - The same moment lost 13.0 (finding 18).
- **The queue:**
  - **Setup:** Set Up in both windows, which builds the first pick in the
    foreground and queues the rest. `W17` picked 15.0 + 14.0, `W19` 18.0 +
    16.0, confirmed 0.6 s apart. The foregrounds ran side by side, and 14.0
    and 16.0 were queued.
  - **One builder:** `W17` (pid 1929695) took the lease at 10:25:39 and built
    **both** queued versions: 14.0 at 10:26:17, then 16.0 at 10:26:55, then
    "Provisioned 14.0, 16.0.".
  - **The waiting window:** `W19` logged "[queue] another window is building
    versions; waiting for it" at 10:25:38, 10:26:08 and 10:26:38.
  - **The lease file** `…/odoo-dev/.odt-provision.lease` was there from
    10:25:39 to 10:26:58, then gone.
  - **Matched.**
- **`kill -9` of the builder's extension host:**
  - **The build:** Set Up in `W17` with 13.0 + 11.0 + 10.0, so 11.0 was
    building under the lease. I reloaded `W19`, which logged "waiting" at
    10:30:56, then killed `W17`'s host at 10:31:03.
  - **The restart:** VS Code restarted that host on its own, and the new host
    took the lease itself: its process was dead, so it did not wait.
  - **The result:** it rebuilt the interrupted 11.0, then 10.0; the lease was
    gone at 10:32:16.
  - Builds resumed within 25 s, but not by the other window, which never got
    the chance.
- **The other window taking over.** To reach that path, I froze the holder
  instead (`kill -STOP`), so its process stays alive but stops sending
  heartbeats.
  - **The build:** Set Up with 15.0 + 9.0 + 8.0. With 9.0 building, I reloaded
    `W19` ("waiting" at 10:35:04) and froze `W17`'s host at 10:35:10.
  - **The takeover:** `W19` took the lease at 10:36:35 (85 s after the
    freeze, about 100 s after the last heartbeat). It built 9.0 and 8.0; the
    lease was gone at 10:37:48. **Matched**, within the brief's "about 90 s".
  - **Resuming the frozen host** at 10:39:22: it finished its own 9.0 build
    into the same directory, and saved a second "Odoo 9.0" version (finding
    20).

### 17.2 Already running elsewhere: matched

- **The first start:** `W19` started 19.0, and the stub listened on 8079.
- **Getting `W17` there:**
  - I switched `W17` to 19.0, and ran Start Server;
  - it said "No database is selected for "Odoo 19.0"." with Select Database;
  - I picked acme-db19, and got 18.1's modal, answered Switch for Now;
  - I ran Start Server again.
- **The warning** in `W17`:

  > "Odoo 19.0" is already running on port 8079, probably in another window.

  with Open in Browser, and nothing started: the stub's log gained no line.
- **Restart Server** in `W19` restarted it (new pid, still on 8079).

### 17.3 Deleted in another window: matched

- **A database:** with `W17` on acme-db1, I deleted acme-db1 from `W19`. It
  had no PostgreSQL database behind it, checked with `psql -l` first. `W17`
  said, once:

  > "acme-db1" was deleted in another window, so no database is selected
  > here.

- **A version:** with `W17` switched to the throwaway Odoo 8.0, I deleted 8.0
  from `W19` and let it delete its two folders. `W17`, and the empty-folder
  window (bound to 8.0), each said:

  > "Odoo 8.0" was deleted in another window; this window now runs Odoo 17.0.

  The empty window's binding still names the deleted version (finding 22).

### 17.4 Defaults: matched

- **On the shared store,** in `W17`, Odoo 17.0 → Version → Set as Default:

  > Setting "debuggerVersion" value saved as new default for every workspace
  > (user settings).

  The key went to the profile's user `settings.json`. `W17/acme/.vscode/` has
  only `launch.json`.
- **On A (its own file):**

  > Setting "debuggerVersion" value saved as new default for this workspace.

  The key went to `A/.vscode/settings.json`, and the user settings were
  unchanged.
- The Port row, derived from the branch, has no context menu; the Version row
  has one.

## 18 · The twelfth run's follow-ups: matched

1. **Leaving the bound version:** in `W19` (bound to 19.0), selecting
   acme-db1 showed:

   > This workspace runs Odoo 19.0. "acme-db1" belongs to Odoo 17.0, so
   > selecting it switches this window to Odoo 17.0.

   with Run Odoo 17.0 Here From Now On, Cancel and Switch for Now.
   - **Cancel:** nothing changed (still 19.0 and acme-db19).
   - **Switch for Now:** 17.0 active, with the binding still 19.0.
   - **Run Odoo 17.0 Here From Now On:**
     - the binding became 17.0, and the tooltip reads "Bound to this
       workspace";
     - the registry row followed;
     - the 17.0 entry now uses `W19/acme`, which acme-db1's branch checked
       out to `staging`. Git status stayed clean.
     - Rebinding to 19.0 and selecting acme-db19 put it back on `main`.
   - **During the upgrade:** selecting acme-db2 (the other side) in `W19`
     asked nothing.
2. **launch.json in a clone:**
   - **`W19/acme` and `W17/acme`:** after the first database switch,
     `.vscode/launch.json` exists and `git status` is clean. `.git/info/exclude`
     was created, holding "# Odoo DevTools writes its launch entries here /
     /.vscode/launch.json".
   - **`v17/acme`,** opened as a folder: the same.
   - **Not tested:** a repository that tracks its own launch.json. The unit
     test covers it, when `.git/info` exists (finding 23).
3. **The status bar question,** in a fresh empty-folder window:
   - "Which version here?" showed next to the question and was still there
     after the toast hid;
   - clicking it opened Bind This Workspace to a Version…;
   - Escape left it in place, and choosing a version removed it;
   - Not Now removed it too (in `W17`, above).

## Spot checks

- **Item 6 (no ping-pong):**
  - checked in 15.6 with `W17` and `W19`;
  - checked again at the end with the `v17/acme` window and `W19`: no log
    lines in either during 70 s of idle.
  - **Matched.**
- **7b step 5:**
  - **The steps:** acme-db1 selected in `W17`, then `W19` turned the upgrade
    on and off.
  - **The result:** `W17`'s status bar, Databases view check mark and
    launch.json all name **acme-db2**, the upgrade's source; its own pick of
    acme-db1 was replaced.
  - **Matched** ("whichever it is").
  - Turning the upgrade on from `W19` also said "Upgrade resumed: 17.0 →
    19.0. acme: error: pathspec 'staging' did not match any file(s) known to
    git." (finding 19, seen from the other side).
- **13.1–13.3,** in a window opened on `v17/acme` and left unbound:
  - **acme-db19:** checkout in `v19/acme-19` only (`19.0-dev`), `v17/acme`
    unchanged, and no Git modal;
  - **the views:** the 19.0 entry uses `v19/acme-19`, and Repos and Modules
    show that clone (`acme 19.0-dev`, `acme_nineteen`);
  - **back to acme-db2:** checkout in `v17/acme` only (`17.0-dev`); the
    window's Source Control branch in the status bar followed to `17.0-dev`,
    and the 17.0 entry uses `v17/acme`.
  - **Matched.**

## Also seen (thirteenth run)

- **Switching a bound window by version asks nothing.** Switch Active Version
  to 19.0 in `W17` (bound to 17.0) just switched. 18.1 only covers selecting
  a database.
- **The 18.1 modal can be redundant:**
  - in `W17`, already on 19.0, it still said "…so selecting it switches this
    window to Odoo 19.0.";
  - it also appears when re-selecting the database that is already selected.
- **Start Server's "Select Database" button** selected the database but did
  not continue the start. I had to run Start Server again.
- **Stop Server stops only the active version's session.** After Start Both
  Servers, the other side has to be stopped from the debug toolbar.
- **A read failure led to a write.** The BLOB document I wrote by mistake
  made the store unreadable to a new window. That window then created a
  "Default Version" (17.0) in the shared store, which every window would
  see. The cause was mine, but the path from an unreadable store to a write
  may be worth closing.
- **Fixture noise:**
  - each version switch warns "Odoo: fatal: not a git repository", because
    the stub Odoo source is not a git repository;
  - the Migrate offer appears in every new window.

## Findings (thirteenth run)

### 18. Two windows creating versions at the same moment lose one (serious)

**Steps:** in two windows on one shared store, run Create Version → Profile
only, confirming the two within about half a second (0.43 s here).

**Expected:** both versions in the store.

**Happened:**
- **The repro:** 6.0 (`W19`) and 7.0 (`W17`). Both windows said "Version …
  created on branch …", but only 7.0 is in the store.
- **The same with full builds, twice:**
  - 12.0 and 13.0 finished 0.1 s apart; 13.0 was lost;
  - 15.0 and 18.0 finished 0.15 s apart; 15.0 was lost.
  - Their worktrees and venvs stay on disk with no version pointing at them.
- **No "[store] merged changes…" line.** Each window logged "Saved N
  versions" with only its own new version, then saved again 0.5 s later.

**Why, as far as I can tell:**
- `saveVersions` (`src/versionsService.ts:133`) replaces `data.versions` with
  the window's in-memory map.
- `SqliteMainStore.commit` treats a key that is in `base` but missing from
  `next` as removed by this window, and deletes it when its revision has not
  moved.
- So a window whose store cache has already picked up the other window's
  version, but whose `VersionsService` map has not, deletes it on its next
  save.
- Any version save can do this, not only creation: switching versions saves
  them too.

### 19. A window sees the other side of an upgrade in the Custom Addons clone, not the other workspace's (moderate)

**Steps:**
- `W17/acme` (bound to 17.0, on `staging`) and `W19/acme` (bound to 19.0, on
  `main`), with Custom Addons `v17` (holding `v17/acme`) and `v19` (holding
  `v19/acme-19`), all one remote.
- In `W17`, Set Up an Upgrade acme-db2 → acme-db19, `staging` → `main`.

**Expected** (brief 16.1): a confirmation naming `W17/acme` (17.0) and
`W19/acme` (19.0), and no copies.

**Happened:**
- **The branch pickers** read `v17/acme` and `v19/acme-19`.
- **No confirmation.** It opens only when something is created
  (`createsSomething`, `src/commands/upgradeCommand.ts:745`).
- **The result message:** "Upgrade set up: 17.0 → 19.0. acme: error:
  pathspec 'main' did not match any file(s) known to git." The own-checkout
  step ran `git checkout main` in `v19/acme-19`.
- **Resuming from `W19`:** "pathspec 'staging' did not match…", from
  `v17/acme`.
- **Start Both Servers:**
  - from `W17`, 19.0 runs with `v19/acme-19`;
  - from `W19`, 17.0 runs with `v17/acme` on `17.0-alt`, not the `staging`
    code in `W17/acme`.

**Why:**
- `extraRootsFor` (`src/services/versionRepos.ts:24`) adds this window's own
  folders, and only for its own bound version.
- `ownCheckoutsFor` locates the other side through the Custom Addons folder,
  which finds the same-remote clone there.
- The registry knows `W19/acme` runs 19.0, but nothing on this path reads it.

**Separately, the brief and the code disagree on 16.1.** The confirmation the
brief quotes is never shown when nothing is created. So the user does not see
which checkouts will be switched before it happens.

### 20. A stalled lease holder keeps building after losing the lease (moderate)

**Steps:**
1. Queue two versions in `W17` (Set Up with three picks). With the second
   building under `W17`'s lease, reload `W19` so it waits.
2. `kill -STOP` `W17`'s extension host.
3. Wait for `W19` to take over (85 s here) and finish.
4. `kill -CONT` the host.

**Expected:** the old holder notices that it lost the lease and leaves the
build to the new one.

**Happened:** it finished its in-flight 9.0 into
`/tmp/claude/bs/odoo-dev/odoo-9.0`, the directory `W19` had just built, and
saved a second "Odoo 9.0" version. The store now had two.

A frozen extension host is rare: a debugger paused on it, a stopped process,
or a machine suspended part-way through a heartbeat. But the 90 s stale rule
exists for exactly that case, and `renew()` only skips the heartbeat once the
lease is lost. Nothing checks for a lost lease before creating the version.

### 21. Create Version is not covered by the one-builder guard (low)

- **The brief's item 17.1** asks for the guard to be tested with Create
  Version.
- **Create Version builds in the foreground,** outside the queue
  (`provisionAndCreateVersion` with the plan pick). It never takes the lease.
- **Two windows building 12.0 and 13.0** ran side by side, with no lease
  file.
- **Not tried:** the same branch in both windows. That would be the
  same-directory collision `f2ea375` fixed for the queue.
- Either the guard should cover this path, or the brief should say Set Up
  or Migrate.

### 22. A binding to a deleted version stays (low)

- **The setup:** the empty-folder window was bound to the throwaway Odoo 8.0.
- **After another window deleted 8.0:**
  - the window moved to 17.0, and said so;
  - its `odt.workspaceBinding` still has
    `versionId: 9aa11040-…` (the deleted version), with `asked: true`;
  - its registry row still names that id.
- **So** the window is bound to nothing that exists, and will not be asked
  again.

### 23. One test assumes `git init` creates `.git/info/` (low)

- **The test:** "against real git: untracked launch.json no longer shows; a
  tracked one is left alone" (`src/test/gitExclude.test.ts:85`) reads
  `team/.git/info/exclude` unconditionally.
- **The failure:** with a global `init.templateDir` that holds no `info/`,
  that file does not exist. The code correctly leaves it alone, and the test
  fails with ENOENT.
- **The fix:** reading a missing file as empty would make the test hold on
  any git setup.

# Twelfth run: item 14, binding a workspace to a version (`d75bd3d`)

**Scope:** as asked:
- the test suite;
- brief item 14, all six steps.

**Setup:** as item 14 describes, all under `/tmp/odt-brief`.
- **Origin:** item 13's, plus `staging` (from `17.0-dev`) and `main` (from
  `19.0-dev`).
- **Two new clones:** `W17/acme` on `staging` (`git@github.com:org/acme.git`)
  and `W19/acme` on `main` (`https://github.com/org/acme.git`).
- **A new store, `shared14.db`,** set as the user-level
  `odooDebugger.dataStore.path` of a new throwaway profile
  (`HOME=/tmp/claude/br`):
  - 17.0 and 19.0, with Custom Addons `v17` and `v19` from item 13. So the
    19.0 entry has to prefer `W19/acme` over `v19/acme-19`, which has the same
    remote;
  - `acme` points at `v17/acme`;
  - acme-db1 (17.0) → `staging`, acme-db2 → `17.0-dev`, acme-db19 (19.0) →
    `main`; no upgrade.
- **The build:** `d75bd3d`, packaged and installed, not a dev host, so that
  second windows open from the command line and can be closed and reopened.

## Verdict (twelfth run)

- **Finding 16 (serious):** no window is asked on open. The startup call to
  `offerWorkspaceBinding()` sits inside a configuration-change handler
  (`src/extension.ts:132`), so it only runs when `odooDebugger.statusBar.enabled`
  or `odooDebugger.dataStore.path` changes.
- **Everything else in item 14 matched, when triggered by hand.** I triggered
  the offer by toggling `odooDebugger.statusBar.enabled` in the user settings,
  which runs it in every open window.
- **Finding 17 (moderate):** the Repos view ignores the bound workspace's own
  clone and shows the Custom Addons clone. Launch entries and checkouts use the
  workspace's own clone.

## Test suite: matched

- VS Code 1.139.1: **482 passing, 0 failing, 0 pending**.

## 14.1 Open `W19/acme`: not matched (finding 16), wording matched

1. **On open:** there was no question in 30 s. The notification center held
   only "2 version(s) were built before provisioning and can be migrated.",
   and the log had no proposal.
2. **Triggered by hand:** after toggling `statusBar.enabled`, the question
   read, **exactly as the brief expects**:

   > Use Odoo 19.0 in this workspace? (acme here is on main, which acme-db19
   > runs.)

   It offered **Use It**, **Choose Another…** and **Not Now**.

## 14.2 Use It: matched

1. **My first click missed:** the toast had hidden itself. Nothing was
   recorded, and the question came again on the next toggle. So a dismissed
   question is asked again, as the code intends.
2. **Use It**, the second time:
   - "This workspace runs Odoo 19.0.", and the status bar showed `19.0 :8079`;
   - the version item's tooltip: "Active version: Odoo 19.0 (19.0) / Server:
     http://localhost:8079 / Not running / **Bound to this workspace** / Click
     to switch".
3. **The launch entry:** this window had no project selected, since selection
   is per window and the profile is new. I selected acme and then acme-db19.
   - `odoo-debugger-19`: `-d acme-db19`, with addons from
     **`/tmp/odt-brief/W19/acme`**, the workspace's own clone, with nothing
     configured.
   - This is although 19.0's Custom Addons holds `v19/acme-19`, a clone of the
     same remote.
4. **Checkouts use it too:** I moved `W19/acme` to `19.0-dev` by hand, then
   selected acme-db1 and acme-db19 again.
   - `main` was checked out **in `W19/acme`**, and `v19/acme-19` was not
     touched. `v19/acme-19` has no `main`, so the target is unambiguous.
   - For the unbound 17.0 side, acme-db1's checkout went to `v17/acme`, as it
     should. It failed there only because that older clone has no `staging`
     branch, which is a fixture gap.

## 14.3 Open `W17/acme`, Not Now, reload: matched, except finding 16

1. **On open:** no question (finding 16).
2. **Triggered by hand:**

   > Use Odoo 17.0 in this workspace? (acme here is on staging, which acme-db1
   > runs.)

   I chose **Not Now**. The window's state now holds
   `odt.workspaceBinding: {"asked": true}`. `W19`'s holds
   `{"versionId": "ver-19-0002", "asked": true}`.
   - `W19`'s window, already answered, was **not** asked again on that toggle.
3. **Reload:** I closed `W17`'s window and reopened it. There was no question
   on open, but that is finding 16. On a further toggle there was **still no
   question** in either window.

## 14.4 Bind This Workspace to a Version…: matched

1. **In `W17/acme`,** the list "Bind This Workspace to a Version" showed:
   - **Odoo 17.0** first, with "💡 acme here is on staging, which acme-db1
     runs";
   - then Odoo 19.0 and Create Version….
2. **Choosing 17.0:** "This workspace runs Odoo 17.0.", and 17.0 became active.
3. **The entry:** after selecting acme and acme-db1 in that window,
   `odoo-debugger` names `-d acme-db1` with addons from
   **`/tmp/odt-brief/W17/acme`**.
4. **Running it again:** 17.0 is marked "Bound to this workspace", next to the
   reason.
5. **`W19`'s window kept 19.0:** after binding `W17` to 17.0 again, `W19`'s
   status bar still read "acme · acme-db19 · 19.0 :8079".

## 14.5 An empty folder: matched, when triggered (finding 16)

In a window on `/tmp/odt-brief/empty`, the question on the toggle was:

> Which version does this workspace run? It is asked once; the store has
> several.

It offered **Choose a Version…** and **Not Now**.

## 14.6 A workspace on its own file: matched

- **The window:** A, in the same profile, but pinned to its own file by a
  workspace setting:
  `"odooDebugger.dataStore.path": ".vscode/odoo-debugger-data.json"`.
- **What it showed:** the Projects header has no "shared:" label, unlike the
  other windows ("shared: shared14.db").
- **No question** on the toggle, while the empty folder was asked on the same
  toggle.

## Also seen (twelfth run)

- **A bound window moves to another version without a word.** Selecting
  acme-db1 (17.0) in the 19.0-bound `W19` window, done by mistake, then on
  purpose, made 17.0 active there: the status bar read "17.0 :8069". The
  binding stayed 19.0, and nothing said the window was leaving its version.
  - Whether that should ask is a design call.
  - The status bar then shows 17.0 while the tooltip's binding is 19.0.
- **`launch.json` lands in the workspace's clone.** In a workspace that is the
  clone, as here, the launch entries go into `W19/acme/.vscode/launch.json`.
  Source Control then shows `main*` with an untracked `.vscode/`. It is a
  folder window, so that follows the fifth run's rule. But for the "one
  workspace per version, opened on the clone" layout this item sets up, it
  means the user's repository.
- **Most clicks need the notification center.** Like the reopen message in the
  sixth run, the question is an ordinary toast that hides itself after a few
  seconds. The code asks again after a dismissal without a choice, which
  softens it.

## Findings (twelfth run)

### 16. No window is asked on open (serious)

**Steps:** open `W19/acme`, `W17/acme` or an empty folder on the shared store,
in a profile that has never answered.

**Expected:** the question, once, on open.

**Happened:** no question. The log has no proposal.

**Why:** in `activate` (`src/extension.ts`, around line 132), the call landed
inside the `odooDebugger.statusBar.enabled` handler:

```ts
context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('odooDebugger.statusBar.enabled')) {
        void statusBar.update();
    void offerWorkspaceBinding();
    }
}));
```

The call is under-indented, which suggests it was meant to follow the
`push(...)`. It came in with `f15fbf8`, and the bundle has the same.

The only other caller is the `odooDebugger.dataStore.path` change handler. So
a window is asked only when one of those two settings changes while it is
open.

### 17. The Repos view shows the Custom Addons clone, not the bound workspace's (moderate)

**Steps:** in `W19/acme`, bound to 19.0, with acme-db19 selected.

**Happened:**
- the Repos view lists **`acme-19 19.0-alt`**, with the tooltip "Path:
  /tmp/odt-brief/v19/acme-19";
- the launch entry and the checkout use `W19/acme`, which was on `main`.

It is the same in `W17`: Repos shows `acme 17.0-alt` (`v17/acme`), while the
entry uses `W17/acme` on `staging`.

So the view names another clone, on another branch, than the one that runs.
The Modules view cannot tell the two apart here, because both clones hold the
same modules.

The workspace's folders seem to be passed as extra roots only on the launch
and checkout paths, not to the Repos view.

# Eleventh run: finding 15 re-tested (`8523354`)

**Scope:** as asked:
- the test suite;
- items 13.1–13.3 again: no Git pop-up, and the branches still change;
- `v17/acme` opened as a folder in the window, then a switch back to
  acme-db1: its branch in the Source Control view should still update.

**Setup:** the tenth run's fixture, reset.
- `v17/acme` on `17.0-dev` and `v19/acme-19` on `19.0-dev`;
- 17.0 finds addons in `v17` and 19.0 in `v19`;
- acme-db1 maps `acme` to `17.0-alt`, acme-db2 to `17.0-dev`, and acme-db19
  to `19.0-alt`;
- a new throwaway profile (`HOME=/tmp/claude/bq`), in an Extension Development
  Host.

After each switch I captured the screen every 1 or 2 seconds, for 8 to 10
seconds, and compared the area where the modal appeared in the tenth run.

## Verdict (eleventh run)

**Finding 15 is fixed.** No switch raised the Git modal, and the branches
changed as before. With the clone open in the window, Source Control follows
the switch.

## Test suite: matched

- VS Code 1.139.1: **472 passing, 0 failing, 0 pending**.

## 13.1–13.3 again, folder window A: matched

1. **acme-db1 → acme-db19:**
   - `v19/acme-19` went to `19.0-alt`, and `v17/acme` stayed on `17.0-dev`;
   - Repos showed `acme-19 19.0-alt`, and Modules listed `acme_nineteen`;
   - `odoo-debugger-19` names `v19/acme-19`, and `odoo-debugger` names
     `v17/acme`;
   - **no modal in any of five frames over 10 s**. The only toast was the
     fixture's "environment switch finished with issues".
2. **acme-db19 → acme-db1:**
   - `v17/acme` went to `17.0-alt`, and `v19/acme-19` stayed on `19.0-alt`;
   - Repos and Modules went back to the 17.0 clone;
   - **no modal**.

## With `v17/acme` open in the window: matched

1. **Adding the folder:** Workspaces: Add Folder to Workspace… with
   `/tmp/odt-brief/v17/acme`. The window became "Untitled (Workspace)", with A
   still first, so the data and the launch file stayed A's. The status bar's
   branch item showed `17.0-alt`.
2. **Switch to acme-db2**, so that the switch back has something to change:
   - `v17/acme` went to `17.0-dev`;
   - Source Control showed **`17.0-dev`** in the status bar, the commit box
     ("commit on "17…") and the Graph;
   - no modal.
3. **Switch back to acme-db1:**
   - `v17/acme` went to `17.0-alt`;
   - Source Control showed **`17.0-alt`** in the status bar and the Graph,
     already in the first frame, within 1 s;
   - no modal.

**Not seen:** whether the checkout went through the Git API or the command
line followed by the targeted refresh. The log does not say, and the result
is the same.

# Tenth run: item 13, per-version repository locations (`c6f48f5`)

**Scope:** as asked:
- the test suite;
- brief item 13, all six steps.

**Setup:** as item 13 describes, all under `/tmp/odt-brief`.
- **Origin:** a bare repository, `origin/acme.git`.
  - Its `17.0-dev` and `17.0-alt` branches add a module `acme_seventeen`.
  - Its `19.0-dev` and `19.0-alt` branches add `acme_nineteen`.
  - So the Modules view shows which clone it reads.
- **Two clones:**
  - `v17/acme` on `17.0-dev`, with `origin` set to
    `git@github.com:org/acme.git`;
  - `v19/acme-19` on `19.0-dev`, with `https://github.com/org/acme`.
- **For step 4:** a third clone `other/acme-third` (`git@github.com:org/acme`),
  a clone of another remote `other/beta-clone`
  (`git@github.com:org/beta.git`), and a plain folder `other/not-a-repo`.
- **A's data:**
  - 17.0's Custom Addons is `/tmp/odt-brief/v17`, and 19.0's is
    `/tmp/odt-brief/v19`;
  - the project's `acme` is `v17/acme`, in single-checkout mode;
  - acme-db1 (17.0) maps `acme` to `17.0-alt`, and acme-db19 (19.0) to
    `19.0-alt`;
  - acme-db1 is selected, and 17.0 is active.
- **The window:** an Extension Development Host on a new throwaway profile
  (`HOME=/tmp/claude/bp`). There is no real Odoo or PostgreSQL. The usual
  fixture warnings appear: "environment switch finished with issues" from the
  fake Odoo source, psql, and the missing Python extension.

## Verdict (tenth run)

- **All six steps matched.**
- **One new finding, 15 (moderate):** every database switch that checks out
  a clone the window does not have open raises VS Code's modal "Git: There are
  no available repositories". The per-version layout makes that the normal
  case.

## Test suite: matched

- VS Code 1.139.1: **471 passing, 0 failing, 0 pending**.

## 13.1–13.3 Database switches: matched

**Before:** the Repos view showed `acme 17.0-dev`, and Modules listed
`acme_seventeen`.

1. **Switch to acme-db19:**
   - `v19/acme-19` went to **`19.0-alt`**, and **`v17/acme` stayed on
     `17.0-dev`**;
   - Repos showed **`acme-19 19.0-alt`**, and Modules listed `acme_nineteen`
     rather than `acme_seventeen`.
2. **`launch.json`:**
   - `odoo-debugger-19`: `-d acme-db19`, with addons from
     `/tmp/odt-brief/v19/acme-19`;
   - `odoo-debugger`: `-d acme-db1`, with addons from `/tmp/odt-brief/v17/acme`.
3. **Switch back to acme-db1:**
   - `v17/acme` went to **`17.0-alt`**, and `v19/acme-19` stayed on
     `19.0-alt`;
   - Repos showed `acme 17.0-alt`, and Modules listed `acme_seventeen` again;
   - both entries were unchanged.

## 13.4 Set Repository Location for a Version…: matched

1. **Which version?** The list shows "Odoo 17.0 · Active" first, then Odoo
   19.0. I picked 19.0.
2. **"Repository location for Odoo 19.0"** listed **"acme
   /tmp/odt-brief/v19/acme-19 · found by its remote"**. That is the right
   folder, found by its remote although its name differs.
3. **Choose a Folder…:** I typed `/tmp/odt-brief/other/acme-third/`.
   - "Odoo 19.0 now uses /tmp/odt-brief/other/acme-third for "acme"."
   - `odoo-debugger-19`'s addons path became `…/other/acme-third`, and
     `odoo-debugger` stayed on `v17/acme`.
   - The 19.0 row's tooltip ends with **"acme: /tmp/odt-brief/other/acme-third
     (set by hand)"**.
   - The data holds `repoPaths: {"acme": "/tmp/odt-brief/other/acme-third"}` on
     19.0 only.
4. **Running the command again:**
   - the repository row read "acme /tmp/odt-brief/other/acme-third · set by
     hand";
   - the next step offered Choose a Folder… and **Use the Default**, with the
     placeholder "Set by hand: /tmp/odt-brief/other/acme-third".
5. **A plain folder** (`other/not-a-repo`) was refused: "/tmp/odt-brief/other/not-a-repo
   is not a git checkout, so it was not set." The setting was unchanged.
6. **A clone of another remote** (`other/beta-clone`) asked first, in a modal:

   > /tmp/odt-brief/other/beta-clone is a clone of github.com/org/beta, not of
   > github.com/org/acme like "acme". Use it for Odoo 19.0 anyway?

   It offered Cancel or Use It. Cancel left the setting unchanged.
7. **Use the Default:**
   - "Odoo 19.0 finds "acme" automatically again.";
   - `repoPaths` became `{}`;
   - `odoo-debugger-19` went back to `v19/acme-19`.

## 13.5 The single-clone layout: matched

1. **Pointing 19.0 at the one clone:** I set 19.0's Custom Addons to
   `/tmp/odt-brief/v17` from the Versions view (Custom Addons → Enter Path
   Manually). Both entries' addons paths then named `/tmp/odt-brief/v17/acme`.
2. **Switch to acme-db19:**
   - **`v17/acme` went to `19.0-alt`**, and `v19/acme-19` was not touched;
   - Repos showed `acme 19.0-alt`, and Modules listed `acme_nineteen`.

## 13.6 Save All as Default: matched

This was run on Odoo 19.0, shown as "provisioned", while its settings still
carried `managedPaths: []` and `repoPaths: {}`.
1. **Right-click → Set All as Default** asked: "Are you sure you want to save
   ALL settings from version "Odoo 19.0" as new default values?" with **Save
   All as Default** and Cancel.
2. **Save All as Default:**
   - "All settings from version "Odoo 19.0" saved as new defaults.", with no
     error;
   - `A/.vscode/settings.json` got 16 `odooDebugger.defaultVersion.*` keys, with
     **no `repoPaths` and no `managedPaths`**.

I removed that `settings.json` afterwards, so it would not leak into later
runs, and kept a copy outside the fixture.

## Findings (tenth run)

### 15. A database switch raises "Git: There are no available repositories" (moderate)

**Steps:** in folder window A, switch between acme-db1 and acme-db19. Each
switch checks out a branch in `v17/acme` or `v19/acme-19`, and the window does
not have either open.

**Happened:** on **every** switch, VS Code shows a modal error:

> Git: There are no available repositories

It offers Cancel or Open Git Log. The checkout itself succeeded.

**Why:** after a checkout through the git command line, `checkoutRepoBranch`
(`src/services/checkout.ts:191`) runs `vscode.commands.executeCommand('git.refresh')`.
With no repository open in the window, VS Code's Git extension answers with
this modal. The surrounding `try/catch` cannot stop it, because the Git
extension shows the modal itself rather than throwing.

This code dates from `8532aff` (1.2). The same folder layout would have
triggered it before this change too, though I did not run an older build to
confirm. Per-version clones sit outside the window by design, so the layout
item 13 describes now hits it on every switch.

Skipping `git.refresh` when no open repository contains the path would avoid
it, for example by checking the Git extension's API (`getRepository(uri)`)
first.

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
