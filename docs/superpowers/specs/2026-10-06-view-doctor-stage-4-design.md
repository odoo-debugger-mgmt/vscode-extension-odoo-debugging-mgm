# View Doctor stage 4: checking fixes, finding views, rendering reports

## Context

Stages 1–3 (branch `v-1.5`) built the user's four requests: the Views tree, arch editing, Compare with
Original and Render, and upgrade scripts. Compared with odoo-manager (`/home/odoo/Dev/odoo-manager`),
the extension still lacks a handful of view-fixing tools the user asked for on 2026-10-06:

| # | Feature | odoo-manager source |
|---|---|---|
| 1 | **XPath check**: does every locator of a patch still match, exactly once? | `odoo_manager/xpath_check.py`, `docker_manager.get_composed_arch`, MCP `check_view_xpaths` |
| 2 | **Render QWeb reports** (html, and PDF) | `docker_manager.find_report_for_view`, `app.render_report_route` |
| 3 | **"Disabled only in the upgraded database"** filter | `docker_manager.disabled_views_unique_to` |
| 4 | **Views inheriting a view** | `docker_manager.list_inheriting_views` |
| 5 | **Find any view** by id, external id or model | `list_view_models`, `list_views_for_model`, "Go to view ID" |
| 6 | **Open the root view**, not only the parent | `docker_manager.get_view_root` |
| 7 | **Debug toggle** in the render tab | `views.html` `.panel-debug-toggle` |

**Why #1 matters most:** Odoo's view composition is lenient. An `<xpath>` that matches nothing is
dropped with a log line, and the view still turns on. So "Saved, and the view is on" does not mean the
fix works. The check is what proves it.

**Out of scope:** odoo-manager's code-upgrade analysis (code diff, estimates, Excel/Markdown reports,
AI judgment, auto-renames), its MCP server, connect-as-user, extending database expiration, and the
"Overridden views" report section (not covered by odoo-manager either). The "view vs its parent" diff
stays out of scope (user's choice, 2026-10-02).

## Rulings (made while drafting; the user prefers rulings to questions)

Each is `decision — why — cost if wrong`.

1. **The XPath check runs in the database's Odoo shell (the existing view worker), in Python, with
   lxml** — not in TypeScript. It needs the parent's combined arch from Odoo anyway, lxml's XPath is the
   one Odoo uses, and it adds no npm dependency — a check costs one worker round trip (the shell is
   usually already running).
2. **The check's baseline is the parent's combined arch with the checked view and its descendants
   excluded**, computed with `_get_combined_arch()` (the raw combined arch Odoo applies inheritance
   specs to, before `get_view` post-processing strips nodes by groups). The exclusion is done by
   deactivating them inside the request's transaction, which the worker always rolls back. Later
   siblings stay in — the same approximation odoo-manager makes — a locator only a later sibling breaks
   or fixes is misjudged.
3. **The checker is a verbatim port of `xpath_check.py` in its own file,
   `resources/scripts/xpath_check.py`**, loaded by the worker from its own folder, so it is unit-testable
   with any Python that has lxml — the worker bootstrap must learn its folder.
4. **The check runs on the editor's text, not the stored arch**, so lxml's `sourceline` maps each
   locator to a line in the open document — none.
5. **Results are diagnostics in their own collection (`odoo-view-xpaths`)**, separate from Odoo's
   activation errors: dead → Warning "matches nothing: this patch does nothing", ambiguous → Warning
   "matches N nodes: Odoo patches the first", invalid → Error, ok with a shorter equivalent → Hint.
   A quick fix replaces the expression with the shortest equivalent (ambiguous and long-ok locators) —
   Hints are faint, so long Studio paths don't shout.
6. **The check runs after every save of an inheriting view, and on demand** (Check XPaths on a row and
   on an arch editor's title). The automatic run is toggleable: `odooDebugger.views.checkXpathsOnSave`,
   default true (working-style rule) — none.
7. **The save toast says so** when the check finds dead or invalid locators: "Saved, and the view is
   on — but 2 locators match nothing." — none.
8. **Reports render as HTML in the render tab** (`/report/html/<report_name>/<id>` through the existing
   proxy); **PDF is downloaded, not framed**: VS Code webviews have no PDF viewer. A "PDF" toolbar
   button fetches `/report/pdf/...` from the server with a minted session and opens the file with the
   OS's default app (`vscode.env.openExternal`) — in a remote window the file lands on the remote host,
   so PDF is local-only for now.
9. **Only report templates render.** A QWeb fragment that no report uses (website snippets, page parts)
   still gets the current message — rendering it needs the page around it — none.
10. **A report's record follows odoo-manager's rule**: the newest record of the report's model, and for
    `account.move` the newest that is not a plain journal entry (`move_type != 'entry'`). In Upgrade
    mode both sides show the same record, as views already do; stepping works the same way. A model
    with no record shows "No <model> record to render this report with." — none.
11. **"Disabled only here" compares by view id** with the upgrade's original database, as
    odoo-manager does: the upgraded database is a copy of the original, so ids carry over — a view the
    upgrade recreated with a new id counts as newly off.
12. **The filter applies to "Other inactive views" only**, in Upgrade mode only. "Disabled by upgrade"
    already comes from the upgrade's own report. It is on by default; the group description says how
    many it hides ("12 · 30 also off in shop-17"), and a title toggle shows them again (remembered per
    workspace) — a view off in both but newly broken is hidden until toggled.
13. **Finding views uses QuickPicks, not new tree groups.** Find View (Views title, `$(search)`) accepts
    a view id, an external id, or a model name (with the models that have views as items); a model
    lists its views, base views first and each inheriting view indented under its parent, active ones
    marked. Views Inheriting This (row and editor title) lists the descendants the same way. Picking one
    opens its arch — the tree stays about what is off.
14. **Row actions also work from an open arch's editor title**, so a view opened with Find View is not
    a dead end: Compare with Original, Render and Check XPaths as title icons for `odoo-view:` editors;
    Open Parent, Open Root, Views Inheriting This and Add to Upgrade Script in its "…" menu. Turn On/Off
    stay in the tree only — a command takes a tree row, an `odoo-view:` URI, or nothing (the active
    editor), and resolves it to the same `{ dbName, view }`.
15. **Open Root View** opens `ViewRow.rootId` (already computed by `viewRowsSql`); shown only when the
    root differs from the parent (a new `deep` part in the row's contextValue) — none.
16. **The render tab gets a Debug toggle**, on by default (today's behaviour), remembered per workspace.
    Off removes `debug=1` from frame URLs — none.
17. **No change to upgrade scripts.** Warning about dead locators when scripting is a possible stage 5
    item — a script can still carry a view whose patch matches nothing; the check on save is the guard.

## Design

### 1. XPath check

**Python (`resources/scripts/xpath_check.py`).** Port `odoo_manager/xpath_check.py` as is, adding a
`line` (lxml `sourceline`) to each locator entry. Port `tests/test_xpath_check.py`'s 13 cases.

**Worker command `check_xpaths(view_id, arch)`.** In `view_worker.py`, added to `COMMANDS`:
- Refuses a view with no `inherit_id`: "Not an inheriting view: it has no locators to check."
- Deactivates the view and its descendants inside the transaction, reads the parent's
  `_get_combined_arch()` (falling back the way `_compose` does on old versions), runs
  `xpath_check.check(arch, parent_arch)`, and returns its result. The worker's existing end-of-request
  rollback undoes the deactivation; nothing is committed and no cache is signalled.
- Runs as `ENV` (en_US), like every command.

**TypeScript.**
- `ViewService.checkXpaths(dbName, viewId, arch): Promise<XpathReport>`, with `XpathReport` the typed
  result (`locators[]` with `kind`, `expr`, `position`, `status`, `matches`, `line`, `shorter[]`, plus
  `summary` and `healthy`, or `error`).
- `src/views/xpathDiagnostics.ts` (pure): a report and the document text become `vscode.Diagnostic[]`
  (rule 5). The range is the `expr="…"` attribute value on the reported line (or the tag for a direct
  locator), falling back to the whole line.
- A `CodeActionProvider` for the `odoo-view` scheme offers "Use `<shorter>`" on diagnostics carrying
  shorter equivalents.
- `onSaved` in `extension.ts` runs the check for an inheriting view when the setting is on. It does not
  delay the save; a failed check is logged, never shown as a save error. Closing the document clears
  its diagnostics.
- `viewDoctor.checkXpaths` runs it on demand and reports "All N locators match." or the counts.

### 2. Finding views

**Queries (`viewQueries.ts`, psql, one JSON value each, ids validated, text through `sqlText`):**
- `viewModels(db)`: the distinct models that have views, with counts.
- `viewsOfModel(db, model)` and `descendants(db, viewId)` (recursive on `inherit_id`, bounded like the
  root walk): `ViewRow`s via `viewRowsSql`, so external ids stay consistent.
- An id or external id goes through `getViewRows` / `findViewByXmlid` (stage 2).

**Commands:** `viewDoctor.findView` (Views title), `viewDoctor.showInheriting`, `viewDoctor.openRoot`.
The QuickPick builder (`src/views/viewPicker.ts`, pure apart from the pick) orders base views first and
indents each inheriting view under its parent (rule 13); labels: name, then `model · type · xmlid` and
`$(circle-slash)` for an inactive view.

**Editor-title actions (rule 14):** `package.json` `editor/title` entries with
`resourceScheme == odoo-view`. A shared resolver `viewTarget(arg)` turns a `ViewItem`, an `odoo-view:`
URI or the active editor into `{ dbName, view: ViewRow }` (a psql read for a URI); every listed command
uses it.

### 3. "Disabled only here"

- `inactiveViewIds(db)`: one light query (`SELECT json_agg(id) … WHERE active = false`).
- `ViewService.doctorGroups` takes the original database when the tree shows the upgraded side
  (`upgradePair`), reads its inactive ids, and `groupViews` splits "Other inactive views" into shown
  and `alsoOffInOriginal`.
- The group's description gives both counts; the toggle commands `viewDoctor.showAlsoOff` /
  `viewDoctor.hideAlsoOff` switch a context key and a workspaceState flag, then refresh. With the
  filter off, those rows say "off in <original> too".
- Reading the original's ids must never fail the tree: on error, show everything and log it.

### 4. Rendering reports

**Worker command `report_target(view_id)`:** resolves the view's root (same walk as `_root`), finds the
`ir.actions.report` whose `report_name` is the root's external id, and returns
`{ report_name, display_name, model, domain }` (`domain` is `[["move_type","!=","entry"]]` for
`account.move`, else `[]`), or `null`. `recent_ids` gains an optional `domain` argument.

**Render session:** `RenderTarget` gets `kind: 'view' | 'report'`. For a report, each side resolves
its own target (its own counterpart view, matched as today), its ids come from
`recentIds(model, limit, domain)`, and the frame path is `/report/html/<report_name>/<id>` (with
`?debug=1` when the toggle is on). Common ids, stepping and Reload work as for views; there is no "new
record" for a report (rule 10). A side whose database has no such report shows "<db> has no report for
this template."

**`viewDoctor.render` on a QWeb row** renders the report when `isReport`, else keeps today's message.

**PDF (rule 8):** a toolbar button posts `pdf` to the extension, which GETs
`/report/pdf/<report_name>/<id>` from that side's server port with a freshly minted session cookie
(not through the proxy, which only the webview may use), writes it to
`os.tmpdir()/odt-report-<db>-<report>-<id>.pdf`, and opens it externally. Errors show as a toast.

### 5. Debug toggle

The render tab's toolbar gets a "Debug" checkbox (rule 16). `framePath` takes `debug: boolean`; a
change reloads both frames.

## Files

**New:** `resources/scripts/xpath_check.py`; `src/views/xpathDiagnostics.ts`;
`src/views/viewPicker.ts`; tests for each.

**Modified:** `resources/scripts/view_worker.py` (`check_xpaths`, `report_target`, `recent_ids`
domain); `src/services/views/viewWorker.ts` (the scripts folder reaches the worker);
`viewQueries.ts`, `viewService.ts`, `viewGroups.ts`, `renderPlan.ts`, `renderSession.ts`;
`src/views/viewDoctorView.ts`, `viewRenderPanel.ts`; `src/commands/viewDoctorCommands.ts`;
`src/extension.ts` (diagnostics collection, code actions, save hook); `package.json` (commands, menus,
setting); `CHANGELOG.md`, `README.md`.

## Traps that apply (see the stage 1–3 handovers and plans)

- The worker rolls back at the start and end of every request; never leave it in a transaction.
  `check_xpaths` relies on that rollback, so it must not commit or `_signal`.
- The shell's env is OdooBot's language; use `ENV` (en_US).
- `tree`/`list` are one type across 18.0 (matching a report's counterpart is by external id anyway).
- Odoo 19 caches views in IndexedDB; the proxy's `Clear-Site-Data` already covers frame reloads.
- The render iframes must never be sandboxed (the proxy refuses `Origin: null` writes).
- Projects from `SettingsStore` are plain JSON; `getChildren(element)` handles `element` first.
- Destructive actions stay right-click only; any automatic behaviour has a setting.
- Commits: `[ADD]`/`[IMP]`/`[FIX]`/`[REF]`/`[DOC]` with a body and the session's trailer; never
  `git add -A`; `dist/` rebuilt in the last commit. `v-1.5` is never merged or pushed.

## Verification

**Unit (mocha):** `xpathDiagnostics` (each status, line and range, the Hint/Warning/Error mapping,
quick-fix edits); `viewPicker` ordering and indentation; `groupViews` with `alsoOffInOriginal`;
`framePath` for reports and the debug flag; the render session for a report (common ids, no-record
message, one side without the report); `viewTarget` from a row, a URI and the active editor; the
package.json menu wiring (row, title, editor-title `when` clauses).

**Python:** the 13 ported `test_xpath_check.py` cases, run from mocha through a Python that has lxml
(`ODT_VIEW_TEST_PYTHON` when set, else `python3`; skipped when neither has lxml).

**Real Odoo (gated, 17/18/19, the stage 1 handover §5 recipe):** `check_xpaths` on a view with one ok,
one dead and one ambiguous locator, including a Studio-style `//form[1]/…` path, with the view both
active and inactive (the exclusion must make both give the same result); `report_target` on a report
template (the test picks the first `ir.actions.report` of a model `base` installs, so it needs no
other module), and `null` on a plain form.

**Live window (Xvfb recipe):** save a view whose xpath matches nothing → Warning on that line and the
toast says so; the quick fix shortens a long path; Find View by id, xmlid and model; Views Inheriting
This; Open Root; Compare/Render from an arch's editor title; the filter's counts and toggle in Upgrade
mode; Render on a report row shows HTML on both sides on the same invoice; PDF opens externally; the
Debug toggle reloads both frames.

## Phasing (one plan, tasks in this order, each shippable)

1. XPath checker port + worker command + diagnostics + quick fix + save hook + Check XPaths.
2. View target resolver + editor-title actions + Find View + Views Inheriting This + Open Root.
3. "Disabled only here" filter.
4. Report rendering + PDF + debug toggle.
5. Docs, rebuild, live check.
