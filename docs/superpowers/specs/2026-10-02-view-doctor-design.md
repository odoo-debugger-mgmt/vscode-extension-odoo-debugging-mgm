# View Doctor: fixing disabled views side by side, inside VS Code

## Context

After an upgrade, Odoo turns off custom views whose arch no longer applies. Fixing them today means using
odoo-manager (Flask + Docker + iframes of Odoo's own UI) next to the extension. We agreed on 2026-08-27 to
bring this into the extension as a "View Doctor" once parallel versions and Upgrade mode existed. Both now
exist: Upgrade mode already pairs an original DB with an upgraded DB, each on its own version and server
port, and `runningState.ts` was written so that a split view would have a source of state.

The user asked for four things:
1. See which views are disabled.
2. Compare side by side.
3. Change the arch directly.
4. Create an upgrade script from the changes.

**Decision: build it in VS Code, with no webserver.** odoo-manager needs Flask and an iframe-proxy only
because its UI *is* a browser page. Odoo sends `X-Frame-Options: DENY` and `frame-ancestors 'self'`
(`web/controllers/home.py`), so embedding Odoo needs a header-stripping proxy and cookie workarounds.
VS Code already provides the pieces natively:

| Request | How it maps |
|---|---|
| Disabled views | A tree view |
| Side by side | The diff editor |
| Arch editing | A real XML editor, through a `FileSystemProvider` |
| Upgrade script | A generated file |

Rendering goes to the user's browser.

**What the user chose:**
- Compare the same view in the original DB and the upgraded DB, and render both DBs in the browser (the
  "view vs its parent" diff is not in scope).
- Rendering opens in the external browser.
- The script goes into a module's `migrations/` folder, chosen with a picker that also offers an untitled
  editor.
- The list has two groups: views the upgrade disabled first, then all other inactive views.

## Architecture

```
Views tree (new, odoo-devtools container) ──┐
odoo-view:// FileSystemProvider ────────────┼──> ViewService ──> psql (lists, fingerprints, identity)
Commands (compare / activate / render / script) ┘            └──> ViewWorker (persistent `odoo-bin shell`
                                                                    per DB, JSON lines over stdin/stdout)
```

### 1. Data access (`src/services/views/`)

**`viewQueries.ts`: read-only SQL through the existing `runSql`** (`src/services/postgres.ts:19`).
- Every query returns one `json_agg(...)` value, which is then `JSON.parse`d. The `|`-splitting in
  `database.ts` is not safe for XML.
- Queries are ported from odoo-manager `docker_manager.py`:
  - `list_disabled_views`, `docker_manager.py:2157`
  - the `_first_xmlid` subquery, `:2293`
  - the Discuss "Disabled views" report query, `:2737`
  - fingerprints (`md5(arch_db::text)`, `write_date`, `arch_updated`, xmlid `noupdate`), `:2764`
  - identity (xmlid, type, model, active, inherit_id, name), `:2309`
  - root walk (recursive CTE), `:2024`
  - similar-view lookup (model, type, name), `:1978`
- Inputs are validated as ints or identifiers. No string interpolation of user text.

**`disabledReport.ts`: a TS port of `migration_report.parse_disabled_views`** (odoo-manager
`migration_report.py:31-91`).
- Finds the `<h2>` that says "upgraded to Odoo X", then the "Disabled views" heading, then the `<a href>`
  view ids.
- Handles both href formats: `#…&model=ir.ui.view&id=N` and `/odoo/action-29/N`.
- Done with regex/DOM-lite parsing, so no new dependency.

**`viewWorker.ts` + `resources/scripts/view_worker.py`: one long-lived `odoo-bin shell` per DB.**
- It reads one JSON command per line on stdin and replies with a `VIEWWORKER:{json}` line.
- This avoids paying 5–10 s of shell startup on every save.
- **Commands:**

  | Command | What it does |
  |---|---|
  | `get_arch` | ORM `view.arch`, never `arch_db`, so the 16+ jsonb storage is handled |
  | `set_arch` | Write the arch, validate, commit or rollback |
  | `try_activate` | Set `active=True`, compose the root view, roll back on error |
  | `deactivate` | Set `active=False` |
  | `make_action` | Temporary `ir.actions.act_window` for rendering, reused per (model, view) |
  | `get_arches` | Batch read, used for scripts |

- **Version handling:**
  - Use `get_view` when the model has it, otherwise `fields_view_get`. The latter was removed in 17.0;
    the fix comes from the 2026-08-27 analysis.
  - After every commit, call `registry.signal_changes()` (`signal_caches_change` on old versions) so the
    *running* server drops its view cache.
- **Launch:**
  - Command line: python + odoo-bin + `shell --no-http --addons-path … -d <db>` plus the version's
    `extraParams`.
  - **Never** pass `-i`/`-u`, test flags or a port.
  - Implemented as a new `prepareArgs` mode (`src/debugger.ts:264`), e.g. `options.purpose: 'worker'`,
    which returns only the addons-path, the db and extraParams.
- **Lifecycle:**
  - Spawned with `runCommand`-style handling (`src/services/process.ts:64`).
  - The DB's version comes from `versionOfDatabase` (`src/services/versionRepos.ts:40`).
  - Idles out after about 10 min; disposed on deactivate or on DB drop.
  - Errors surface as `CommandError` text.

**`viewNotes.ts`: per-DB notes in `globalStorageUri/view-notes/<db>.json`.**
- These are machine-local, not in the shared store.
- Port of `view_note.py`:
  - Captures the upgrade-disabled set with an `arch_md5` baseline when first listed.
  - Keeps a journal of every view the extension saved or activated.
  - `unchanged_reason()` (`view_note.py:257-287`) decides between "activate only" and "replace arch".
- The file shape is normalized on read, following the plain-JSON trap from the v1.3 memory.

### 2. Disabled views tree (`src/views/viewDoctorView.ts`, contributes view `viewDoctor`)

**Which DB it shows:**
- The selected DB.
- In Upgrade mode, the **To** side's DB by default (`UpgradeConfigModel`, `src/models/upgrade.ts:38`).

**Groups:**
- **Disabled by upgrade (X)**: still disabled, then re-enabled (✓).
- **Other inactive views**: collapsed.
- **Edited here**: views the extension has written.
- Qweb views are shown only when their root is a report (the `_views_with_report_actions` logic).
  This filter runs through the worker, after the fast psql list is already on screen.

**Rows:** name · model · xmlid, with a tooltip showing the type and the inherit parent.

**Actions:**
- **Inline:** Open Arch, Compare with Original, Render in Browser.
- **Right-click:** Activate, Deactivate (with confirmation), Copy xmlid, Add to Upgrade Script, Open Parent.
- Destructive actions are on right-click only, per the working-style memory.

**Refresh:** on DB switch, and after any save or activate. A cheap 3 s `write_date` poll runs only for
views open in an editor, so edits made in Odoo's UI are picked up (like odoo-manager's `/view-meta` poll).

### 3. Arch editing (`src/views/viewFileSystem.ts`, scheme `odoo-view`)

**URI:** `odoo-view:/<db>/<viewId>/<module.name or id>.xml`.
- The `.xml` suffix gives XML highlighting.
- Read through the worker's `get_arch`.

**Save** runs `set_arch`. If the view is inactive, the same call then tries activation:
- If composition passes, the view is enabled. The tree moves it to "re-enabled" and shows a short toast.
- If composition fails, the arch stays saved, the view stays off, and Odoo's error is shown as a
  diagnostic on the document. The line is parsed from the message when present.
- Odoo rejecting the arch itself fails the save, and the buffer stays dirty.

**Permissions:**
- Views in the Upgrade mode **From** DB open read-only (`FileStat.permissions = Readonly`; the engine is
  ^1.101).
- A setting `odooDebugger.views.allowEditOriginal` (default false) lifts this.

### 4. Side by side

**Compare with Original** runs `vscode.diff(fromUri, toUri, "<name>: <fromDb> ↔ <toDb>")`.
- Left is the original DB and is read-only. Right is the upgraded DB and is editable, so it is the
  fix-in-place surface.
- **Matching the view in the other DB**, in this order:
  1. same xmlid
  2. same id with the same model and type
  3. similar-view lookup
  4. a QuickPick of candidates
- **Outside Upgrade mode:** pick the other DB from a QuickPick of the project's DBs, defaulting to a
  running one (`getRunningInstances`, `src/services/runningState.ts`).

**Render Both in Browser** opens the root view on each side's server through `make_action`.
- URLs: `/web?debug=1#action=<id>` (or `/odoo/action-<id>` on 17.2+).
- The port comes from `resolvePortForDatabase` / `openServerInBrowser` (`src/services/server.ts:130-170`),
  which already warns when nothing answers. In that case it offers "Start Both Servers"
  (`odoo.startBothServers`).
- **Cookie collision:** both servers are on localhost, so session cookies collide across ports. The
  original side opens on `127.0.0.1` and the upgraded side on `localhost`, so both stay logged in.

### 5. Upgrade script (`src/services/views/upgradeScript.ts`, pure)

**Ported from odoo-manager `upgrade_script.py`:**
- `render_replace_script`, lines 167–185 (edited arch).
- The activate-only variant, lines 131–147.
- `render_instance_script`, lines 265–354: `VIEWS` / `ACTIVATE` lists, one `edit_view` loop with
  `skip_if_not_noupdate=False, active=True`, and the view-id fallback with a "this DB only" note.
- The invariants in odoo-manager `CLAUDE.md:135-203` are kept as code comments and tests.

**Commands:**
- **Create Upgrade Script** (tree title): covers every re-enabled or edited view from the note.
- **Add to Upgrade Script** (row): a single view.
- After generating, it reports the views left out: still disabled, deleted, no arch.

**Where it goes** (QuickPick, remembered per project in workspaceState):
1. **A module's migrations folder.**
   - Candidates are the modules in the DB's version repos (`resolveReposForDatabase` +
     `collectModuleDiscovery`). The view's owning module comes first when it lives in a custom repo.
   - Then an InputBox for the version folder, prefilled with the manifest version bumped one patch
     (`readModuleManifest`, `src/services/manifest.ts:74`). It offers to bump `__manifest__.py` to match,
     since Odoo only runs `migrations/<v>/` when the installed version is lower.
   - Writes `migrations/<v>/end-update_views.py`. `end-` makes it run after every module has loaded;
     Odoo supports pre/post/end (`odoo/modules/migration.py:149`).
   - If the file exists, the new entries are merged into its `VIEWS`/`ACTIVATE` lists rather than the
     file being overwritten. If parsing fails, it falls back to a numbered sibling file.
2. **Untitled editor:** the same content as an unsaved python document.

The script imports `from odoo.upgrade import util`. A header comment notes that upgrade-util must be on
the path.

## Phasing (one spec, three plan stages, each shippable)

1. **Worker + tree + edit/activate:** requests 1 and 3.
2. **Compare with Original + Render Both:** request 2.
3. **Notes/journal + script generation + migrations picker:** request 4.

## Files

**New:**
- `src/services/views/{viewQueries,disabledReport,viewWorker,viewNotes,upgradeScript,viewMatch}.ts`
- `resources/scripts/view_worker.py`
- `src/views/viewDoctorView.ts`
- `src/views/viewFileSystem.ts`
- `src/commands/viewDoctorCommands.ts`, registered in `src/commands/index.ts`

**Modified:**
- `src/debugger.ts`: the worker mode in `prepareArgs`.
- `src/extension.ts`: register the tree and the FS provider.
- `package.json`: view, commands, menus, setting, viewsWelcome ("Select a database").
- `CHANGELOG.md`, `README.md`.

**Reused:**
- `runSql`, `quotePgIdentifier` (`postgres.ts`)
- `runCommand` / `CommandError` (`process.ts`)
- `registerCommand` (`commands/registerCommand.ts`)
- `BaseTreeProvider` (`views/baseTreeProvider.ts`)
- `versionOfDatabase` / `resolveReposForDatabase` (`versionRepos.ts`)
- `getRunningInstances` (`runningState.ts`)
- `openServerInBrowser` / port resolution (`server.ts`)
- `readUpgradeConfig` (`upgrade.ts:38`)
- `readModuleManifest` (`manifest.ts`)

## Branch and process

- Work on a new branch `v-1.5`, cut from `v-1.4`, so the 1.4.0 beta stays clean.
- After approval, this design is saved as `docs/superpowers/specs/2026-10-02-view-doctor-design.md` and
  committed. The writing-plans skill then produces the stage-1 implementation plan.

## Verification

**Unit tests (mocha, `src/test/`):**
- `disabledReport` parsing, with real report HTML from ≤17.0 and from 17.2+.
- `upgradeScript` rendering: the xmlid, view_id, unchanged/activate and merge-into-existing cases. Port
  odoo-manager `tests/test_upgrade_script.py` and `test_view_note*.py`.
- `viewMatch` ordering.
- `unchanged_reason`.
- `prepareArgs` worker mode never emits `-i`, `-u`, `--test-enable` or `-p`.

**Worker integration test, run against a local DB (skipped when psql is unavailable):**
- Get the arch, set an invalid arch, and check it rolls back.
- Try to activate a broken view, and check it rolls back and reports the error.

**Manual, per the Xvfb recipe in memory:**
1. Use an Upgrade mode pair with a 17 → 18 DB that has upgrade-disabled views.
2. The tree lists them.
3. Compare with Original opens the diff.
4. Fix the right side and save: the view is enabled, and the running 18 server shows it after a refresh
   with no restart.
5. Render Both opens two logged-in tabs.
6. Create Upgrade Script → module → version writes `migrations/18.0.x/end-update_views.py`.
7. Restore the original DB, re-run the upgrade with the module, and confirm the script re-applies the fix.

**Also:** `npm run lint`, `tsc` and `npm test` all pass.
