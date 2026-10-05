# View Doctor — handover after stage 1 (2026-10-05)

Read this before touching the View Doctor. It covers:
- what exists;
- what stage 2 is;
- the traps already paid for;
- how to verify;
- how the maintainer wants the work run.

## 1. Where things stand

- **Repo:** `/home/odoo/Dev/vscode-extension-odoo-debugger`, branch **`v-1.5`**. It was cut from `v-1.4` at `6dc506a`; the head at handover is `4c43c96`.
  - `v-1.5` stays its own branch. **Never merge it into `v-1.4` or anything else, never push, and never offer to.**
- **Spec (the authority):** `docs/superpowers/specs/2026-10-02-view-doctor-design.md`. Read §4 for stage 2 and §5 for stage 3.
- **Stage 1 plan (done):** `docs/superpowers/plans/2026-10-02-view-doctor-stage-1.md`.
- **What the feature is:** it brings odoo-manager's view fixer (`/home/odoo/Dev/odoo-manager`) into the extension, natively. There is no webserver and no webview.

The user's four requests, and where each stands:

| # | Request | Status |
|---|---|---|
| 1 | See which views are disabled | **Done** (Views tree) |
| 2 | Side by side | **Next: stage 2** |
| 3 | Change the arch directly | **Done** (`odoo-view:` files, save through Odoo) |
| 4 | Upgrade script from the changes | Stage 3, after stage 2 |

Choices the user made, which are not up for re-litigation:
- **Side by side** means the *same view* in the original DB and the upgraded DB as a diff, plus rendering both DBs.
- **Rendering** opens in the **external browser**, not in VS Code panels.
- **The tree** lists upgrade-disabled views first, then all other inactive views.
- **The "view vs its parent" diff** is out of scope.
- **Stage 3 scripts** go into a module's `migrations/<version>/` folder via a picker, or an untitled editor. **The extension never runs `git commit`.** An auto-commit with a message template was discussed and explicitly dropped.

## 2. What stage 1 built (the pieces stage 2 plugs into)

| File | What it is |
|---|---|
| `src/services/views/viewQueries.ts` | psql-only reads, one JSON value per query. `ViewRow`, `listInactiveViews`, `getViewRows(db, ids)`, `getReportMessages`, `getWriteDates`. Ids are the only interpolated values (`sqlIdList`). |
| `src/services/views/disabledReport.ts`, `viewGroups.ts` | Parse upgrade-util's Discuss "Disabled views" report; group the tree rows. |
| `resources/scripts/view_worker.py` | Runs **inside `odoo-bin shell`**. Commands: `get_arch`, `save` (writes the arch and, if the view is off, tries to turn it on), `activate`, `deactivate`. Add new commands to `COMMANDS`. |
| `src/services/views/viewWorker.ts` | One shell process per database. The bootstrap goes on stdin; JSON lines go over a **local socket**: a Unix socket in a 0700 mkdtemp folder, or loopback TCP on Windows. Token auth through `ODT_VIEW_ADDRESS`/`ODT_VIEW_TOKEN`. |
| `src/services/views/viewWorkerPool.ts` | `run(db, cmd, args)`. Idle stop after 10 min; one retry on `restart: true`. |
| `src/services/views/viewWorkerArgs.ts` | The shell command line. It refuses `-i`/`-u`/test/port/`--dev`/`-d`/`--addons-path` from `extraParams` in every optparse spelling. |
| `src/services/views/viewWorkerSpec.ts` | Launches the shell with **the database's own version** (python, odoo-bin, addons path via `collectAddonsPaths` in `src/debugger.ts`). |
| `src/services/views/viewService.ts` | `ViewService`: `getArch`, `save`, `activate`, `deactivate`, `rows`, `writeDate`, `doctorGroups`. `ViewBackend` is the interface the file system uses. |
| `src/views/viewDoctorView.ts` | The tree. `resolveViewDoctorTarget` returns the upgrade's **To** DB while an upgrade is active, else the selected DB. `ViewItem { dbName, view }`. The contextValue is `odooView.{active\|inactive}.{hasParent\|root}[.noXmlid]`. |
| `src/views/viewFileSystem.ts` | The `odoo-view:/<db>/<id>/<label>.xml` provider. `viewUri`, `parseViewUri`, `clearViewDiagnostics`, `viewFileSize`. |
| `src/views/viewPoll.ts` | The 3 s `write_date` poll for open arch tabs, with an in-flight guard per DB. |
| `src/commands/viewDoctorCommands.ts` | Row commands, all registered through `registerCommand`. |
| `src/services/postgres.ts` | `releaseDatabase` / `onBeforeDatabaseRelease`. A drop, rename or template copy first stops our shells, including other windows' shells, by application_name. |

**Existing helpers stage 2 should reuse:**
- `src/services/server.ts`:
  - `resolvePortForDatabase(dbId, versionId)` and `openServerInBrowser`;
  - `buildServerUrl(port, db)`, which hard-codes `http://localhost`, so stage 2 needs a host parameter or its own builder;
  - `waitForPort`.
- `src/services/runningState.ts`: `getRunningInstances()`.
- `src/upgrade.ts`: `readUpgradeConfig(project)`, which gives `config.from` and `config.to` as `{ dbId, versionId?, series }`.
- The command `odoo.startBothServers`.

## 3. Stage 2: what to build (spec §4)

**1. Compare with Original** (an inline action on a tree row).
- It runs `vscode.diff(fromUri, toUri, "<name>: <fromDb> ↔ <toDb>")`. The left side is the original DB, **read-only**; the right side is the upgraded DB, editable.
- **Match the view in the other DB, in this order:**
  1. same xmlid;
  2. same id with the same model and type;
  3. same model, type and name;
  4. a QuickPick of candidates.
- Put the matching logic in a pure `viewMatch.ts` with tests. The SQL for candidates goes in `viewQueries.ts`.
- **Outside Upgrade mode:** pick the other DB with a QuickPick of the project's DBs, defaulting to a running one.

**2. Read-only original.**
- `stat()` returns `permissions: vscode.FilePermission.Readonly` for views of the Upgrade-mode **From** DB, unless the setting `odooDebugger.views.allowEditOriginal` is true (default `false`).
- The provider needs an injected `isReadOnly(dbName)` predicate. Keep the provider free of SettingsStore access, so it stays testable.

**3. Render in Browser / Render Both.**
- Add a new worker command `make_action { view_id }`. It creates or reuses an `ir.actions.act_window` for the view's **root** (stop at the first primary-mode ancestor, like `_root` in the worker), and returns `{ action_id, model, view_type }`.
  - Reuse the action per (model, view), with a recognisable name such as `[View Doctor] <model> #<view id>`, so they don't pile up.
  - Don't delete these actions.
  - odoo-manager's version is `render_view` in `odoo_manager/docker_manager.py` around lines 2477–2530.
- **URL:**
  - `/odoo/action-<id>?debug=1` on saas~17.2 and later;
  - `/web?debug=1#action=<id>` before that.
  - The series comes from the worker's ready reply (`series`) or from `detectOdooSeries`.
- **Port:** use `resolvePortForDatabase`. If nothing answers, offer "Start Both Servers".
- **Cookie collision:** both servers are on localhost, so open the **original on `127.0.0.1` and the upgraded on `localhost`**. That way both stay logged in.
- **Decisions already made for you:**
  - **Render Both opens both sides on the *same* record, so the two renders are comparable** (user requirement). The upgraded DB is a copy of the original, so the same id is the same record.
    - Add a worker command `recent_ids { model, limit }` that returns the most recent ids (`search([], limit=limit, order='id desc')`, e.g. limit 200), and run it on both DBs.
    - Pick the highest id present in both lists, and pass it to `make_action` (`{ view_id, res_id }`) on each side.
    - If no id is common to both, open a new record on both sides and say so ("No record exists in both databases; showing a new one.").
    - The comparison never falls back to different records on the two sides.
  - **A single Render in Browser** (one side) uses that side's most recent record, or a new record if there is none.
  - **List, kanban and other multi-record types** open as is. Both sides then show the same data set, which is comparable by nature.
  - **QWeb report templates are out of scope for stage 2.** Show a clear message ("Reports need a record to render; open the report from Odoo") rather than building `/report/html/...` URLs.
  - **Integration tests to add:**
    - On a copy of the DB, `recent_ids` returns the same id on both a source DB and its copy, and `make_action` with that `res_id` creates an action that points at it.
    - The "no common record" case opens a new record on both sides.

**4. Tree wiring.**
- Inline actions on rows: Open Arch (exists), Compare with Original, Render in Browser.
- Render Both goes in the context menu, and only while Upgrade mode is active.
- Destructive actions stay right-click-only behind a modal; none are added here.

**5. Docs.** Update CHANGELOG `[Unreleased]` and the README "Disabled views (View Doctor)" section. Rebuild `dist/` with `npm run compile` in the last commit.

Stage 3 (upgrade script, spec §5) is deliberately not part of this handover's scope.

## 4. Traps already paid for (don't relearn them)

- **`odoo shell` and stdin:** it `exec()`s all of stdin, and only at EOF. Never send requests on stdin.
- **Odoo cursors are REPEATABLE READ.** The worker rolls back at the start **and end** of every request. Never leave it idle in a transaction: that holds locks that hang the user's own `-u`.
- **Registry reloads.** Detect them via `registry.get_sequences(cr)[0]` on 17+, and `base_registry_signaling` on 15/16.
  - **Odoo 19 has no `base_registry_signaling`**; it uses `orm_signaling_*` tables.
  - On a mismatch the worker replies `restart: true` and exits.
- **Language.** The shell's env is OdooBot's language. The worker forces `lang='en_US'`; without that, translated text gets written as the source. Keep any new command on `ENV`.
- **Lost connections.** A dropped Postgres connection replies `restart: true`. Only connection-class errors count (SQLSTATE 08xxx and 57Pxx).
- **No `-i`/`-u` for the worker, ever,** including from `extraParams`.
- **Plain JSON from SettingsStore.** Projects come back as plain JSON. Read upgrade config only through `ensureUpgradeConfigModel` / `readUpgradeConfig`. New fields need a normalizer.
- **`getChildren(element)` must handle `element` first,** or collapsible rows recurse.
- **The FileSystemProvider stat size must change with mtime.** `viewFileSize(mtime)` does this; otherwise VS Code's "file is newer" check never fires.
- **The running-database probe** ignores the worker (`odoo-devtools-view-worker`) and the extension's own psql queries (`odoo-devtools-query`). Keep new psql calls going through `runSql`, so they carry `ownQueryEnv()`.
- **Windows.**
  - The bootstrap escapes non-ASCII, and the shell runs with `PYTHONIOENCODING=utf-8`.
  - The Windows path is **untested on a real Windows machine**. Don't claim otherwise.
- **IDE diagnostics `OWL000`** in TS files are false positives. Trust `npx tsc -p . --noEmit`.

## 5. How to verify

- **Type check and lint:** `npx tsc -p . --noEmit` and `npm run lint`. Lint must show 0 errors; the 117 warnings are pre-existing.
- **Tests run inside a real Extension Host,** and must run **outside the Bash sandbox** (`dangerouslyDisableSandbox: true`) **with `env -u ELECTRON_RUN_AS_NODE`**.
  - Full suite: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npm test`. At handover: 623 passing, 13 pending.
  - Focused: `env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "<suite name>"`. Re-run `compile-tests` after adding a test file.
  - `npm test` rebuilds `dist/`. Run `git checkout -- dist` unless the commit should include it.
- **Real-Odoo integration** (`src/test/viewWorker.integration.test.ts`) is skipped unless the env vars below are set. It works on a copy of the database and drops the copy afterwards.
  1. Build a base DB for each version:

     ```bash
     v=19; /home/odoo/odoo-dev/venv-$v.0/bin/python /home/odoo/odoo-dev/odoo-$v.0/odoo-bin \
       --addons-path=/home/odoo/odoo-dev/odoo-$v.0/odoo/addons,/home/odoo/odoo-dev/odoo-$v.0/addons \
       -d odt_view_base_$v -i base --stop-after-init --without-demo=all --log-level=warn
     ```

  2. Run the suite against it:

     ```bash
     ODT_VIEW_TEST_PYTHON=/home/odoo/odoo-dev/venv-19.0/bin/python ODT_VIEW_TEST_ODOO=/home/odoo/odoo-dev/odoo-19.0 \
       ODT_VIEW_TEST_DB=odt_view_base_19 env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View worker against a real Odoo"
     ```

  - Add `ODT_VIEW_TEST_TRANSPORT=tcp` to exercise the Windows transport.
  - Use 17.0, 18.0 and 19.0. **`venv-15.0` (no PyPDF2) and `venv-16.0` (no setuptools) cannot start Odoo.** Don't modify the user's venvs.
  - Drop your `odt_view_*` databases when done. Touch no other database.
  - A new `make_action` command deserves integration tests here, e.g. that it creates and then reuses one action, and that the returned ids/URL are valid on 17 vs 19.
- **Real window.** The recipe is in `docs/manual-test-brief.md` ("Driving the window on this machine"), plus the gotchas in the user's memory file `odoo-debugger-verification.md`:
  - Xvfb runs detached with the sandbox disabled;
  - launch `code` with `env -i` and a short scratch HOME;
  - seed `.vscode/odoo-debugger-data.json` directly.
  - The browser side of "Render" can be checked by asserting the URL handed to `vscode.env.openExternal`; a real browser isn't required.

## 6. How the maintainer wants work run

- **Process.** Brainstorm, then spec, then plan (writing-plans), then **subagent-driven development**.
  - Each task gets a fresh implementer and a task review; one final whole-branch review on the most capable model.
  - The spec already covers stage 2, so go straight to a **stage 2 plan** at `docs/superpowers/plans/<date>-view-doctor-stage-2.md`. Show the user the plan, then execute it.
- **Unattended rulings.** The user is often away and asked not to be asked for permission. Make rulings and record them (`Ruling: <decision> — <why> — <cost if wrong>`). At the end, list every ruling in the final message.
  - Stop only for something destructive, a security concern, or an external side effect such as a push or a merge.
- **Working style.** The user prefers smart defaults over prompts; destructive actions are right-click only with confirmation; any automated behaviour is toggleable by a setting.
- **Commits.** Odoo-style prefixes `[ADD]`/`[IMP]`/`[FIX]`/`[REF]`/`[DOC]`, each with a body. End with the Co-Authored-By trailer your harness gives you. Never `git add -A`: the repo root has unrelated untracked dotfiles.
- **Copy style.** Plain, short sentences, matching the existing CHANGELOG and README voice.

## 7. Open items carried over (none block stage 2)

**Never verified live** (the user will smoke-test when convenient):
- a running server showing a saved fix without a restart (only the DB-side cache signal is asserted);
- Copy External ID and Open Parent;
- anything on a real Windows machine.

**Deferred minors from the stage 1 reviews.** Fix these if you're already in the file; none is required:
- `upgradeVersions.sort()` in `viewGroups.ts` is lexicographic.
- Anchors under "Disabled views" are not checked for `model=ir.ui.view`.
- `ViewWorkerPool.dispose()` doesn't await releases, and `onDidExit` subscriptions are never disposed.
- `viewWorkerSpec` checks provisioning with `resolveOptionalPath` but spawns `normalizePath`.
- `resolveViewWorkerSpec` has no automated test.
- The registry-reload integration test depends on suite order.
- Tooltip Markdown doesn't escape view names.
- The activate error prompt delays the tree refresh until it is dismissed.
- A malformed-XML save gets VS Code's "Failed to save" toast but no line squiggle.
- New `package.json` entries use a one-line JSON style.
- There is no test that `runSql`/`runPsqlQuery` pass `ownQueryEnv()`.
- Combined short flags (`-vu`) and `--longpolling-port`/`--gevent-port` pass through to the worker. They are harmless with `--no-http`.
