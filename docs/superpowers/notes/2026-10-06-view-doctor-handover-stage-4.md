# View Doctor — handover after stage 4 (2026-10-06)

Read this, then the stage 3 handover (`2026-10-05-view-doctor-handover-stage-3.md`) and the stage 1 handover; where they differ, this one wins.

## 1. Where things stand

- **Branch `v-1.5`**, head after stage 4: see `git log`; stage 4 is 5125e32..dbd5ccb plus its docs commits. **Never merge, push, or offer to.** The extension never runs `git commit` for the user.
- **Spec:** `docs/superpowers/specs/2026-10-06-view-doctor-stage-4-design.md`. **Plan with its execution record (every ruling, every minor left):** `docs/superpowers/plans/2026-10-06-view-doctor-stage-4.md`.
- The user's four original requests were done in stages 1-3; stage 4 added what odoo-manager had that the extension lacked: the XPath check, finding views, "disabled only here", QWeb report rendering and PDF, the Debug toggle.

## 2. What stage 4 added

| File | What it is |
|---|---|
| `resources/scripts/xpath_check.py` | odoo-manager's checker, verbatim plus `line` (lxml sourceline = the line the start tag **ends** on) and `element` (index among the arch's elements, document order, comments/PIs not counted). |
| `resources/scripts/view_worker.py` | `check_xpaths` (baseline: the parent's `_get_combined_arch()` with the parent's chain switched **on** and the view + descendants switched **off**, all inside the request's rolled-back transaction, `lock_timeout` 5 s; never commits or signals); `report_target` (`_root`, then the top of the chain; qweb report types only; returns `report_type`); `recent_ids` takes a `domain`; `save` returns `inheriting`. xpath_check is loaded lazily from the worker's own folder (`co_filename`), without bytecode. |
| `src/services/views/xpathReport.ts` | Report types, parser, the messages. |
| `src/views/xpathDiagnostics.ts` | Places a check on the text by element index (comments/CDATA/PIs blanked first), and the `XpathDiagnostics` collection (`odoo-view-xpaths`) + quick fixes, offered only while the document holds the checked text. |
| `src/views/viewSaveHook.ts` | Everything after an arch save, including the check (`odooDebugger.views.checkXpathsOnSave`). |
| `src/views/viewTarget.ts` | A row, an `odoo-view:` URI or the active editor → `{ dbName, view }`; commands use `target()` in viewDoctorCommands.ts. |
| `src/views/viewPicker.ts`, `findViewFlow.ts` | Find View and the indented view pick. |
| `viewQueries.ts` | `viewModels`, `viewsOfModel`, `descendants`, `inactiveViewIds`. |
| `viewGroups.ts`, `viewService.ts`, `viewDoctorView.ts` | "Also off in the original" (by id) in Upgrade mode; context keys `odoo-debugger.viewDoctor.comparing` / `.showAlsoOff`. |
| `renderSession.ts`, `renderPlan.ts`, `reportPdf.ts`, `viewRenderPanel.ts` | Report sides (`kind: 'report'`), modes form/report/other, cross-model report sides unpaired, `debug=0|1`, PDF via the side's proxy session into a private per-tab folder. |
| `.vscodeignore` | Now excludes root dotfiles — this checkout's root holds `.claude/`, `.mcp.json`, `.bashrc`, … which `vsce package` used to ship. |

## 3. Traps paid for in stage 4

- **`_get_combined_arch()` skips an inactive starting view** on 15-19 (`_get_inheriting_views` filters its start ids by `active`): checking a child of an off parent needs the parent's chain switched on first.
- **lxml's `sourceline` is the line where the start tag ends**, and a minified arch has every locator on one line: map by element index.
- **Odoo's `?debug=` is sticky** (`_handle_debug` writes `session.debug`): "off" must send `debug=0`.
- **Importing a Python file writes `__pycache__`** next to it — the worker loads without bytecode and the test wrapper runs `python -B`.
- **psql prints `INSERT 0 1` after a `RETURNING` row**: wrap the insert in a CTE to read only the id. **17+ refuse a QWeb view without `key`.**
- **Render's admin session lives in the Odoo data folder of the user running VS Code.** A server started with another `--data-dir` (or as another user, in a container) never sees it and shows its login page; the README says so. Live checks with a scratch HOME must start their servers with `--data-dir=<scratch HOME>/.local/share/Odoo`.
- **A PDF must not go to a predictable name in the shared `/tmp`**: another local user can pre-create it.

## 4. How to verify (unchanged recipe, new counts)

- `npx tsc -p . --noEmit`; `npm run lint` (0 errors, 117 warnings baseline).
- Full suite outside the sandbox: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npm test` → 844 passing, 26 pending at handover. `git checkout -- dist` unless the commit ships it.
- Gated real-Odoo: build `odt_view_base_$v` (stage 1 handover §5), then `ODT_VIEW_TEST_PYTHON=… ODT_VIEW_TEST_ODOO=… ODT_VIEW_TEST_DB=odt_view_base_$v [ODT_VIEW_TEST_UPGRADE_UTIL=/home/odoo/Dev/upgrade-util/src] npx vscode-test --grep "real Odoo|upgrade"` → the worker suite is 25 tests on 17/18/19 (wkhtmltopdf at /usr/local/bin is used by the PDF test). Drop the base DBs when done.
- Live window: `.superpowers/sdd/…/live-check-brief.md` was the stage 4 recipe (now deleted with the workspace); its shape is in this plan's Task 10 Step 6 — add `--data-dir` to the hand-started servers (§3).

## 5. Open items

- **Never verified live:** anything on Windows, Odoo 15/16, saas-18.x, remote windows (PDF is local-only there by design); the user's real upgraded databases; an `account.move` invoice report (base-only test databases).
- **Possible stage 5 items:** warn about dead locators when scripting (spec rule 17); a message when the render's session is refused because the server reads sessions elsewhere (needs a careful change in the security-reviewed proxy); a startup sweep of leftover `odt-report-*` folders; the minors listed in the plan's execution record.
