# View Doctor Stage 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Check that an inheriting view's locators still match (XPath check, diagnostics, quick fix), find any view (by id, external id, model, descendants, root), hide inactive views the original database also has off, and render QWeb reports (HTML in the render tab, PDF opened externally) with a Debug toggle.

**Architecture:** The XPath checker is a Python port of odoo-manager's `xpath_check.py` that the existing View Doctor worker (`odoo-bin shell`) loads from its own folder; the worker computes the parent's combined arch with the checked view and its descendants switched off inside the request's rolled-back transaction. TypeScript maps the result onto the open arch's text (by element index, not by line) as diagnostics plus quick fixes. Finding views is psql + QuickPicks; the filter is one more psql read; reports reuse the render tab and its gated proxy with a `/report/html/...` frame path, and PDF is fetched straight from the server with the proxy's session.

**Tech Stack:** TypeScript (VS Code extension API, mocha in the Extension Host), Python 3 + lxml inside Odoo 15–19, PostgreSQL via psql.

**Spec:** `docs/superpowers/specs/2026-10-06-view-doctor-stage-4-design.md` (approved by the user, 2026-10-06). Read it with this plan. Also read `docs/superpowers/notes/2026-10-05-view-doctor-handover-stage-3.md` §4 (traps) and §5 (verification).

## Global Constraints

- Branch `v-1.5` only. **Never merge, push, or offer to.** The extension never runs `git commit` for the user.
- Commits: `[ADD]` / `[IMP]` / `[FIX]` / `[REF]` / `[DOC]` prefix, a body, and the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. **Never `git add -A`**; add the files you touched by name. `dist/` is rebuilt only in Task 10; in other tasks run `git checkout -- dist` after tests.
- The worker rolls back at the start and end of every request. `check_xpaths` must **not commit and not `_signal`**. Every command runs on `ENV` (en_US).
- `tree`/`list` are one view type across 18.0.
- The render iframes must never be sandboxed.
- Projects from `SettingsStore` are plain JSON; `getChildren(element)` handles `element` first.
- Destructive actions stay right-click only behind a modal; any automatic behaviour has a setting (`odooDebugger.views.checkXpathsOnSave`, default `true`).
- SQL: ids only through `sqlIdList`, text only through `sqlText`; every query goes through `runSql`.
- Copy style: plain, short sentences, as in the existing CHANGELOG and README.
- Verification commands (all from the repo root):
  - `npx tsc -p . --noEmit` — 0 errors.
  - `npm run lint` — 0 errors (117 warnings is the baseline; do not add warnings in new files).
  - Tests run **outside the Bash sandbox** (`dangerouslyDisableSandbox: true`) with `env -u ELECTRON_RUN_AS_NODE`: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "<suite name>"`; full suite `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npm test`. Baseline before this plan: 768 passing, 19 pending. Then `git checkout -- dist`.
- IDE diagnostics `OWL000` in TS files are false positives; trust `tsc`.

## Review Focus

The five inputs the spec implies but no happy-path test would hit, most likely first. Each has a test in the task named.

1. **A one-line (minified) arch with several locators on one line** — each diagnostic and quick fix lands on its own `expr`, not the first on the line. (Task 3: element-index mapping test.)
2. **An arch with a comment, CDATA or XML declaration that contains `<xpath …>` text** — the commented-out one is skipped, the real ones keep their places. (Task 3.)
3. **An `expr` attribute delimited by `'`, or a shorter locator containing `"`** — the quick fix writes valid XML (`&apos;` / `&quot;`). (Task 3.)
4. **The arch edited after the check** — the quick fix offers nothing rather than replacing the wrong characters. (Task 5.)
5. **In Upgrade mode, the original database unreachable or dropped** — the Views tree shows every inactive view and still loads. (Task 7.)

## Rulings made while planning

Each is `decision — why — cost if wrong`. They extend the spec's 17.

- P1. The worker finds `xpath_check.py` through its own code object's file name (`compile()` set it to the script's path), loaded lazily with `importlib` — no bootstrap change, so `viewWorker.ts` is untouched — cost if wrong: none; the gated integration test exercises it through the real bootstrap.
- P2. No fallback for `_get_combined_arch()`: checked, it exists on 15, 16, 17, 18 and 19 (`odoo/addons/base/models/ir_ui_view.py`) — cost if wrong: none for 15–19.
- P3. The exclusion is a raw `UPDATE ir_ui_view SET active = false` on the view and its descendants (recursive on `inherit_id`, depth ≤ 50), not an ORM write — no website copy-on-write, no write_date, no cache clear; the request's rollback undoes it — cost if wrong: none.
- P4. Each locator also carries `element`, its index among the arch's elements in document order. TypeScript maps a locator to text by that index, because lxml's `sourceline` is the line where the start tag **ends** (verified) and a minified arch has several locators per line. `line` stays as the fallback — cost if wrong: a locator's squiggle falls back to its line.
- P5. Odoo's `?debug=` is sticky in the session (`_handle_debug` writes `session.debug`), so Debug off sends `debug=0`, not "no parameter" — amends spec rule 16's "Off removes `debug=1`" — cost if wrong: none.
- P6. Quick fixes only for `<xpath expr>` locators. A direct locator (`<field name="x" position="after">`) has no expression to replace; it gets the diagnostic only, and its "ok with a shorter equivalent" Hint is skipped — cost if wrong: no one-click fix for an ambiguous direct locator.
- P7. The save message waits for the check (the shell is warm: one round trip), so "Saved, and the view is on — but 2 locators match nothing." is one message. A check that fails or is off gives today's message — cost if wrong: the brief status shows a moment later.
- P8. `save` returns `inheriting` (whether the view has an `inherit_id`), so the save hook knows whether to check without a second query — cost if wrong: none.
- P9. Check XPaths opens the arch (or reveals it when open but not visible) and checks the editor's text, so the squiggles are visible; a view with no parent says so without asking the shell — cost if wrong: none.
- P10. Editor-title "…" entries (Open Parent, Open Root, Views Inheriting This, Add to Upgrade Script) show on every `odoo-view:` editor; a view with nothing to open says so ("… inherits no view.", "… is a root view."). Setting a per-editor context key would need a psql read per editor switch — cost if wrong: two menu entries that sometimes only explain.
- P11. Commands that take a view also work from the Command Palette when the active editor is an `odoo-view:` file (`when: resourceScheme == odoo-view`); Find View is always in the palette. Turn On/Off, Copy External ID and Open Arch stay tree-only (rule 14) — cost if wrong: none.
- P12. QuickPick indentation uses em spaces (U+2003, not collapsed by HTML) plus `↳` — cost if wrong: flat-looking nesting; the live check looks at it.
- P13. "Other inactive views" with every row hidden by the filter still shows, with one row "All N are off in <original> too." — cost if wrong: none.
- P14. Report render follows the spec: Render on a QWeb row renders a report only when `isReport` (the tree's SQL: root = top of the chain). The worker's `report_target` tries `_root` (first primary ancestor) then the top of the chain, so it agrees with `isReport` and also finds a primary-mode template — cost if wrong: a primary-mode report template whose top is not a report shows the fragment message.
- P15. PDF reuses the side's proxy session (`proxy.session()`, minted once per tab) instead of minting one per click — the same admin session the frame already uses, and no pile of sessions in Odoo's store — cost if wrong: none.
- P16. odoo-manager's two "pilot" tests read a client checkout that is not on this machine; they are ported with inline archs that reproduce the same case (a raw parent without `group_general` → dead; a composed one with it → ok) — cost if wrong: none.
- P17. Report sides with no record show the message in the frame area; there is no "New record" for a report (rule 10) — cost if wrong: none.

## File map

| File | Task | Responsibility |
|---|---|---|
| `resources/scripts/xpath_check.py` (new) | 1 | The checker, ported, plus `line` and `element` |
| `src/test/python/test_xpath_check.py` (new) | 1 | The 13 ported cases + 3 new, runnable with any Python that has lxml |
| `src/test/xpathCheck.test.ts` (new) | 1 | Runs the Python cases from mocha |
| `resources/scripts/view_worker.py` | 2, 8 | `check_xpaths`; `save` returns `inheriting`; `report_target`; `recent_ids` domain |
| `src/services/views/xpathReport.ts` (new) | 2 | Report types, parser, message text |
| `src/services/views/viewService.ts` | 2, 7, 8 | `checkXpaths`, `doctorGroups(db, originalDb?)`, `reportTarget`, `recentIds` domain |
| `src/views/xpathDiagnostics.ts` (new) | 3, 5 | Pure: element scan, spans, findings, quoting. Task 5: the diagnostics + code-action class |
| `src/views/viewTarget.ts` (new) | 4 | A row, an `odoo-view:` URI or the active editor → `{ dbName, view }` |
| `src/views/viewDoctorView.ts` | 4, 7 | `deep` contextValue; filter rows and description |
| `src/commands/viewDoctorCommands.ts` | 4–9 | Commands |
| `src/views/viewSaveHook.ts` (new) | 5 | What happens after an arch save |
| `src/extension.ts` | 5, 7, 9 | Wiring |
| `src/commands/index.ts` | 5 | `CommandDeps.xpathDiagnostics` |
| `src/services/views/viewQueries.ts` | 6, 7 | `viewModels`, `viewsOfModel`, `descendants`, `inactiveViewIds` |
| `src/views/viewPicker.ts` (new) | 6 | Pure QuickPick builders |
| `src/views/findViewFlow.ts` (new) | 6 | Find View and the view pick |
| `src/services/views/viewGroups.ts` | 7 | `alsoOffInOriginal` |
| `src/services/views/renderPlan.ts`, `renderSession.ts` | 8, 9 | Report frames, debug flag, PDF source |
| `src/services/views/reportPdf.ts` (new) | 9 | Fetch a report PDF from Odoo |
| `src/views/viewRenderPanel.ts` | 9 | Debug checkbox, PDF button |
| `package.json` | 4–7, 9 | Commands, menus, setting |
| `CHANGELOG.md`, `README.md`, `dist/` | 10 | Docs, rebuild |

## Model assignment (controller)

- Implementers: Tasks 2, 3, 5, 8, 9 on the most capable model (`opus`); Tasks 1, 4, 6, 7, 10 on `sonnet`.
- Task reviewers: Tasks 1, 2, 3, 5 (XPath check), 8 (report), 9 (render/proxy) on `opus`; the others on `sonnet`.
- Final whole-branch review on `opus`.

---

### Task 1: Port the XPath checker to the extension

**Files:**
- Create: `resources/scripts/xpath_check.py`
- Create: `src/test/python/test_xpath_check.py`
- Create: `src/test/xpathCheck.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `xpath_check.check(child_arch: str, parent_arch: str) -> dict` returning `{"locators": [...], "summary": {"ok","dead","ambiguous","invalid"}, "healthy": bool}` or `{"error": str}`. Each locator: `kind` (`"xpath"`|`"direct"`), `expr`, `position`, `length`, `line` (lxml `sourceline`: the line where the start tag **ends**, 1-based), `element` (index among the child arch's elements in document order, comments and PIs not counted, root = 0), `status`, `matches` (int or None), `shorter` (≤ 3 strings, shortest first; absent for invalid and dead), `detail` (invalid only).

- [ ] **Step 1: Write the Python tests**

Create `src/test/python/test_xpath_check.py`:

```python
"""Port of odoo-manager's tests/test_xpath_check.py (13 cases), plus where
each locator is (line, element) and the shorter equivalents.

Run by src/test/xpathCheck.test.ts as `python test_xpath_check.py <scripts
folder>`; prints one JSON object, test name -> null (passed) or the failure.
The two "pilot" cases read a client checkout in odoo-manager; here they use
inline archs that reproduce the same case.
"""
import json
import os
import sys
import traceback

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..', '..', 'resources', 'scripts'))

import xpath_check as xc  # noqa: E402


# --- <xpath expr=…> ---------------------------------------------------------

def test_xpath_ok():
    child = '<xpath expr="//field[@name=\'x\']" position="after"><field name="y"/></xpath>'
    parent = '<form><field name="x"/></form>'
    result = xc.check(child, parent)
    assert result["summary"] == {"ok": 1, "dead": 0, "ambiguous": 0, "invalid": 0}
    assert result["healthy"] is True
    assert result["locators"][0]["kind"] == "xpath"


def test_xpath_dead():
    child = '<xpath expr="//field[@name=\'missing\']" position="after"><field name="y"/></xpath>'
    parent = '<form><field name="x"/></form>'
    result = xc.check(child, parent)
    assert result["summary"]["dead"] == 1
    assert result["healthy"] is False


def test_xpath_ambiguous():
    child = '<xpath expr="//field" position="after"><field name="y"/></xpath>'
    parent = '<form><field name="x"/><field name="z"/></form>'
    result = xc.check(child, parent)
    assert result["summary"]["ambiguous"] == 1


def test_xpath_invalid():
    child = '<xpath expr="//field[" position="after"><field name="y"/></xpath>'
    parent = "<form/>"
    result = xc.check(child, parent)
    assert result["summary"]["invalid"] == 1
    assert result["healthy"] is False


def test_malformed_child_arch_returns_error():
    result = xc.check("<not-closed>", "<form/>")
    assert "error" in result


def test_malformed_parent_arch_returns_error():
    result = xc.check('<xpath expr="//x" position="after"/>', "<not-closed>")
    assert "error" in result


# --- direct-locator form ----------------------------------------------------

def test_direct_locator_ok():
    child = '<field name="pricelist_id" position="before"><field name="x"/></field>'
    parent = '<form><field name="pricelist_id"/></form>'
    result = xc.check(child, parent)
    assert result["summary"] == {"ok": 1, "dead": 0, "ambiguous": 0, "invalid": 0}
    assert result["locators"][0]["kind"] == "direct"
    assert result["locators"][0]["expr"] == "//field[@name='pricelist_id']"


def test_direct_locator_dead():
    child = '<group name="not_there" position="inside"><field name="x"/></group>'
    parent = "<form><group name=\"group_general\"/></form>"
    result = xc.check(child, parent)
    assert result["summary"]["dead"] == 1


def test_direct_locator_nested_under_data_wrapper():
    child = (
        "<data>"
        '<field name="a" position="before"><field name="new1"/></field>'
        '<field name="b" position="after"><field name="new2"/></field>'
        "</data>"
    )
    parent = '<form><field name="a"/><field name="b"/></form>'
    result = xc.check(child, parent)
    assert result["summary"] == {"ok": 2, "dead": 0, "ambiguous": 0, "invalid": 0}
    assert {loc["kind"] for loc in result["locators"]} == {"direct"}


def test_mixed_xpath_and_direct_locators_both_checked():
    child = (
        "<data>"
        '<xpath expr="//field[@name=\'a\']" position="after"><field name="new1"/></xpath>'
        '<field name="b" position="before"><field name="new2"/></field>'
        "</data>"
    )
    parent = '<form><field name="a"/><field name="b"/></form>'
    result = xc.check(child, parent)
    kinds = {loc["kind"] for loc in result["locators"]}
    assert kinds == {"xpath", "direct"}
    assert result["summary"]["ok"] == 2


def test_direct_locator_no_identifying_attribute_is_skipped():
    child = '<newline position="after"/>'
    parent = "<form/>"
    result = xc.check(child, parent)
    assert result["locators"] == []


# --- the primary-on-primary case (odoo-manager's pilot tests, inline) --------

PILOT_CHILD = (
    "<data>"
    '<group name="group_general" position="inside"><field name="x_label"/></group>'
    "</data>"
)


def test_group_general_dead_against_raw_parent_text():
    # The parent's own arch, before composition with *its* parent: no group_general.
    raw_parent = '<form><sheet><field name="name"/></sheet></form>'
    result = xc.check(PILOT_CHILD, raw_parent)
    direct_hits = [loc for loc in result["locators"] if loc["kind"] == "direct"]
    assert direct_hits, "expected the group_general patch to be found as a direct locator"
    assert direct_hits[0]["status"] == "dead"


def test_group_general_ok_against_a_composed_parent():
    composed_parent = '<form><group name="group_general"><field name="other"/></group></form>'
    result = xc.check(PILOT_CHILD, composed_parent)
    direct_hits = [loc for loc in result["locators"] if loc["kind"] == "direct"]
    assert direct_hits[0]["status"] == "ok"


# --- added here: where each locator is, and the shorter equivalents ---------

def test_locators_carry_the_line_their_start_tag_ends_on_and_their_element():
    child = (
        "<data>\n"
        "  <xpath\n"
        "     expr=\"//field[@name='a']\"\n"
        "     position=\"after\">\n"
        "    <field name=\"new\"/>\n"
        "  </xpath>\n"
        "  <field name=\"b\" position=\"before\"/>\n"
        "</data>"
    )
    parent = '<form><field name="a"/><field name="b"/></form>'
    result = xc.check(child, parent)
    assert [(loc["kind"], loc["line"], loc["element"]) for loc in result["locators"]] == [
        ("xpath", 4, 1),
        ("direct", 7, 3),
    ]


def test_elements_count_in_document_order_without_comments():
    child = '<data><!-- <xpath expr="//zzz"/> --><xpath expr="//a"/><?pi x?><xpath expr="//b"/></data>'
    parent = "<form><a/><b/></form>"
    result = xc.check(child, parent)
    assert [(loc["expr"], loc["element"], loc["line"]) for loc in result["locators"]] == [("//a", 1, 1), ("//b", 2, 1)]


def test_a_long_unique_path_offers_shorter_equivalents():
    child = '<xpath expr="/form/sheet/group/field" position="after"><field name="y"/></xpath>'
    parent = '<form><sheet><group><field name="x"/></group></sheet></form>'
    result = xc.check(child, parent)
    locator = result["locators"][0]
    assert locator["status"] == "ok"
    assert locator["shorter"][0] == "//field[@name='x']"
    assert all(len(s) < len(locator["expr"]) for s in locator["shorter"])


if __name__ == "__main__":
    results = {}
    for name, function in sorted(globals().items()):
        if name.startswith("test_") and callable(function):
            try:
                function()
                results[name] = None
            except Exception:  # noqa: BLE001 - reported per test
                results[name] = traceback.format_exc()
    print(json.dumps(results))
```

- [ ] **Step 2: Write the mocha wrapper**

Create `src/test/xpathCheck.test.ts`:

```ts
/**
 * The XPath checker's Python tests (src/test/python/test_xpath_check.py),
 * one mocha test each. Uses ODT_VIEW_TEST_PYTHON when set, else python3;
 * skipped when that Python has no lxml (Odoo's venvs all do).
 */
import * as assert from 'assert';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPTS = path.join(REPO, 'resources', 'scripts');
const TESTS = path.join(REPO, 'src', 'test', 'python', 'test_xpath_check.py');
const PYTHON = process.env.ODT_VIEW_TEST_PYTHON || 'python3';

const CASES = [
    'test_a_long_unique_path_offers_shorter_equivalents',
    'test_direct_locator_dead',
    'test_direct_locator_nested_under_data_wrapper',
    'test_direct_locator_no_identifying_attribute_is_skipped',
    'test_direct_locator_ok',
    'test_elements_count_in_document_order_without_comments',
    'test_group_general_dead_against_raw_parent_text',
    'test_group_general_ok_against_a_composed_parent',
    'test_locators_carry_the_line_their_start_tag_ends_on_and_their_element',
    'test_malformed_child_arch_returns_error',
    'test_malformed_parent_arch_returns_error',
    'test_mixed_xpath_and_direct_locators_both_checked',
    'test_xpath_ambiguous',
    'test_xpath_dead',
    'test_xpath_invalid',
    'test_xpath_ok'
];

suite('XPath checker (Python)', function () {
    this.timeout(60000);
    let results: Record<string, string | null> | undefined;

    suiteSetup(function () {
        const probe = spawnSync(PYTHON, ['-c', 'import lxml'], { encoding: 'utf-8' });
        if (probe.status !== 0) {
            this.skip();
        }
        const run = spawnSync(PYTHON, [TESTS, SCRIPTS], { encoding: 'utf-8' });
        assert.strictEqual(run.status, 0, run.stderr);
        results = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}');
    });

    test('runs exactly the expected cases', () => {
        assert.deepStrictEqual(Object.keys(results ?? {}).sort(), [...CASES].sort());
    });

    for (const name of CASES) {
        test(name, () => {
            assert.ok(results && name in results, `${name} did not run`);
            assert.strictEqual(results[name], null, results[name] ?? undefined);
        });
    }
});
```

- [ ] **Step 3: Run it to see it fail**

Run (outside the sandbox): `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "XPath checker"`
Expected: FAIL — `suiteSetup` asserts a non-zero exit: `ModuleNotFoundError: No module named 'xpath_check'`.

- [ ] **Step 4: Port the checker**

Create `resources/scripts/xpath_check.py` by copying `/home/odoo/Dev/odoo-manager/odoo_manager/xpath_check.py` **verbatim**, then make exactly these changes:

1. Add to the end of the module docstring:

```
Ported from odoo-manager (odoo_manager/xpath_check.py) for the Odoo DevTools
View Doctor, which loads it inside the database's `odoo-bin shell`. The one
addition: each locator says where it is in the checked text - `line`, lxml's
sourceline (the line its start tag *ends* on), and `element`, its index among
the child arch's elements in document order - so the editor can put the
result on the right characters even when several locators share a line.
```

2. `_resolve` takes the element index and records the position:

```python
def _resolve(node, expr, parent, kind, element):
    """...keep the original docstring..."""
    entry = {
        "kind": kind,
        "expr": expr,
        "position": node.get("position") or "inside",
        "length": len(expr),
        "line": node.sourceline,
        "element": element,
    }
```

(the rest of `_resolve` unchanged).

3. In `check`, after both archs parse, index the elements and pass the index:

```python
    # Comments and processing instructions are nodes too, but not elements:
    # the editor counts start tags, so they are left out of the count.
    elements = {
        node: index
        for index, node in enumerate(n for n in child.iter() if isinstance(n.tag, str))
    }

    results = []
    for node in child.iter("xpath"):
        expr = node.get("expr")
        if not expr:
            continue
        results.append(_resolve(node, expr, parent, kind="xpath", element=elements[node]))

    for node in _direct_locator_nodes(child):
        expr = _direct_locator_expr(node)
        if expr is None:
            continue
        results.append(_resolve(node, expr, parent, kind="direct", element=elements[node]))
```

Nothing else changes (the `summary`/`healthy` lines stay as they are).

- [ ] **Step 5: Run the tests**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "XPath checker"`
Expected: 17 passing. Also `python3 src/test/python/test_xpath_check.py resources/scripts` prints all-null JSON. Then `git checkout -- dist`.

- [ ] **Step 6: Commit**

```bash
git add resources/scripts/xpath_check.py src/test/python/test_xpath_check.py src/test/xpathCheck.test.ts
git commit -m "[ADD] Port odoo-manager's XPath checker for the View Doctor

xpath_check.py resolves every locator of an inheriting view - <xpath expr>
and direct ones - against its parent's arch: ok, dead, ambiguous or invalid,
with shorter equivalents. It is ported verbatim, plus where each locator is:
lxml's line and its element index, since several locators can share a line.
Its 13 tests are ported (the two that read a client checkout use inline
archs) and run from mocha through any Python with lxml.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The worker's `check_xpaths`, and the report types

**Files:**
- Modify: `resources/scripts/view_worker.py` (imports; `cmd_save`; new `_xpath_check`, `cmd_check_xpaths`; `COMMANDS`)
- Create: `src/services/views/xpathReport.ts`
- Modify: `src/services/views/viewService.ts` (`SaveResult.inheriting`, `checkXpaths`)
- Test: `src/test/xpathReport.test.ts` (new), `src/test/viewService.test.ts`, `src/test/viewWorker.integration.test.ts`

**Interfaces:**
- Consumes: Task 1's `xpath_check.check` and its locator fields.
- Produces:
  - Worker command `check_xpaths { view_id, arch }` → `check()`'s dict; refuses a view with no `inherit_id` with `Not an inheriting view: it has no locators to check.`
  - `save` replies gain `inheriting: bool`.
  - `src/services/views/xpathReport.ts`:
    ```ts
    export type LocatorStatus = 'ok' | 'dead' | 'ambiguous' | 'invalid';
    export interface XpathLocator { kind: 'xpath' | 'direct'; expr: string; position: string; status: LocatorStatus; matches: number | null; line: number | null; element: number | null; shorter: string[]; detail?: string }
    export interface XpathSummary { ok: number; dead: number; ambiguous: number; invalid: number }
    export interface XpathReport { locators: XpathLocator[]; summary: XpathSummary; healthy: boolean; error?: string }
    export function parseXpathReport(raw: unknown): XpathReport
    export function brokenLocators(report: XpathReport): string | undefined
    export function checkResultText(report: XpathReport): { level: 'info' | 'warning'; text: string }
    ```
  - `SaveResult.inheriting?: boolean`; `ViewService.checkXpaths(dbName: string, viewId: number, arch: string): Promise<XpathReport>`.

- [ ] **Step 1: Write the failing unit tests**

Create `src/test/xpathReport.test.ts`:

```ts
import * as assert from 'assert';
import { brokenLocators, checkResultText, parseXpathReport } from '../services/views/xpathReport';

const locator = (status: string, extra: Record<string, unknown> = {}) => ({
    kind: 'xpath', expr: '//a', position: 'after', length: 3, line: 2, element: 1, status, matches: status === 'dead' ? 0 : 1, shorter: [], ...extra
});

suite('XPath report', () => {
    test('parses the checker\'s result and counts it again', () => {
        const report = parseXpathReport({
            locators: [locator('ok', { shorter: ['//x'] }), locator('dead'), locator('ambiguous', { matches: 3 }), locator('invalid', { matches: null, detail: 'Invalid expression' })],
            summary: { ok: 99 }, healthy: true
        });
        assert.deepStrictEqual(report.summary, { ok: 1, dead: 1, ambiguous: 1, invalid: 1 });
        assert.strictEqual(report.healthy, false);
        assert.deepStrictEqual(report.locators[0], { kind: 'xpath', expr: '//a', position: 'after', status: 'ok', matches: 1, line: 2, element: 1, shorter: ['//x'] });
        assert.strictEqual(report.locators[3].detail, 'Invalid expression');
        assert.strictEqual(report.locators[3].matches, null);
    });

    test('an error result has no locators', () => {
        assert.deepStrictEqual(parseXpathReport({ error: 'child arch is not valid XML: x' }),
            { locators: [], summary: { ok: 0, dead: 0, ambiguous: 0, invalid: 0 }, healthy: false, error: 'child arch is not valid XML: x' });
    });

    test('odd shapes do not throw', () => {
        assert.deepStrictEqual(parseXpathReport(null).locators, []);
        const odd = parseXpathReport({ locators: [{ status: 'weird', kind: 'other', line: 'x', element: -1 }] }).locators[0];
        assert.deepStrictEqual([odd.status, odd.kind, odd.line, odd.element, odd.expr], ['invalid', 'direct', null, null, '']);
    });

    test('what a save says about broken locators', () => {
        assert.strictEqual(brokenLocators(parseXpathReport({ locators: [locator('ok'), locator('ambiguous')] })), undefined);
        assert.strictEqual(brokenLocators(parseXpathReport({ locators: [locator('dead')] })), '1 locator matches nothing');
        assert.strictEqual(brokenLocators(parseXpathReport({ locators: [locator('dead'), locator('dead'), locator('invalid')] })),
            '2 locators match nothing and 1 locator is not valid XPath');
    });

    test('what Check XPaths says', () => {
        assert.deepStrictEqual(checkResultText(parseXpathReport({ locators: [locator('ok'), locator('ok')] })), { level: 'info', text: 'All 2 locators match.' });
        assert.deepStrictEqual(checkResultText(parseXpathReport({ locators: [locator('ok')] })), { level: 'info', text: 'The locator matches.' });
        assert.deepStrictEqual(checkResultText(parseXpathReport({ locators: [] })), { level: 'info', text: 'This view has no locators to check.' });
        assert.deepStrictEqual(checkResultText(parseXpathReport({ locators: [locator('ok'), locator('dead'), locator('ambiguous'), locator('ambiguous')] })),
            { level: 'warning', text: 'Of 4 locators, 1 matches nothing, 2 match several nodes.' });
        assert.deepStrictEqual(checkResultText(parseXpathReport({ error: 'child arch is not valid XML: y' })),
            { level: 'warning', text: 'Could not check the locators: child arch is not valid XML: y' });
    });
});
```

In `src/test/viewService.test.ts`, add a second suite at the end:

```ts
suite('View service XPath check', () => {
    test('sends the editor\'s text to the shell and parses the result', async () => {
        const calls: Array<[string, string, unknown]> = [];
        const service = new ViewService(fakePool({
            check_xpaths: { locators: [{ kind: 'xpath', expr: '//a', position: 'after', status: 'dead', matches: 0, line: 1, element: 0, shorter: [] }] }
        }, calls));
        const report = await service.checkXpaths('shop-18', 12, '<xpath expr="//a"/>');
        assert.strictEqual(report.summary.dead, 1);
        assert.deepStrictEqual(calls, [['shop-18', 'check_xpaths', { view_id: 12, arch: '<xpath expr="//a"/>' }]]);
    });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run compile-tests` — Expected: tsc errors, `xpathReport` and `checkXpaths` do not exist.

- [ ] **Step 3: Write `xpathReport.ts`**

Create `src/services/views/xpathReport.ts`:

```ts
/**
 * What the View Doctor's XPath check (resources/scripts/xpath_check.py, run
 * by the worker's check_xpaths) says about an inheriting view's locators:
 * one entry per <xpath expr> or direct locator, matched against the parent's
 * combined arch. Odoo's own composition silently drops a locator that matches
 * nothing, so "saved, and the view is on" does not prove a fix works; this does.
 */

export type LocatorStatus = 'ok' | 'dead' | 'ambiguous' | 'invalid';

export interface XpathLocator {
    kind: 'xpath' | 'direct';
    expr: string;
    position: string;
    status: LocatorStatus;
    /** How many nodes it matches; null when it is not valid XPath. */
    matches: number | null;
    /** lxml's sourceline: the 1-based line its start tag ends on. */
    line: number | null;
    /** Its element's index among the arch's elements, in document order (root 0). */
    element: number | null;
    /** Shorter locators that find the same node, shortest first. */
    shorter: string[];
    detail?: string;
}

export interface XpathSummary {
    ok: number;
    dead: number;
    ambiguous: number;
    invalid: number;
}

export interface XpathReport {
    locators: XpathLocator[];
    summary: XpathSummary;
    /** No dead and no invalid locator. */
    healthy: boolean;
    /** The arch could not be read as XML; nothing was checked. */
    error?: string;
}

const STATUSES: readonly LocatorStatus[] = ['ok', 'dead', 'ambiguous', 'invalid'];

function count(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseLocator(raw: unknown): XpathLocator {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const status = STATUSES.includes(entry.status as LocatorStatus) ? entry.status as LocatorStatus : 'invalid';
    const line = count(entry.line);
    return {
        kind: entry.kind === 'xpath' ? 'xpath' : 'direct',
        expr: typeof entry.expr === 'string' ? entry.expr : '',
        position: typeof entry.position === 'string' ? entry.position : 'inside',
        status,
        matches: count(entry.matches),
        line: line && line > 0 ? line : null,
        element: count(entry.element),
        shorter: Array.isArray(entry.shorter) ? entry.shorter.filter((value): value is string => typeof value === 'string') : [],
        ...(typeof entry.detail === 'string' ? { detail: entry.detail } : {})
    };
}

/** The checker's result; the counts are made again from the locators, so they always agree. */
export function parseXpathReport(raw: unknown): XpathReport {
    const value = (raw ?? {}) as Record<string, unknown>;
    const summary: XpathSummary = { ok: 0, dead: 0, ambiguous: 0, invalid: 0 };
    if (typeof value.error === 'string') {
        return { locators: [], summary, healthy: false, error: value.error };
    }
    const locators = Array.isArray(value.locators) ? value.locators.map(parseLocator) : [];
    for (const locator of locators) {
        summary[locator.status]++;
    }
    return { locators, summary, healthy: summary.dead === 0 && summary.invalid === 0 };
}

/** The locators that make a fix not work, as a clause ("2 locators match nothing"); undefined when there are none. */
export function brokenLocators(report: XpathReport): string | undefined {
    const { dead, invalid } = report.summary;
    const parts: string[] = [];
    if (dead > 0) {
        parts.push(`${dead} ${dead === 1 ? 'locator matches' : 'locators match'} nothing`);
    }
    if (invalid > 0) {
        parts.push(`${invalid} ${invalid === 1 ? 'locator is' : 'locators are'} not valid XPath`);
    }
    return parts.length > 0 ? parts.join(' and ') : undefined;
}

/** Check XPaths' one-line answer. */
export function checkResultText(report: XpathReport): { level: 'info' | 'warning'; text: string } {
    if (report.error) {
        return { level: 'warning', text: `Could not check the locators: ${report.error}` };
    }
    const total = report.locators.length;
    if (total === 0) {
        return { level: 'info', text: 'This view has no locators to check.' };
    }
    const { dead, ambiguous, invalid } = report.summary;
    if (dead === 0 && ambiguous === 0 && invalid === 0) {
        return { level: 'info', text: total === 1 ? 'The locator matches.' : `All ${total} locators match.` };
    }
    const parts: string[] = [];
    if (dead > 0) {
        parts.push(`${dead} ${dead === 1 ? 'matches' : 'match'} nothing`);
    }
    if (ambiguous > 0) {
        parts.push(`${ambiguous} ${ambiguous === 1 ? 'matches' : 'match'} several nodes`);
    }
    if (invalid > 0) {
        parts.push(`${invalid} ${invalid === 1 ? 'is' : 'are'} not valid XPath`);
    }
    return { level: 'warning', text: `Of ${total} locators, ${parts.join(', ')}.` };
}
```

- [ ] **Step 4: Add `checkXpaths` and `inheriting` to the service**

In `src/services/views/viewService.ts`:
- import: `import { parseXpathReport, type XpathReport } from './xpathReport';`
- in `SaveResult`, after `activationError`:

```ts
    /** The view has a parent, so it has locators to check. */
    inheriting?: boolean;
```

- after `deactivate`:

```ts
    /** Checks `arch` - the editor's text, not the stored arch - against the parent's combined arch. */
    async checkXpaths(dbName: string, viewId: number, arch: string): Promise<XpathReport> {
        return parseXpathReport(await this.pool.run<unknown>(dbName, 'check_xpaths', { view_id: viewId, arch }));
    }
```

- [ ] **Step 5: Add the worker command**

In `resources/scripts/view_worker.py`:
- Add to the imports (alphabetical with the stdlib ones): `import importlib.util` and, after `import psycopg2`, `from lxml import etree`.
- In `cmd_save`, return `inheriting` too:

```python
    return {'active': bool(view.active), 'activated': activated, 'activationError': activation_error,
            'inheriting': bool(view.inherit_id)}
```

- Add after `cmd_deactivate`:

```python
_XPATH_CHECK = []


def _xpath_check():
    """xpath_check.py, from the folder this file is in: compile() gave this
    code the script's path, which is how the worker finds what lies next to
    it. Loaded on first use, so a problem in it cannot stop the worker."""
    if not _XPATH_CHECK:
        folder = os.path.dirname(os.path.abspath(_xpath_check.__code__.co_filename))
        spec = importlib.util.spec_from_file_location('odt_xpath_check', os.path.join(folder, 'xpath_check.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _XPATH_CHECK.append(module)
    return _XPATH_CHECK[0]


def cmd_check_xpaths(env, view_id, arch):
    """Resolves every locator of `arch` - the editor's text for this view -
    against its parent's combined arch: the raw tree Odoo applies inheritance
    specs to, before get_view drops nodes by groups. The view and every view
    inheriting from it are switched off first, inside this request's
    transaction, which the worker always rolls back: the baseline is the parent
    as it would be without them, whether the view is on or off. Later siblings
    stay in - the same approximation odoo-manager makes. Nothing is committed
    or signalled."""
    view = _view(env, view_id)
    parent = view.inherit_id
    if not parent:
        raise Refused('Not an inheriting view: it has no locators to check.')
    env.cr.execute("""
        WITH RECURSIVE tree AS (
            SELECT id, 0 AS depth FROM ir_ui_view WHERE id = %s
            UNION ALL
            SELECT v.id, t.depth + 1 FROM ir_ui_view v JOIN tree t ON v.inherit_id = t.id WHERE t.depth < 50
        )
        UPDATE ir_ui_view SET active = false WHERE id IN (SELECT id FROM tree)
    """, [view.id])
    _invalidate(env)
    parent_arch = etree.tostring(parent._get_combined_arch(), encoding='unicode')
    return _xpath_check().check(arch, parent_arch)
```

- Add `'check_xpaths': cmd_check_xpaths,` to `COMMANDS` after `'deactivate'`.

- [ ] **Step 6: Run the unit tests**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "XPath report|View service"`
Expected: PASS. `git checkout -- dist`.

- [ ] **Step 7: Add the gated integration tests**

In `src/test/viewWorker.integration.test.ts`:

1. The save result now has `inheriting`. Update the two `deepStrictEqual`s on `service.save` results to include it (the setup view inherits `base.view_partner_form`): e.g. in "a fixed arch saves…" `{ active: true, activated: true, activationError: null, inheriting: true }`; do the same for any other `deepStrictEqual` on a save result in the file (grep `service.save(`).

2. Add after the constants at the top:

```ts
/** A parent of our own, so every locator below has one known answer. */
const XPATH_SETUP = `
parent = env['ir.ui.view'].create({
    'name': 'odt.xpath.parent', 'type': 'form', 'model': 'res.partner', 'mode': 'primary', 'priority': 99,
    'arch': '<form><sheet><field name="name"/><field name="ref"/><field name="child_ids"><form><field name="name"/></form></field></sheet></form>',
})
child = env['ir.ui.view'].create({
    'name': 'odt.xpath.child', 'type': 'form', 'model': 'res.partner', 'inherit_id': parent.id, 'mode': 'extension', 'active': False,
    'arch': '<data><xpath expr="//field[@name=\\'ref\\']" position="after"><field name="email"/></xpath></data>',
})
env.cr.commit()
print('ODT_XPATH_IDS:%d:%d' % (parent.id, child.id))
`;

/**
 * What is checked: ok, dead, ambiguous (Studio's //form[1] also matches the
 * inline one2many form), and a direct locator on the field only the stored
 * child itself adds - dead against the baseline, ok if the child leaked in.
 */
const CHECKED_ARCH = `<data>
    <xpath expr="//field[@name='ref']" position="after">
        <field name="email"/>
    </xpath>
    <xpath expr="//field[@name='odt_nope']" position="after">
        <field name="phone"/>
    </xpath>
    <xpath expr="//form[1]//field[@name='name']" position="attributes">
        <attribute name="string">Label</attribute>
    </xpath>
    <field name="email" position="after">
        <field name="website"/>
    </field>
</data>`;
```

3. Add a test before "dropping the database ends another window's shell on it too" (that one must stay last):

```ts
    test('check_xpaths resolves the editor\'s locators against the parent without the view, on or off, and commits nothing', async () => {
        const { stdout } = await runCommand(python!, [`${odoo}/odoo-bin`, 'shell', '--no-http', '--addons-path', addonsPaths.join(','), '-d', copy], { input: XPATH_SETUP });
        const [, parentId, childId] = (/ODT_XPATH_IDS:(\d+):(\d+)/.exec(stdout) ?? []).map(Number);
        assert.ok(childId > 0, `setup printed no ids:\n${stdout}`);
        const statuses = (report: Awaited<ReturnType<ViewService['checkXpaths']>>) =>
            report.locators.map(locator => [locator.kind, locator.status, locator.matches, locator.line, locator.element]);
        const expected = [
            ['xpath', 'ok', 1, 2, 1],
            ['xpath', 'dead', 0, 5, 3],
            ['xpath', 'ambiguous', 2, 8, 5],
            ['direct', 'dead', 0, 11, 7]
        ];

        assert.deepStrictEqual(statuses(await service.checkXpaths(copy, childId, CHECKED_ARCH)), expected);
        assert.strictEqual(await runSql(copy, `SELECT active FROM ir_ui_view WHERE id = ${childId};`), 'f');

        // On, with its stored patch adding email: still left out of the baseline.
        await runSql(copy, `UPDATE ir_ui_view SET active = true WHERE id = ${childId};`);
        assert.deepStrictEqual(statuses(await service.checkXpaths(copy, childId, CHECKED_ARCH)), expected);
        assert.strictEqual(await runSql(copy, `SELECT active FROM ir_ui_view WHERE id = ${childId};`), 't', 'the check left the view off');

        await assert.rejects(service.checkXpaths(copy, parentId, '<form/>'), /Not an inheriting view/);
    });
```

- [ ] **Step 8: Run the integration test on one version**

Build a base DB if none exists (stage 1 handover §5; takes a few minutes):

```bash
v=19; /home/odoo/odoo-dev/venv-$v.0/bin/python /home/odoo/odoo-dev/odoo-$v.0/odoo-bin \
  --addons-path=/home/odoo/odoo-dev/odoo-$v.0/odoo/addons,/home/odoo/odoo-dev/odoo-$v.0/addons \
  -d odt_view_base_$v -i base --stop-after-init --without-demo=all --log-level=warn
```

Then (outside the sandbox):

```bash
npm run compile-tests && ODT_VIEW_TEST_PYTHON=/home/odoo/odoo-dev/venv-19.0/bin/python ODT_VIEW_TEST_ODOO=/home/odoo/odoo-dev/odoo-19.0 \
  ODT_VIEW_TEST_DB=odt_view_base_19 env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View worker against a real Odoo"
```

Expected: all passing, including the new test. If a `line`/`element` differs, recount against `CHECKED_ARCH` (line 1 is `<data>`; lxml reports the line where the start tag ends) — fix the expectation only if the recount agrees. Leave `odt_view_base_19` for later tasks (Task 10 drops it). `git checkout -- dist`.

- [ ] **Step 9: Commit**

```bash
git add resources/scripts/view_worker.py src/services/views/xpathReport.ts src/services/views/viewService.ts src/test/xpathReport.test.ts src/test/viewService.test.ts src/test/viewWorker.integration.test.ts
git commit -m "[ADD] Check a view's locators in its database's Odoo shell

check_xpaths runs the ported checker on the editor's text against the
parent's combined arch, with the view and its descendants switched off
inside the request's transaction, which the worker rolls back: the answer
is the same whether the view is on or off, and nothing is committed. A save
now also says whether the view inherits, so the editor knows when to check.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Map a check onto the arch's text

**Files:**
- Create: `src/views/xpathDiagnostics.ts` (pure part)
- Test: `src/test/xpathDiagnostics.test.ts` (new)

**Interfaces:**
- Consumes: `XpathReport`, `XpathLocator`, `LocatorStatus` (Task 2).
- Produces (all exported from `src/views/xpathDiagnostics.ts`):
  ```ts
  export interface TextSpan { start: number; end: number }   // offsets into the text, end exclusive
  export interface ArchAttribute { name: string; valueStart: number; valueEnd: number; quote: '"' | "'" }
  export interface ArchElement { tag: string; nameStart: number; nameEnd: number; attributes: ArchAttribute[] }
  export interface XpathFix { title: string; span: TextSpan; text: string }
  export type FindingSeverity = 'error' | 'warning' | 'hint';
  export interface XpathFinding { status: LocatorStatus; severity: FindingSeverity; message: string; span: TextSpan; fixes: XpathFix[] }
  export function blankNonElements(text: string): string
  export function scanElements(text: string): ArchElement[]
  export function positionAt(text: string, offset: number): { line: number; character: number }
  export function quoteForAttribute(value: string, quote: '"' | "'"): string
  export function xpathFindings(report: XpathReport, text: string): XpathFinding[]
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/test/xpathDiagnostics.test.ts`:

```ts
import * as assert from 'assert';
import { parseXpathReport, type XpathReport } from '../services/views/xpathReport';
import { positionAt, quoteForAttribute, scanElements, xpathFindings } from '../views/xpathDiagnostics';

function report(locators: Array<Record<string, unknown>>): XpathReport {
    return parseXpathReport({ locators: locators.map(entry => ({ kind: 'xpath', position: 'after', matches: 1, shorter: [], line: 1, ...entry })) });
}

const slice = (text: string, span: { start: number; end: number }) => text.slice(span.start, span.end);

suite('XPath diagnostics: placing a check on the text', () => {
    test('a minified arch: each locator lands on its own expr', () => {
        const text = '<data><xpath expr="//a" position="after"/><xpath expr="//b" position="after"/></data>';
        const findings = xpathFindings(report([
            { expr: '//a', status: 'dead', matches: 0, element: 1 },
            { expr: '//b', status: 'ambiguous', matches: 2, element: 2 }
        ]), text);
        assert.deepStrictEqual(findings.map(finding => slice(text, finding.span)), ['//a', '//b']);
    });

    test('comments, CDATA, a declaration and processing instructions are not elements', () => {
        const text = '<?xml version="1.0"?>\r\n<data>\r\n  <!-- <xpath expr="//zzz"/> -->\r\n  <![CDATA[<xpath expr="//yyy"/>]]>\r\n  <?pi x?>\r\n  <xpath expr="//a"/>\r\n</data>';
        const [finding] = xpathFindings(report([{ expr: '//a', status: 'dead', matches: 0, element: 1, line: 6 }]), text);
        assert.strictEqual(slice(text, finding.span), '//a');
        assert.deepStrictEqual(positionAt(text, finding.span.start), { line: 5, character: 15 });
        assert.deepStrictEqual(scanElements(text).map(element => element.tag), ['data', 'xpath']);
    });

    test('a start tag over several lines, with > inside a value', () => {
        const text = '<data>\n  <xpath\n     expr="//a[@x > 1]"\n     position="after">\n  </xpath>\n</data>';
        const [finding] = xpathFindings(report([{ expr: '//a[@x > 1]', status: 'dead', matches: 0, element: 1, line: 4 }]), text);
        assert.strictEqual(slice(text, finding.span), '//a[@x > 1]');
    });

    test('a direct locator points at its tag name', () => {
        const text = '<data><field name="b" position="before"/></data>';
        const [finding] = xpathFindings(report([{ kind: 'direct', expr: "//field[@name='b']", status: 'dead', matches: 0, element: 1 }]), text);
        assert.strictEqual(slice(text, finding.span), 'field');
        assert.deepStrictEqual(finding.fixes, []);
    });

    test('an element index that names another tag falls back to the line, trimmed', () => {
        const text = '<data>\n    <group name="g"/>\n</data>';
        const [finding] = xpathFindings(report([{ expr: '//g', status: 'dead', matches: 0, element: 1, line: 2 }]), text);
        assert.strictEqual(slice(text, finding.span), '<group name="g"/>');
    });

    test('severities, messages and fixes per status', () => {
        const text = '<data><xpath expr="//a"/><xpath expr="//b"/><xpath expr="//c["/><xpath expr="/form/sheet/field"/><xpath expr="//e"/></data>';
        const findings = xpathFindings(report([
            { expr: '//a', status: 'dead', matches: 0, element: 1 },
            { expr: '//b', status: 'ambiguous', matches: 3, element: 2, shorter: ["//b[@name='x']"] },
            { expr: '//c[', status: 'invalid', matches: null, element: 3, detail: 'Invalid expression' },
            { expr: '/form/sheet/field', status: 'ok', matches: 1, element: 4, shorter: ["//field[@name='x']", "//sheet/field"] },
            { expr: '//e', status: 'ok', matches: 1, element: 5 }
        ]), text);
        assert.deepStrictEqual(findings.map(finding => [finding.status, finding.severity, finding.message]), [
            ['dead', 'warning', '//a matches nothing: this patch does nothing.'],
            ['ambiguous', 'warning', '//b matches 3 nodes: Odoo patches the first.'],
            ['invalid', 'error', '//c[ is not a valid XPath: Invalid expression'],
            ['ok', 'hint', "A shorter locator finds the same node: //field[@name='x']"]
        ]);
        assert.deepStrictEqual(findings[1].fixes.map(fix => [fix.title, fix.text, slice(text, fix.span)]), [["Use //b[@name='x']", "//b[@name='x']", '//b']]);
        assert.deepStrictEqual(findings[3].fixes.map(fix => fix.title), ["Use //field[@name='x']", 'Use //sheet/field']);
        assert.deepStrictEqual(findings[0].fixes, []);
    });

    test('a fix is escaped for the quote the attribute uses', () => {
        const text = `<data><xpath expr='//field[@name="x"]/..' position="after"/></data>`;
        const [finding] = xpathFindings(report([{ expr: '//field[@name="x"]/..', status: 'ambiguous', matches: 2, element: 1, shorter: ["//group[@name='g']"] }]), text);
        assert.strictEqual(finding.fixes[0].text, '//group[@name=&apos;g&apos;]');
        assert.strictEqual(quoteForAttribute(`//a[@b="c" and @d='e'] & <`, '"'), `//a[@b=&quot;c&quot; and @d='e'] &amp; &lt;`);
    });

    test('nothing to place when the arch was not XML', () => {
        assert.deepStrictEqual(xpathFindings(parseXpathReport({ error: 'child arch is not valid XML: x' }), '<data'), []);
    });

    test('positions count \\r\\n, \\r and \\n as one line break each, like VS Code', () => {
        const text = 'a\r\nb\rc\nd';
        assert.deepStrictEqual(positionAt(text, text.indexOf('d')), { line: 3, character: 0 });
        assert.deepStrictEqual(positionAt(text, text.indexOf('c')), { line: 2, character: 0 });
        assert.deepStrictEqual(positionAt(text, 1), { line: 0, character: 1 });
    });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run compile-tests` — Expected: tsc error, `../views/xpathDiagnostics` not found.

- [ ] **Step 3: Write the pure module**

Create `src/views/xpathDiagnostics.ts`:

```ts
/**
 * An XPath check (xpathReport.ts) placed on the arch's text: which characters
 * each locator's diagnostic covers, its severity and message, and the quick
 * fixes that swap a locator for a shorter one that finds the same node.
 *
 * A locator is found by its element's index among the arch's elements, not by
 * line: lxml reports the line where a start tag *ends*, and a minified arch
 * has every locator on one line. The text is scanned for start tags with
 * comments, CDATA, processing instructions and the DOCTYPE blanked out, which
 * is also what lxml leaves out of the count.
 */
import type { LocatorStatus, XpathLocator, XpathReport } from '../services/views/xpathReport';

/** Offsets into the text; end exclusive. */
export interface TextSpan {
    start: number;
    end: number;
}

export interface ArchAttribute {
    name: string;
    /** The value between the quotes. */
    valueStart: number;
    valueEnd: number;
    quote: '"' | "'";
}

export interface ArchElement {
    tag: string;
    nameStart: number;
    nameEnd: number;
    attributes: ArchAttribute[];
}

export interface XpathFix {
    title: string;
    span: TextSpan;
    /** Already escaped for the attribute's quote. */
    text: string;
}

export type FindingSeverity = 'error' | 'warning' | 'hint';

export interface XpathFinding {
    status: LocatorStatus;
    severity: FindingSeverity;
    message: string;
    span: TextSpan;
    /** Shortest first; only for <xpath expr> locators that match. */
    fixes: XpathFix[];
}

const NON_ELEMENTS = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>/gi;
const START_TAG = /<([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** The text with everything that is not markup of elements replaced by spaces, offset for offset (line breaks kept). */
export function blankNonElements(text: string): string {
    return text.replace(NON_ELEMENTS, match => match.replace(/[^\r\n]/g, ' '));
}

/** The arch's start tags, in document order. */
export function scanElements(text: string): ArchElement[] {
    const elements: ArchElement[] = [];
    for (const tag of blankNonElements(text).matchAll(START_TAG)) {
        const nameStart = (tag.index ?? 0) + 1;
        const nameEnd = nameStart + tag[1].length;
        const attributes: ArchAttribute[] = [];
        for (const attribute of tag[2].matchAll(ATTRIBUTE)) {
            const value = attribute[2] ?? attribute[3] ?? '';
            // The closing quote; the attribute text starts right after the tag name.
            const valueEnd = nameEnd + (attribute.index ?? 0) + attribute[0].length - 1;
            attributes.push({ name: attribute[1], valueStart: valueEnd - value.length, valueEnd, quote: attribute[2] !== undefined ? '"' : "'" });
        }
        elements.push({ tag: tag[1], nameStart, nameEnd, attributes });
    }
    return elements;
}

function lineStarts(text: string): number[] {
    const starts = [0];
    for (const lineBreak of text.matchAll(/\r\n|\r|\n/g)) {
        starts.push((lineBreak.index ?? 0) + lineBreak[0].length);
    }
    return starts;
}

/** A 0-based line and character, counting line breaks the way VS Code does. */
export function positionAt(text: string, offset: number): { line: number; character: number } {
    const starts = lineStarts(text);
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= offset) {
        line++;
    }
    return { line, character: offset - starts[line] };
}

/** A 1-based line's content without its indentation and line break. */
function lineSpan(text: string, line: number): TextSpan {
    const starts = lineStarts(text);
    const index = Math.min(Math.max(line - 1, 0), starts.length - 1);
    const start = starts[index];
    const content = text.slice(start, index + 1 < starts.length ? starts[index + 1] : text.length).replace(/[\r\n]+$/, '');
    const indent = content.length - content.trimStart().length;
    return { start: start + indent, end: start + content.length };
}

/** `value` as the content of an attribute delimited by `quote`. */
export function quoteForAttribute(value: string, quote: '"' | "'"): string {
    const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return quote === '"' ? escaped.replace(/"/g, '&quot;') : escaped.replace(/'/g, '&apos;');
}

function place(locator: XpathLocator, elements: ArchElement[], text: string): { span: TextSpan; expr?: ArchAttribute } {
    const element = locator.element === null ? undefined : elements[locator.element];
    const expected = locator.kind === 'xpath' ? 'xpath' : /^\/\/([^[/]+)/.exec(locator.expr)?.[1];
    if (element && element.tag === expected) {
        const expr = locator.kind === 'xpath' ? element.attributes.find(attribute => attribute.name === 'expr') : undefined;
        if (expr) {
            return { span: { start: expr.valueStart, end: expr.valueEnd }, expr };
        }
        return { span: { start: element.nameStart, end: element.nameEnd } };
    }
    return { span: lineSpan(text, locator.line ?? 1) };
}

/** What to show for each locator worth showing: dead, ambiguous, invalid, or ok with a shorter equivalent. */
export function xpathFindings(report: XpathReport, text: string): XpathFinding[] {
    if (report.error) {
        return [];
    }
    const elements = scanElements(text);
    const findings: XpathFinding[] = [];
    for (const locator of report.locators) {
        const where = place(locator, elements, text);
        const expr = where.expr;
        const fixes: XpathFix[] = expr && (locator.status === 'ok' || locator.status === 'ambiguous')
            ? locator.shorter.map(shorter => ({ title: `Use ${shorter}`, span: where.span, text: quoteForAttribute(shorter, expr.quote) }))
            : [];
        const finding = (severity: FindingSeverity, message: string): XpathFinding =>
            ({ status: locator.status, severity, message, span: where.span, fixes });
        switch (locator.status) {
            case 'dead':
                findings.push(finding('warning', `${locator.expr} matches nothing: this patch does nothing.`));
                break;
            case 'ambiguous':
                findings.push(finding('warning', `${locator.expr} matches ${locator.matches ?? 'several'} nodes: Odoo patches the first.`));
                break;
            case 'invalid':
                findings.push(finding('error', `${locator.expr} is not a valid XPath${locator.detail ? `: ${locator.detail}` : '.'}`));
                break;
            case 'ok':
                // Faint on purpose: Studio's long paths work, they only read badly.
                if (fixes.length > 0) {
                    findings.push(finding('hint', `A shorter locator finds the same node: ${locator.shorter[0]}`));
                }
                break;
        }
    }
    return findings;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "XPath diagnostics"`
Expected: PASS (9 tests). Fix the implementation, not the expectations, unless an expectation miscounts offsets. `git checkout -- dist`.

- [ ] **Step 5: Commit**

```bash
git add src/views/xpathDiagnostics.ts src/test/xpathDiagnostics.test.ts
git commit -m "[ADD] Place an XPath check on the arch's characters

Each locator is found by its element's index among the arch's start tags,
not by line: lxml gives the line a start tag ends on, and a minified arch
has every locator on one line. Comments, CDATA and processing instructions
are blanked out first, as lxml does not count them. Dead and ambiguous
locators are warnings, invalid ones errors, and a long one that works is a
faint hint; fixes swap in a shorter locator, escaped for the attribute's
quote.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: One target resolver; Open Root; editor-title actions

**Files:**
- Create: `src/views/viewTarget.ts`
- Modify: `src/views/viewDoctorView.ts` (contextValue `deep`)
- Modify: `src/commands/viewDoctorCommands.ts` (openParent, compare, render, addToScript via `viewTarget`; new openRoot)
- Modify: `package.json` (command, row menu, `editor/title`, palette)
- Test: `src/test/viewTarget.test.ts` (new), `src/test/viewDoctorView.test.ts`

**Interfaces:**
- Consumes: `ViewItem` (`dbName`, `view`), `parseViewUri`, `VIEW_SCHEME`, `ViewService.rows`.
- Produces:
  ```ts
  // src/views/viewTarget.ts
  export interface ViewTarget { dbName: string; view: ViewRow }
  export type ReadRows = (dbName: string, ids: number[]) => Promise<ViewRow[]>;
  export function viewTarget(arg: unknown, readRows: ReadRows, activeUri?: () => vscode.Uri | undefined): Promise<ViewTarget | undefined>
  ```
  - Row contextValue: `odooView.{active|inactive}.{hasParent|root}[.deep][.noXmlid]`; `deep` when the view has a parent and its root is not that parent.
  - Command `viewDoctor.openRoot`.
  - In `viewDoctorCommands.ts`, a local helper later tasks reuse: `async function target(arg: unknown): Promise<ViewTarget | undefined>` (shows the error and returns undefined when the URI's view is gone), and `openArch(dbName, viewId, xmlid)` (exists).

- [ ] **Step 1: Write the failing tests**

Create `src/test/viewTarget.test.ts`:

```ts
import * as assert from 'assert';
import * as vscode from 'vscode';
import { ViewItem } from '../views/viewDoctorView';
import { viewTarget } from '../views/viewTarget';
import { viewUri } from '../views/viewFileSystem';
import type { ViewRow } from '../services/views/viewQueries';

const row: ViewRow = { id: 12, name: 'Partner patch', model: 'res.partner', type: 'form', active: false, inheritId: 7, xmlid: 'acme.patch', rootId: 3, isReport: false, writeDate: 0 };

suite('View target', () => {
    test('a tree row is used as is', async () => {
        const reads: number[] = [];
        const target = await viewTarget(new ViewItem('shop', row, 'other'), async (_db, ids) => { reads.push(...ids); return []; });
        assert.deepStrictEqual(target, { dbName: 'shop', view: row });
        assert.deepStrictEqual(reads, [], 'a row needs no query');
    });

    test('an odoo-view URI, as an editor title passes it, is read from its database', async () => {
        const target = await viewTarget(viewUri('shop 18', 12, 'acme.patch'), async (db, ids) => db === 'shop 18' && ids[0] === 12 ? [row] : []);
        assert.deepStrictEqual(target, { dbName: 'shop 18', view: row });
    });

    test('with nothing passed, the active editor\'s view', async () => {
        const target = await viewTarget(undefined, async () => [row], () => viewUri('shop', 12, 'x'));
        assert.strictEqual(target?.view.id, 12);
        assert.strictEqual(await viewTarget(undefined, async () => [row], () => vscode.Uri.file('/tmp/a.xml')), undefined);
        assert.strictEqual(await viewTarget(undefined, async () => [row], () => undefined), undefined);
    });

    test('a view that is gone says so', async () => {
        await assert.rejects(viewTarget(viewUri('shop', 99, 'x'), async () => []), /View 99 no longer exists in shop\./);
    });
});
```

In `src/test/viewDoctorView.test.ts`:
- Replace the four `offered(...)` assertions of the menu-wiring test with:

```ts
        assert.deepStrictEqual(offered('odooView.inactive.hasParent'), ['openArch', 'openParent', 'compare', 'render', 'activate', 'copyXmlid']);
        assert.deepStrictEqual(offered('odooView.inactive.hasParent.deep'), ['openArch', 'openParent', 'openRoot', 'compare', 'render', 'activate', 'copyXmlid']);
        assert.deepStrictEqual(offered('odooView.active.hasParent.deep.noXmlid'), ['openArch', 'openParent', 'openRoot', 'compare', 'render', 'addToScript', 'deactivate']);
        assert.deepStrictEqual(offered('odooView.inactive.root.noXmlid'), ['openArch', 'compare', 'render', 'activate']);
        assert.deepStrictEqual(offered('odooView.active.root'), ['openArch', 'compare', 'render', 'copyXmlid', 'addToScript', 'deactivate']);
```

- Add these tests to the same suite (it already imports `fs`, `path`, `vscode` and has a `ViewRow` fixture; reuse its helpers or this literal):

```ts
    test('a row whose root is not its parent says so, for Open Root', () => {
        const base = { id: 9, name: 'Deep', model: 'res.partner', type: 'form', active: false, xmlid: 'acme.deep', isReport: false, writeDate: 0 };
        assert.strictEqual(new ViewItem('shop', { ...base, inheritId: 5, rootId: 3 }, 'other').contextValue, 'odooView.inactive.hasParent.deep');
        assert.strictEqual(new ViewItem('shop', { ...base, inheritId: 3, rootId: 3 }, 'other').contextValue, 'odooView.inactive.hasParent');
        assert.strictEqual(new ViewItem('shop', { ...base, inheritId: 5, rootId: 3, xmlid: null }, 'other').contextValue, 'odooView.inactive.hasParent.deep.noXmlid');
    });

    test('an arch editor\'s title offers the row actions, only for odoo-view files', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
        const title = (manifest.contributes.menus['editor/title'] as Array<{ command: string; when?: string; group?: string }>)
            .filter(entry => entry.command.startsWith('viewDoctor.'));
        assert.ok(title.every(entry => entry.when === 'resourceScheme == odoo-view'), JSON.stringify(title));
        assert.deepStrictEqual(title.filter(entry => entry.group?.startsWith('navigation')).map(entry => entry.command),
            ['viewDoctor.compare', 'viewDoctor.render']);
        assert.deepStrictEqual(title.filter(entry => !entry.group?.startsWith('navigation')).map(entry => entry.command),
            ['viewDoctor.openParent', 'viewDoctor.openRoot', 'viewDoctor.addToScript']);
        assert.ok(!title.some(entry => /activate|deactivate|copyXmlid|openArch/.test(entry.command)), 'tree-only actions leaked into the editor title');
    });
```

(If `ViewItem` is not yet imported in that test file, add it to the existing import from `../views/viewDoctorView`.)

- [ ] **Step 2: Run them to see them fail**

Run: `npm run compile-tests` — Expected: tsc error, `../views/viewTarget` not found.

- [ ] **Step 3: Write the resolver**

Create `src/views/viewTarget.ts`:

```ts
/**
 * What a View Doctor command acts on. From the Views tree it gets the row;
 * from an arch editor's title it gets the editor's odoo-view: URI; from the
 * Command Palette it gets nothing, and the active editor's view is used. All
 * three come out the same, so every command works from either place.
 */
import * as vscode from 'vscode';
import type { ViewRow } from '../services/views/viewQueries';
import { ViewItem } from './viewDoctorView';
import { VIEW_SCHEME, parseViewUri } from './viewFileSystem';

export interface ViewTarget {
    dbName: string;
    view: ViewRow;
}

export type ReadRows = (dbName: string, ids: number[]) => Promise<ViewRow[]>;

/** Undefined when the argument and the active editor are no view; throws when the URI's view is gone. */
export async function viewTarget(
    arg: unknown,
    readRows: ReadRows,
    activeUri: () => vscode.Uri | undefined = () => vscode.window.activeTextEditor?.document.uri
): Promise<ViewTarget | undefined> {
    if (arg instanceof ViewItem) {
        return { dbName: arg.dbName, view: arg.view };
    }
    const uri = arg instanceof vscode.Uri ? arg : activeUri();
    const ref = uri?.scheme === VIEW_SCHEME ? parseViewUri(uri) : undefined;
    if (!ref) {
        return undefined;
    }
    const [view] = await readRows(ref.dbName, [ref.viewId]);
    if (!view) {
        throw new Error(`View ${ref.viewId} no longer exists in ${ref.dbName}.`);
    }
    return { dbName: ref.dbName, view };
}
```

- [ ] **Step 4: Add `deep` to the row**

In `src/views/viewDoctorView.ts`, `ViewItem`'s contextValue becomes:

```ts
        this.contextValue = [
            'odooView',
            view.active ? 'active' : 'inactive',
            view.inheritId ? 'hasParent' : 'root',
            // Its root is further up than its parent: Open Root has somewhere else to go.
            ...(view.inheritId && view.rootId !== view.inheritId ? ['deep'] : []),
            ...(view.xmlid ? [] : ['noXmlid'])
        ].join('.');
```

- [ ] **Step 5: Move the commands onto `viewTarget`, add Open Root**

In `src/commands/viewDoctorCommands.ts`:
- imports: add `import { viewTarget, type ViewTarget } from '../views/viewTarget';`
- inside `registerViewDoctorCommands`, after the destructuring line, add:

```ts
    /** The view a command acts on (a row, an arch editor, or the active editor); the error is shown when it is gone. */
    const target = async (arg: unknown): Promise<ViewTarget | undefined> => {
        try {
            return await viewTarget(arg, (dbName, ids) => viewService.rows(dbName, ids));
        } catch (error) {
            void showError(errorMessage(error));
            return undefined;
        }
    };
```

- `viewDoctor.openParent` becomes:

```ts
    context.subscriptions.push(registerCommand('viewDoctor.openParent', async (arg: unknown) => {
        const item = await target(arg);
        if (!item) {
            return;
        }
        if (!item.view.inheritId) {
            void showInfo(`${item.view.name} inherits no view.`);
            return;
        }
        const [parent] = await viewService.rows(item.dbName, [item.view.inheritId]);
        await openArch(item.dbName, item.view.inheritId, parent?.xmlid ?? null);
    }));

    context.subscriptions.push(registerCommand('viewDoctor.openRoot', async (arg: unknown) => {
        const item = await target(arg);
        if (!item) {
            return;
        }
        if (item.view.rootId === item.view.id) {
            void showInfo(`${item.view.name} is a root view.`);
            return;
        }
        const [root] = await viewService.rows(item.dbName, [item.view.rootId]);
        await openArch(item.dbName, item.view.rootId, root?.xmlid ?? null);
    }));
```

- In `viewDoctor.compare`, `viewDoctor.render` and `viewDoctor.addToScript`, replace `const item = viewItem(arg);` with `const item = await target(arg);`. Nothing else in their bodies changes (`item.dbName` / `item.view` keep their meaning; `compareTargets(project, item)` takes `{ dbName }`).
- `viewItem()` stays for openArch, activate, deactivate and copyXmlid (tree only, spec rule 14).

- [ ] **Step 6: Wire `package.json`**

- `contributes.commands`, after `viewDoctor.openParent`:
  `{ "command": "viewDoctor.openRoot", "title": "Open Root View", "category": "Odoo DevTools" },`
- `view/item/context`: renumber and add (keep the one-line style of the neighbours):

```json
        { "command": "viewDoctor.openParent", "when": "view == viewDoctor && viewItem =~ /\\.hasParent(\\.|$)/", "group": "1_open@2" },
        { "command": "viewDoctor.openRoot", "when": "view == viewDoctor && viewItem =~ /\\.deep(\\.|$)/", "group": "1_open@3" },
        { "command": "viewDoctor.compare", "when": "view == viewDoctor && viewItem =~ /^odooView\\./", "group": "1_open@5" },
        { "command": "viewDoctor.render", "when": "view == viewDoctor && viewItem =~ /^odooView\\./", "group": "1_open@6" },
```

  and change Copy External ID's clause (the old one matched exactly three parts, which `deep` would break):

```json
        { "command": "viewDoctor.copyXmlid", "when": "view == viewDoctor && viewItem =~ /^odooView\\.\\w+\\.\\w+(\\.deep)?$/", "group": "3_copy@1" },
```

  Keep the array order openArch, openParent, openRoot, compare, render, activate, copyXmlid, addToScript, deactivate (the test reads it in file order).
- Add a new `"editor/title"` menu array (next to `"editor/context"`):

```json
      "editor/title": [
        { "command": "viewDoctor.compare", "when": "resourceScheme == odoo-view", "group": "navigation@1" },
        { "command": "viewDoctor.render", "when": "resourceScheme == odoo-view", "group": "navigation@2" },
        { "command": "viewDoctor.openParent", "when": "resourceScheme == odoo-view", "group": "1_view@1" },
        { "command": "viewDoctor.openRoot", "when": "resourceScheme == odoo-view", "group": "1_view@2" },
        { "command": "viewDoctor.addToScript", "when": "resourceScheme == odoo-view", "group": "2_script@1" }
      ],
```

- `commandPalette`: change `openParent`, `compare`, `render`, `addToScript` from `"when": "false"` to `"when": "resourceScheme == odoo-view"`, and add `{ "command": "viewDoctor.openRoot", "when": "resourceScheme == odoo-view" },`.

- [ ] **Step 7: Run the tests**

Run: `npx tsc -p . --noEmit && npm run lint && npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View target|Views tree|View Doctor"`
Expected: PASS (use the suite names actually printed by mocha if the grep misses one). `git checkout -- dist`.

- [ ] **Step 8: Commit**

```bash
git add src/views/viewTarget.ts src/views/viewDoctorView.ts src/commands/viewDoctorCommands.ts package.json src/test/viewTarget.test.ts src/test/viewDoctorView.test.ts
git commit -m "[ADD] Open a view's root, and act on a view from its editor

Compare with Original, Render, Open Parent and Add to Upgrade Script now
also work from an arch editor's title and the Command Palette, so a view
opened from anywhere is not a dead end: one resolver turns a tree row, an
odoo-view: URI or the active editor into the same view. Open Root View
shows on rows whose root is further up than their parent.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: XPath diagnostics in the editor: on save, on demand, with quick fixes

**Files:**
- Modify: `src/views/xpathDiagnostics.ts` (append the `XpathDiagnostics` class)
- Create: `src/views/viewSaveHook.ts`
- Modify: `src/extension.ts` (collection, code actions, close handler, save hook)
- Modify: `src/commands/index.ts` (`CommandDeps.xpathDiagnostics`)
- Modify: `src/commands/viewDoctorCommands.ts` (`viewDoctor.checkXpaths`)
- Modify: `package.json` (command, row menu, editor title, palette, setting)
- Test: `src/test/xpathDiagnostics.test.ts`, `src/test/viewSaveHook.test.ts` (new), `src/test/viewDoctorView.test.ts`

**Interfaces:**
- Consumes: `xpathFindings`, `positionAt`, `XpathFinding` (Task 3); `XpathReport`, `brokenLocators`, `checkResultText` (Task 2); `ViewService.checkXpaths`, `SaveResult.inheriting` (Task 2); `target()` helper in commands (Task 4); `archErrorSummary`, `locateArchError`, `readableArchError` (`src/services/views/archErrors.ts`).
- Produces:
  ```ts
  // src/views/xpathDiagnostics.ts
  export const XPATH_SOURCE = 'Odoo XPath';
  export class XpathDiagnostics implements vscode.CodeActionProvider, vscode.Disposable {
      static readonly providedCodeActionKinds: vscode.CodeActionKind[];
      readonly collection: vscode.DiagnosticCollection;
      constructor(collection?: vscode.DiagnosticCollection);
      show(uri: vscode.Uri, text: string, report: XpathReport): void;
      clear(uri: vscode.Uri): void;
      provideCodeActions(document: Pick<vscode.TextDocument, 'uri' | 'getText'>, range: vscode.Range): vscode.CodeAction[];
      dispose(): void;
  }
  // src/views/viewSaveHook.ts
  export interface SaveHookDeps { ... }   // below
  export function saveMessage(result: SaveResult, report?: XpathReport): { warning: boolean; text: string }
  export function createSaveHook(deps: SaveHookDeps): (ref: ViewRef, result: SaveResult, uri: vscode.Uri, text: string) => Promise<void>
  ```
  - `CommandDeps.xpathDiagnostics: XpathDiagnostics`.
  - Setting `odooDebugger.views.checkXpathsOnSave` (boolean, default `true`).
  - Command `viewDoctor.checkXpaths`.

- [ ] **Step 1: Write the failing tests**

Append to `src/test/xpathDiagnostics.test.ts` (add `import * as vscode from 'vscode';` and `XpathDiagnostics` to the imports):

```ts
suite('XPath diagnostics in the editor', () => {
    const uri = vscode.Uri.parse('odoo-view:/shop/12/acme.patch.xml');
    const text = '<data><xpath expr="//a"/><xpath expr="/form/sheet/field"/></data>';
    const checked = report([
        { expr: '//a', status: 'dead', matches: 0, element: 1 },
        { expr: '/form/sheet/field', status: 'ok', matches: 1, element: 2, shorter: ["//field[@name='x']"] }
    ]);

    test('shows each finding with its severity, on its characters, from its own source', () => {
        const diagnostics = new XpathDiagnostics(vscode.languages.createDiagnosticCollection('odoo-view-xpaths-test'));
        try {
            diagnostics.show(uri, text, checked);
            const shown = diagnostics.collection.get(uri) ?? [];
            assert.deepStrictEqual(shown.map(diagnostic => [diagnostic.severity, diagnostic.source, diagnostic.code, diagnostic.range.start.character, diagnostic.range.end.character]), [
                [vscode.DiagnosticSeverity.Warning, 'Odoo XPath', 'dead', text.indexOf('//a'), text.indexOf('//a') + 3],
                [vscode.DiagnosticSeverity.Hint, 'Odoo XPath', 'ok', text.indexOf('/form'), text.indexOf('/form') + '/form/sheet/field'.length]
            ]);
            diagnostics.clear(uri);
            assert.deepStrictEqual(diagnostics.collection.get(uri) ?? [], []);
        } finally {
            diagnostics.dispose();
        }
    });

    test('a quick fix swaps in the shorter locator, and only on the text that was checked', () => {
        const diagnostics = new XpathDiagnostics(vscode.languages.createDiagnosticCollection('odoo-view-xpaths-test'));
        try {
            diagnostics.show(uri, text, checked);
            const at = text.indexOf('/form') + 2;
            const range = new vscode.Range(0, at, 0, at);
            const [action, ...rest] = diagnostics.provideCodeActions({ uri, getText: () => text }, range);
            assert.deepStrictEqual(rest, []);
            assert.strictEqual(action.title, "Use //field[@name='x']");
            assert.strictEqual(action.isPreferred, true);
            const [[editedUri, [edit]]] = action.edit!.entries();
            assert.strictEqual(editedUri.toString(), uri.toString());
            assert.strictEqual(edit.newText, "//field[@name='x']");
            assert.strictEqual(edit.range.start.character, text.indexOf('/form'));
            // Edited since: the offsets no longer hold, so nothing is offered.
            assert.deepStrictEqual(diagnostics.provideCodeActions({ uri, getText: () => ` ${text}` }, range), []);
            assert.deepStrictEqual(diagnostics.provideCodeActions({ uri, getText: () => text }, new vscode.Range(0, 0, 0, 1)), [], 'nothing away from a finding');
        } finally {
            diagnostics.dispose();
        }
    });
});
```

Create `src/test/viewSaveHook.test.ts`:

```ts
import * as assert from 'assert';
import * as vscode from 'vscode';
import { createSaveHook, saveMessage, type SaveHookDeps } from '../views/viewSaveHook';
import { parseXpathReport, type XpathReport } from '../services/views/xpathReport';
import type { SaveResult } from '../services/views/viewService';

const dead = parseXpathReport({ locators: [{ kind: 'xpath', expr: '//a', status: 'dead', matches: 0, element: 1, line: 1 }, { kind: 'xpath', expr: '//b', status: 'dead', matches: 0, element: 2, line: 1 }] });
const fine = parseXpathReport({ locators: [{ kind: 'xpath', expr: '//a', status: 'ok', matches: 1, element: 1, line: 1 }] });
const on: SaveResult = { active: true, activated: true, activationError: null, inheriting: true };

function harness(overrides: Partial<SaveHookDeps> & { report?: XpathReport | Error } = {}) {
    const log: string[] = [];
    const activation = vscode.languages.createDiagnosticCollection('odoo-views-test');
    const deps: SaveHookDeps = {
        checkXpaths: async (_db, _id, arch) => {
            log.push(`check:${arch}`);
            if (overrides.report instanceof Error) {
                throw overrides.report;
            }
            return overrides.report ?? fine;
        },
        checkOnSave: () => true,
        xpaths: { show: (_uri, _text, report) => log.push(`show:${report.summary.dead}`) },
        activationDiagnostics: activation,
        reloadDatabase: db => log.push(`reload:${db}`),
        recordSave: async () => { log.push('record'); },
        refreshTree: () => log.push('refresh'),
        warn: text => log.push(`warn:${text}`),
        brief: text => log.push(`brief:${text}`),
        ...overrides
    };
    return { log, activation, hook: createSaveHook(deps) };
}

const uri = vscode.Uri.parse('odoo-view:/shop/12/acme.patch.xml');
const ref = { dbName: 'shop', viewId: 12 };

suite('After an arch save', () => {
    test('the message says when locators are broken', () => {
        assert.deepStrictEqual(saveMessage(on, dead), { warning: true, text: 'Saved, and the view is on — but 2 locators match nothing.' });
        assert.deepStrictEqual(saveMessage({ ...on, activated: false }, dead), { warning: true, text: 'Saved — but 2 locators match nothing.' });
        assert.deepStrictEqual(saveMessage(on, fine), { warning: false, text: 'Saved, and the view is on.' });
        assert.deepStrictEqual(saveMessage({ ...on, activated: false }), { warning: false, text: 'Saved.' });
        assert.match(saveMessage({ active: false, activated: false, activationError: 'Element x cannot be located', inheriting: true }, dead).text, /^Saved\. The view stays off: /);
    });

    test('an inheriting view is checked on the saved text, and the toast waits for it', async () => {
        const { log, hook, activation } = harness({ report: dead });
        await hook(ref, on, uri, '<data/>');
        assert.deepStrictEqual(log.filter(entry => !['record', 'refresh'].includes(entry)), [
            'reload:shop', 'check:<data/>', 'show:2', 'warn:Saved, and the view is on — but 2 locators match nothing.'
        ]);
        activation.dispose();
    });

    test('no check with the setting off, for a root view, or when the check fails', async () => {
        for (const [overrides, result] of [
            [{ checkOnSave: () => false }, on],
            [{}, { ...on, inheriting: false }],
            [{ report: new Error('shell gone') }, on]
        ] as Array<[Partial<SaveHookDeps> & { report?: Error }, SaveResult]>) {
            const { log, hook, activation } = harness(overrides);
            await hook(ref, result, uri, '<data/>');
            assert.ok(!log.some(entry => entry.startsWith('show:')), log.join());
            assert.ok(log.includes('brief:Saved, and the view is on.'), log.join());
            activation.dispose();
        }
    });

    test('Odoo\'s reason a view stays off still lands on its line', async () => {
        const { log, hook, activation } = harness();
        await hook(ref, { active: false, activated: false, activationError: 'Element \'<xpath expr="//nope">\' cannot be located in parent view', inheriting: true }, uri, '<data>\n<xpath expr="//nope"/>\n</data>');
        assert.strictEqual(activation.get(uri)?.length, 1);
        assert.ok(log.some(entry => entry.startsWith('warn:Saved. The view stays off')), log.join());
        activation.dispose();
    });
});
```

In `src/test/viewDoctorView.test.ts`:
- In the menu-wiring test, Check XPaths joins rows that have a parent; update the five `offered` lines (array order: openArch, openParent, openRoot, compare, render, checkXpaths, activate, …):

```ts
        assert.deepStrictEqual(offered('odooView.inactive.hasParent'), ['openArch', 'openParent', 'compare', 'render', 'checkXpaths', 'activate', 'copyXmlid']);
        assert.deepStrictEqual(offered('odooView.inactive.hasParent.deep'), ['openArch', 'openParent', 'openRoot', 'compare', 'render', 'checkXpaths', 'activate', 'copyXmlid']);
        assert.deepStrictEqual(offered('odooView.active.hasParent.deep.noXmlid'), ['openArch', 'openParent', 'openRoot', 'compare', 'render', 'checkXpaths', 'addToScript', 'deactivate']);
        assert.deepStrictEqual(offered('odooView.inactive.root.noXmlid'), ['openArch', 'compare', 'render', 'activate']);
        assert.deepStrictEqual(offered('odooView.active.root'), ['openArch', 'compare', 'render', 'copyXmlid', 'addToScript', 'deactivate']);
```

- In the editor-title test, the navigation list becomes `['viewDoctor.compare', 'viewDoctor.render', 'viewDoctor.checkXpaths']`.
- Add:

```ts
    test('checking on save is a setting, on by default', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
        const setting = manifest.contributes.configuration.properties['odooDebugger.views.checkXpathsOnSave'];
        assert.strictEqual(setting?.type, 'boolean');
        assert.strictEqual(setting?.default, true);
    });
```

(If `contributes.configuration` is an array in this manifest, read `properties` from the entry that has `odooDebugger.views.allowEditOriginal`.)

- [ ] **Step 2: Run them to see them fail**

Run: `npm run compile-tests` — Expected: tsc errors (`XpathDiagnostics`, `viewSaveHook` missing).

- [ ] **Step 3: Append the class to `xpathDiagnostics.ts`**

Add `import * as vscode from 'vscode';` at the top of `src/views/xpathDiagnostics.ts` (types-only modules stay pure; the functions above stay free of `vscode`), then append:

```ts
export const XPATH_SOURCE = 'Odoo XPath';

const SEVERITIES: Record<FindingSeverity, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    hint: vscode.DiagnosticSeverity.Hint
};

function toRange(span: TextSpan, text: string): vscode.Range {
    const start = positionAt(text, span.start);
    const end = positionAt(text, span.end);
    return new vscode.Range(start.line, start.character, end.line, end.character);
}

function toDiagnostic(finding: XpathFinding, text: string): vscode.Diagnostic {
    const diagnostic = new vscode.Diagnostic(toRange(finding.span, text), finding.message, SEVERITIES[finding.severity]);
    diagnostic.source = XPATH_SOURCE;
    diagnostic.code = finding.status;
    return diagnostic;
}

/**
 * The XPath check's results on open arches, in their own collection so they
 * never mix with Odoo's reason a view stays off, and the quick fixes for them.
 * A fix is offered only while the document still holds the text that was
 * checked: the offsets mean nothing once it changed.
 */
export class XpathDiagnostics implements vscode.CodeActionProvider, vscode.Disposable {
    static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];
    readonly collection: vscode.DiagnosticCollection;
    private readonly checked = new Map<string, { text: string; findings: XpathFinding[] }>();

    constructor(collection: vscode.DiagnosticCollection = vscode.languages.createDiagnosticCollection('odoo-view-xpaths')) {
        this.collection = collection;
    }

    /** Shows a check of `text`, the arch at `uri` as it was checked. */
    show(uri: vscode.Uri, text: string, report: XpathReport): void {
        const findings = xpathFindings(report, text);
        this.checked.set(uri.toString(), { text, findings });
        this.collection.set(uri, findings.map(finding => toDiagnostic(finding, text)));
    }

    clear(uri: vscode.Uri): void {
        this.checked.delete(uri.toString());
        this.collection.delete(uri);
    }

    provideCodeActions(document: Pick<vscode.TextDocument, 'uri' | 'getText'>, range: vscode.Range): vscode.CodeAction[] {
        const checked = this.checked.get(document.uri.toString());
        if (!checked || document.getText() !== checked.text) {
            return [];
        }
        const actions: vscode.CodeAction[] = [];
        for (const finding of checked.findings) {
            const where = toRange(finding.span, checked.text);
            if (finding.fixes.length === 0 || !where.intersection(range)) {
                continue;
            }
            const diagnostic = toDiagnostic(finding, checked.text);
            finding.fixes.forEach((fix, index) => {
                const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
                action.edit = new vscode.WorkspaceEdit();
                action.edit.replace(document.uri, toRange(fix.span, checked.text), fix.text);
                action.diagnostics = [diagnostic];
                action.isPreferred = index === 0;
                actions.push(action);
            });
        }
        return actions;
    }

    dispose(): void {
        this.checked.clear();
        this.collection.dispose();
    }
}
```

Note: the pure-part tests from Task 3 keep passing; the module now imports `vscode`, which the Extension Host test run provides.

- [ ] **Step 4: Write the save hook**

Create `src/views/viewSaveHook.ts`:

```ts
/**
 * What follows an arch save: Odoo's reason a view stays off goes on its line,
 * the render tab reloads that database, the note's journal records the save,
 * and - for an inheriting view, unless odooDebugger.views.checkXpathsOnSave is
 * off - the saved text's locators are checked, because a view Odoo turned on
 * can still carry a patch that matches nothing. The message waits for that
 * check, so it can say so; a failed check is only logged.
 */
import * as vscode from 'vscode';
import type { SaveResult } from '../services/views/viewService';
import { brokenLocators, type XpathReport } from '../services/views/xpathReport';
import { archErrorSummary, locateArchError, readableArchError } from '../services/views/archErrors';
import { logger } from '../services/logger';
import type { ViewRef } from './viewFileSystem';
import type { XpathDiagnostics } from './xpathDiagnostics';

export interface SaveHookDeps {
    checkXpaths(dbName: string, viewId: number, arch: string): Promise<XpathReport>;
    checkOnSave(): boolean;
    xpaths: Pick<XpathDiagnostics, 'show'>;
    /** Odoo's reasons saved views stay off. */
    activationDiagnostics: vscode.DiagnosticCollection;
    reloadDatabase(dbName: string): void;
    recordSave(dbName: string, viewId: number, activated: boolean): Promise<void>;
    refreshTree(): void;
    warn(text: string): void;
    brief(text: string): void;
}

export function saveMessage(result: SaveResult, report?: XpathReport): { warning: boolean; text: string } {
    if (result.activationError) {
        return { warning: true, text: `Saved. The view stays off: ${archErrorSummary(result.activationError)}` };
    }
    const saved = result.activated ? 'Saved, and the view is on' : 'Saved';
    const broken = report ? brokenLocators(report) : undefined;
    return broken ? { warning: true, text: `${saved} — but ${broken}.` } : { warning: false, text: `${saved}.` };
}

export function createSaveHook(deps: SaveHookDeps): (ref: ViewRef, result: SaveResult, uri: vscode.Uri, text: string) => Promise<void> {
    return async (ref, result, uri, text) => {
        if (result.activationError) {
            const where = locateArchError(text, result.activationError);
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(where.line, where.start, where.line, where.end),
                readableArchError(result.activationError),
                vscode.DiagnosticSeverity.Error
            );
            diagnostic.source = 'Odoo';
            deps.activationDiagnostics.set(uri, [diagnostic]);
        } else {
            deps.activationDiagnostics.delete(uri);
        }
        deps.reloadDatabase(ref.dbName);
        // The tree shows the journal, so refresh once the save is in it.
        void deps.recordSave(ref.dbName, ref.viewId, result.activated).then(() => deps.refreshTree());

        let report: XpathReport | undefined;
        if (result.inheriting && deps.checkOnSave()) {
            try {
                report = await deps.checkXpaths(ref.dbName, ref.viewId, text);
                deps.xpaths.show(uri, text, report);
            } catch (error) {
                logger.warn(`Could not check the locators of view ${ref.viewId} in ${ref.dbName}:`, error);
            }
        }
        const message = saveMessage(result, report);
        (message.warning ? deps.warn : deps.brief)(message.text);
    };
}
```

- [ ] **Step 5: Wire `extension.ts` and `CommandDeps`**

In `src/extension.ts`:
- imports: add `import { XpathDiagnostics } from './views/xpathDiagnostics';` and `import { createSaveHook } from './views/viewSaveHook';`. Remove `archErrorSummary, locateArchError, readableArchError` from the archErrors import if nothing else in the file uses them (check with grep; tsc/lint will tell).
- after the `viewDiagnostics` collection is created and pushed, add:

```ts
    // The XPath check's results, with quick fixes, apart from Odoo's own reasons.
    const xpathDiagnostics = new XpathDiagnostics();
    context.subscriptions.push(xpathDiagnostics, vscode.languages.registerCodeActionsProvider(
        { scheme: VIEW_SCHEME }, xpathDiagnostics, { providedCodeActionKinds: XpathDiagnostics.providedCodeActionKinds }));
```

- in the existing `onDidCloseTextDocument` handler, after `viewDiagnostics.delete(document.uri);`, add `xpathDiagnostics.clear(document.uri);`.
- replace the whole `onSaved: (ref, result, uri, text) => { … }` body passed to `new ViewFileSystemProvider(viewService, { … })` with:

```ts
    const onSaved = createSaveHook({
        checkXpaths: (dbName, viewId, arch) => viewService.checkXpaths(dbName, viewId, arch),
        checkOnSave: () => vscode.workspace.getConfiguration('odooDebugger').get<boolean>('views.checkXpathsOnSave', true),
        xpaths: xpathDiagnostics,
        activationDiagnostics: viewDiagnostics,
        reloadDatabase: dbName => viewRender.reloadDatabase(dbName),
        recordSave: (dbName, viewId, activated) => viewNotes.recordSave(dbName, viewId, activated),
        refreshTree: () => providers.views.refresh(),
        warn: text => void showWarning(text),
        brief: text => showBriefStatus(text)
    });
    const viewFiles = new ViewFileSystemProvider(viewService, {
        onSaved: (ref, result, uri, text) => void onSaved(ref, result, uri, text)
    }, async dbName => {
```

  (the `isReadOnly` callback and the rest stay as they are; if `recordSave`'s return type is not `Promise<void>`, wrap it: `async (…) => { await viewNotes.recordSave(…); }`).
- add `xpathDiagnostics` to the `registerAllCommands({ … })` call.

In `src/commands/index.ts`, `CommandDeps` gets, after `viewDiagnostics`:

```ts
    /** The XPath check's results on arch files, and their quick fixes. */
    xpathDiagnostics: XpathDiagnostics;
```

with `import type { XpathDiagnostics } from '../views/xpathDiagnostics';`.

- [ ] **Step 6: Add Check XPaths**

In `src/commands/viewDoctorCommands.ts`:
- imports: `showWarning` from notifications (with the others), `VIEW_SCHEME, parseViewUri` from `../views/viewFileSystem` (with `clearViewDiagnostics, viewUri`), `checkResultText` from `../services/views/xpathReport`, `type ViewRow` from `../services/views/viewQueries`.
- module-level helper, after `openArch`:

```ts
/** The view's open arch - revealed when no editor shows it - or the arch opened now. */
async function archDocument(dbName: string, view: ViewRow): Promise<vscode.TextDocument> {
    const open = vscode.workspace.textDocuments.find(document => {
        const ref = document.uri.scheme === VIEW_SCHEME ? parseViewUri(document.uri) : undefined;
        return ref?.dbName === dbName && ref.viewId === view.id;
    });
    if (open && vscode.window.visibleTextEditors.some(editor => editor.document === open)) {
        return open;
    }
    return (await vscode.window.showTextDocument(open ?? viewUri(dbName, view.id, view.xmlid ?? `view-${view.id}`), { preview: true })).document;
}
```

- destructure `xpathDiagnostics` from `deps` too, and register after `viewDoctor.render`:

```ts
    context.subscriptions.push(registerCommand('viewDoctor.checkXpaths', async (arg: unknown) => {
        const item = await target(arg);
        if (!item) {
            return;
        }
        if (!item.view.inheritId) {
            void showInfo(`${item.view.name} inherits no view: it has no locators to check.`);
            return;
        }
        try {
            const document = await archDocument(item.dbName, item.view);
            const text = document.getText();
            const report = await viewService.checkXpaths(item.dbName, item.view.id, text);
            xpathDiagnostics.show(document.uri, text, report);
            const result = checkResultText(report);
            void (result.level === 'info' ? showInfo(result.text) : showWarning(result.text));
        } catch (error) {
            void showError(`Could not check ${item.view.name}: ${errorMessage(error)}`);
        }
    }));
```

- [ ] **Step 7: Wire `package.json`**

- command: `{ "command": "viewDoctor.checkXpaths", "title": "Check XPaths", "category": "Odoo DevTools", "icon": "$(check-all)" },`
- `view/item/context`, right after the render entry: `{ "command": "viewDoctor.checkXpaths", "when": "view == viewDoctor && viewItem =~ /\\.hasParent(\\.|$)/", "group": "1_open@7" },`
- `editor/title`, after render: `{ "command": "viewDoctor.checkXpaths", "when": "resourceScheme == odoo-view", "group": "navigation@3" },`
- `commandPalette`: `{ "command": "viewDoctor.checkXpaths", "when": "resourceScheme == odoo-view" },`
- configuration, after `odooDebugger.views.allowEditOriginal`:

```json
        "odooDebugger.views.checkXpathsOnSave": {
          "type": "boolean",
          "default": true,
          "description": "After saving an inheriting view's arch, check that each of its locators still matches exactly one node of its parent. Odoo turns a view on even when a locator matches nothing, and drops that patch silently."
        },
```

- [ ] **Step 8: Run the tests**

Run: `npx tsc -p . --noEmit && npm run lint && npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "XPath|After an arch save|View Doctor|Views tree"`
Expected: PASS. Then the full suite once: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npm test` — expected ≥ 768 + new passing, 19 pending, 0 failing. `git checkout -- dist`.

- [ ] **Step 9: Commit**

```bash
git add src/views/xpathDiagnostics.ts src/views/viewSaveHook.ts src/extension.ts src/commands/index.ts src/commands/viewDoctorCommands.ts package.json src/test/xpathDiagnostics.test.ts src/test/viewSaveHook.test.ts src/test/viewDoctorView.test.ts
git commit -m "[ADD] Check an inheriting view's locators on save and on demand

After a save, an inheriting view's locators are checked against its parent
(odooDebugger.views.checkXpathsOnSave, on by default), and the message says
when some match nothing: Odoo turns such a view on and drops the patch.
Dead and ambiguous locators show as warnings on their expr, invalid ones as
errors, and a quick fix swaps a long or ambiguous one for a shorter locator
that finds the same node. Check XPaths does the same from a row or an arch
editor's title.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Find View, and Views Inheriting This

**Files:**
- Modify: `src/services/views/viewQueries.ts` (`viewModels`, `viewsOfModel`, `descendants`)
- Create: `src/views/viewPicker.ts`, `src/views/findViewFlow.ts`
- Modify: `src/commands/viewDoctorCommands.ts` (`viewDoctor.findView`, `viewDoctor.showInheriting`)
- Modify: `package.json`
- Test: `src/test/viewPicker.test.ts` (new), `src/test/viewQueries.test.ts`, `src/test/viewDoctorView.test.ts`, `src/test/viewWorker.integration.test.ts`

**Interfaces:**
- Consumes: `viewRowsSql`, `sqlText`, `sqlIdList`, `runSql`, `getViewRows`, `findViewByXmlid` (viewQueries); `resolveViewDoctorTarget`; `target()` and `openArch` in commands (Task 4).
- Produces:
  ```ts
  // viewQueries.ts
  export interface ViewModelCount { model: string; count: number }
  export const VIEW_MODELS_SQL: string;
  export function parseViewModels(output: string): ViewModelCount[]
  export function viewModels(dbName: string): Promise<ViewModelCount[]>
  export function viewsOfModelSql(model: string): string
  export function viewsOfModel(dbName: string, model: string): Promise<ViewRow[]>
  export function descendantsSql(viewId: number): string
  export function descendants(dbName: string, viewId: number): Promise<ViewRow[]>   // the view itself included
  // viewPicker.ts (pure)
  export interface ViewPickEntry { view: ViewRow; depth: number }
  export function viewTree(rows: ViewRow[]): ViewPickEntry[]
  export interface ViewPickItem extends vscode.QuickPickItem { view: ViewRow }
  export function viewPickItems(entries: ViewPickEntry[]): ViewPickItem[]
  export type FindChoice = { kind: 'id'; id: number } | { kind: 'xmlid'; xmlid: string } | { kind: 'model'; model: string };
  export interface FindItem extends vscode.QuickPickItem { choice: FindChoice }
  export function findViewItems(value: string, models: ViewModelCount[]): FindItem[]
  // findViewFlow.ts
  export type OpenView = (dbName: string, view: ViewRow) => Promise<void>;
  export function findView(dbName: string, open: OpenView): Promise<void>
  export function pickView(dbName: string, rows: ViewRow[], title: string, open: OpenView): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/test/viewPicker.test.ts`:

```ts
import * as assert from 'assert';
import { findViewItems, viewPickItems, viewTree } from '../views/viewPicker';
import type { ViewRow } from '../services/views/viewQueries';

function row(id: number, inheritId: number | null, overrides: Partial<ViewRow> = {}): ViewRow {
    return { id, name: `v${id}`, model: 'res.partner', type: 'form', active: true, inheritId, xmlid: null, rootId: id, isReport: false, writeDate: 0, ...overrides };
}

suite('View pickers', () => {
    test('base views first, each inheriting view under its parent', () => {
        const rows = [row(30, 10), row(10, null, { type: 'form' }), row(20, null, { type: 'list', name: 'a list' }), row(31, 30), row(11, 10), row(50, 999)];
        assert.deepStrictEqual(viewTree(rows).map(entry => [entry.view.id, entry.depth]), [
            [10, 0], [11, 1], [30, 1], [31, 2],
            [20, 0],
            [50, 0]
        ]);
    });

    test('a cycle is listed, not lost or looped', () => {
        assert.deepStrictEqual(viewTree([row(1, 2), row(2, 1)]).map(entry => entry.view.id).sort(), [1, 2]);
    });

    test('labels indent, mark inactive views, and describe model, type and external id', () => {
        const items = viewPickItems(viewTree([row(10, null, { xmlid: 'base.f' }), row(11, 10, { active: false }), row(12, 11)]));
        assert.deepStrictEqual(items.map(item => item.label), ['$(pass) v10', '↳ $(circle-slash) v11', ' ↳ $(pass) v12']);
        assert.deepStrictEqual(items.map(item => item.description), ['res.partner · form · base.f', 'res.partner · form · #11', 'res.partner · form · #12']);
        assert.strictEqual(viewPickItems(viewTree([row(5, null, { model: '', type: 'qweb' })]))[0].description, 'qweb · #5');
    });

    test('Find View: a number is an id, module.name an external id, the rest a model', () => {
        const models = [{ model: 'res.partner', count: 40 }, { model: 'sale.order', count: 1 }];
        assert.deepStrictEqual(findViewItems('', models).map(item => item.choice), [{ kind: 'model', model: 'res.partner' }, { kind: 'model', model: 'sale.order' }]);
        assert.deepStrictEqual(findViewItems(' 42 ', models)[0], { label: '$(symbol-number) View 42', alwaysShow: true, choice: { kind: 'id', id: 42 } });
        assert.deepStrictEqual(findViewItems('sale.view_order_form', models)[0].choice, { kind: 'xmlid', xmlid: 'sale.view_order_form' });
        assert.strictEqual(findViewItems('sale.view_order_form', models)[0].alwaysShow, true);
        assert.deepStrictEqual(findViewItems('sale.order', models).map(item => item.choice.kind), ['model', 'model'], 'a model is not offered as an external id');
        assert.deepStrictEqual(findViewItems('0', models).map(item => item.choice.kind), ['model', 'model']);
        assert.strictEqual(findViewItems('', models)[1].description, '1 view');
    });
});
```

Append to `src/test/viewQueries.test.ts` (inside its existing suite, or a new suite at the end; import the new names):

```ts
suite('View queries for finding views', () => {
    test('model text goes in hex, ids as validated integers', () => {
        const sql = viewsOfModelSql("x'); DROP TABLE ir_ui_view; --");
        assert.ok(!sql.includes('DROP TABLE'), sql);
        assert.ok(sql.includes("convert_from(decode('"), sql);
        assert.ok(descendantsSql(7).includes('WHERE id = 7'), descendantsSql(7));
        assert.throws(() => descendantsSql(-1));
    });

    test('model counts parse, odd output throws', () => {
        assert.deepStrictEqual(parseViewModels('[{"model":"res.partner","count":3}]'), [{ model: 'res.partner', count: 3 }]);
        assert.deepStrictEqual(parseViewModels(''), []);
        assert.throws(() => parseViewModels('{}'));
    });
});
```

In `src/test/viewDoctorView.test.ts`:
- the menu-wiring `offered` lines: Views Inheriting This is on every row, right after openRoot in the array (group `1_open@4`). Insert `'showInheriting'` after `'openRoot'` where present, else after `'openParent'` where present, else after `'openArch'`:

```ts
        assert.deepStrictEqual(offered('odooView.inactive.hasParent'), ['openArch', 'openParent', 'showInheriting', 'compare', 'render', 'checkXpaths', 'activate', 'copyXmlid']);
        assert.deepStrictEqual(offered('odooView.inactive.hasParent.deep'), ['openArch', 'openParent', 'openRoot', 'showInheriting', 'compare', 'render', 'checkXpaths', 'activate', 'copyXmlid']);
        assert.deepStrictEqual(offered('odooView.active.hasParent.deep.noXmlid'), ['openArch', 'openParent', 'openRoot', 'showInheriting', 'compare', 'render', 'checkXpaths', 'addToScript', 'deactivate']);
        assert.deepStrictEqual(offered('odooView.inactive.root.noXmlid'), ['openArch', 'showInheriting', 'compare', 'render', 'activate']);
        assert.deepStrictEqual(offered('odooView.active.root'), ['openArch', 'showInheriting', 'compare', 'render', 'copyXmlid', 'addToScript', 'deactivate']);
```

- the editor-title test's "…" list becomes `['viewDoctor.openParent', 'viewDoctor.openRoot', 'viewDoctor.showInheriting', 'viewDoctor.addToScript']`.

In `src/test/viewWorker.integration.test.ts`, add (before the drop test; import `descendants, viewModels, viewsOfModel` from `../services/views/viewQueries`):

```ts
    test('the finding queries run on a real database', async () => {
        const formId = Number(await runSql(copy, "SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'view_partner_form';"));
        assert.ok((await viewModels(copy)).some(entry => entry.model === 'res.partner' && entry.count > 0));
        assert.ok((await viewsOfModel(copy, 'res.partner')).some(view => view.id === formId && view.xmlid === 'base.view_partner_form'));
        const tree = await descendants(copy, formId);
        assert.ok(tree.some(view => view.id === formId), 'the view itself');
        assert.ok(tree.some(view => view.id === viewId), 'the setup view inherits it');
        assert.ok(tree.every(view => view.id === formId || view.inheritId !== null));
    });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run compile-tests` — Expected: tsc errors (missing exports and modules).

- [ ] **Step 3: Add the queries**

Append to `src/services/views/viewQueries.ts`:

```ts
export interface ViewModelCount {
    model: string;
    count: number;
}

/** The models that have views, with how many; Find View offers them. */
export const VIEW_MODELS_SQL = `
SELECT coalesce(json_agg(json_build_object('model', model, 'count', n) ORDER BY model), '[]'::json)
FROM (SELECT model, count(*) AS n FROM ir_ui_view WHERE model IS NOT NULL AND model <> '' GROUP BY model) m;`.trim();

export function parseViewModels(output: string): ViewModelCount[] {
    const raw = parseJson(output, '[]');
    if (!Array.isArray(raw)) {
        throw new Error('Unexpected output from the model query.');
    }
    return raw.map(entry => {
        const model = entry as Record<string, unknown>;
        return { model: String(model.model ?? ''), count: Number(model.count ?? 0) };
    });
}

export async function viewModels(dbName: string): Promise<ViewModelCount[]> {
    return parseViewModels(await runSql(dbName, VIEW_MODELS_SQL));
}

/** Every view of a model, on or off. */
export function viewsOfModelSql(model: string): string {
    return viewRowsSql(`v.model = ${sqlText(model)}`);
}

export async function viewsOfModel(dbName: string, model: string): Promise<ViewRow[]> {
    return parseViewRows(await runSql(dbName, viewsOfModelSql(model)));
}

/** The view and every view inheriting from it, at any depth, on or off; bounded like the root walk. */
export function descendantsSql(viewId: number): string {
    return viewRowsSql(`v.id IN (
    WITH RECURSIVE tree AS (
        SELECT id, 0 AS depth FROM ir_ui_view WHERE id = ${sqlIdList([viewId])}
        UNION ALL
        SELECT c.id, t.depth + 1 FROM ir_ui_view c JOIN tree t ON c.inherit_id = t.id WHERE t.depth < 50
    ) SELECT id FROM tree)`);
}

export async function descendants(dbName: string, viewId: number): Promise<ViewRow[]> {
    return parseViewRows(await runSql(dbName, descendantsSql(viewId)));
}
```

- [ ] **Step 4: Write the pickers**

Create `src/views/viewPicker.ts`:

```ts
/**
 * The QuickPicks that find a view: what Find View offers for what is typed,
 * and a list of views laid out as their inheritance - base views first, each
 * inheriting view indented under its parent. Pure: the flows show them.
 */
import type * as vscode from 'vscode';
import type { ViewModelCount, ViewRow } from '../services/views/viewQueries';

export interface ViewPickEntry {
    view: ViewRow;
    depth: number;
}

function byTypeThenName(a: ViewRow, b: ViewRow): number {
    return Number(a.inheritId !== null) - Number(b.inheritId !== null)
        || a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.id - b.id;
}

/** Depth-first, children by id. A view whose parent is not listed starts a branch after the base views. */
export function viewTree(rows: ViewRow[]): ViewPickEntry[] {
    const listed = new Set(rows.map(row => row.id));
    const children = new Map<number, ViewRow[]>();
    const roots: ViewRow[] = [];
    for (const row of rows) {
        if (row.inheritId !== null && row.inheritId !== row.id && listed.has(row.inheritId)) {
            children.set(row.inheritId, [...(children.get(row.inheritId) ?? []), row]);
        } else {
            roots.push(row);
        }
    }
    const entries: ViewPickEntry[] = [];
    const seen = new Set<number>();
    const visit = (view: ViewRow, depth: number): void => {
        if (seen.has(view.id)) {
            return;
        }
        seen.add(view.id);
        entries.push({ view, depth });
        for (const child of [...(children.get(view.id) ?? [])].sort((a, b) => a.id - b.id)) {
            visit(child, depth + 1);
        }
    };
    roots.sort(byTypeThenName).forEach(root => visit(root, 0));
    // Views in a cycle never reach a root: listed flat rather than lost.
    rows.filter(row => !seen.has(row.id)).sort((a, b) => a.id - b.id).forEach(row => visit(row, 0));
    return entries;
}

export interface ViewPickItem extends vscode.QuickPickItem {
    view: ViewRow;
}

export function viewPickItems(entries: ViewPickEntry[]): ViewPickItem[] {
    return entries.map(({ view, depth }) => ({
        // Em spaces: HTML does not collapse them, so deeper views stay indented.
        label: `${depth > 0 ? `${' '.repeat(depth - 1)}↳ ` : ''}$(${view.active ? 'pass' : 'circle-slash'}) ${view.name}`,
        description: [view.model, view.type, view.xmlid ?? `#${view.id}`].filter(Boolean).join(' · '),
        view
    }));
}

export type FindChoice = { kind: 'id'; id: number } | { kind: 'xmlid'; xmlid: string } | { kind: 'model'; model: string };

export interface FindItem extends vscode.QuickPickItem {
    choice: FindChoice;
}

/** What Find View lists for the typed value: the value as an id or an external id first, then the models. */
export function findViewItems(value: string, models: ViewModelCount[]): FindItem[] {
    const typed = value.trim();
    const items: FindItem[] = [];
    const id = Number(typed);
    if (/^\d+$/.test(typed) && Number.isSafeInteger(id) && id > 0) {
        items.push({ label: `$(symbol-number) View ${id}`, alwaysShow: true, choice: { kind: 'id', id } });
    } else if (/^[\w-]+\.[\w.-]+$/.test(typed) && !models.some(entry => entry.model === typed)) {
        items.push({ label: `$(symbol-key) ${typed}`, description: 'external ID', alwaysShow: true, choice: { kind: 'xmlid', xmlid: typed } });
    }
    return [...items, ...models.map(entry => ({
        label: entry.model,
        description: `${entry.count} view${entry.count === 1 ? '' : 's'}`,
        choice: { kind: 'model', model: entry.model } as FindChoice
    }))];
}
```

- [ ] **Step 5: Write the flows**

Create `src/views/findViewFlow.ts`:

```ts
/**
 * Find View: any view of the tree's database, by id, external id or model;
 * and the pick both it and Views Inheriting This end in. Picking a view
 * opens its arch - the tree itself stays about what is off.
 */
import * as vscode from 'vscode';
import { findViewByXmlid, getViewRows, viewModels, viewsOfModel, type ViewRow } from '../services/views/viewQueries';
import { showInfo } from '../services/notifications';
import { findViewItems, viewPickItems, viewTree, type FindChoice, type FindItem } from './viewPicker';

export type OpenView = (dbName: string, view: ViewRow) => Promise<void>;

export async function pickView(dbName: string, rows: ViewRow[], title: string, open: OpenView): Promise<void> {
    const picked = await vscode.window.showQuickPick(viewPickItems(viewTree(rows)), { title, matchOnDescription: true });
    if (picked) {
        await open(dbName, picked.view);
    }
}

function askWhat(dbName: string, models: Awaited<ReturnType<typeof viewModels>>): Promise<FindChoice | undefined> {
    const quickPick = vscode.window.createQuickPick<FindItem>();
    quickPick.title = `Find a view in ${dbName}`;
    quickPick.placeholder = 'A view id, an external ID, or a model';
    quickPick.items = findViewItems('', models);
    return new Promise(resolve => {
        quickPick.onDidChangeValue(value => {
            quickPick.items = findViewItems(value, models);
        });
        quickPick.onDidAccept(() => {
            resolve(quickPick.selectedItems[0]?.choice);
            quickPick.hide();
        });
        quickPick.onDidHide(() => {
            resolve(undefined);
            quickPick.dispose();
        });
        quickPick.show();
    });
}

export async function findView(dbName: string, open: OpenView): Promise<void> {
    const choice = await askWhat(dbName, await viewModels(dbName));
    if (!choice) {
        return;
    }
    if (choice.kind === 'id') {
        const [view] = await getViewRows(dbName, [choice.id]);
        if (view) {
            await open(dbName, view);
        } else {
            void showInfo(`${dbName} has no view ${choice.id}.`);
        }
        return;
    }
    if (choice.kind === 'xmlid') {
        const view = await findViewByXmlid(dbName, choice.xmlid);
        if (view) {
            await open(dbName, view);
        } else {
            void showInfo(`${dbName} has no view with the external ID ${choice.xmlid}.`);
        }
        return;
    }
    await pickView(dbName, await viewsOfModel(dbName, choice.model), `Views of ${choice.model} in ${dbName}`, open);
}
```

- [ ] **Step 6: Register the commands**

In `src/commands/viewDoctorCommands.ts` (imports: `findView, pickView` from `../views/findViewFlow`; `descendants` from `../services/views/viewQueries`):

```ts
    const openView = (dbName: string, view: ViewRow) => openArch(dbName, view.id, view.xmlid);

    context.subscriptions.push(registerCommand('viewDoctor.findView', async () => {
        const project = (await SettingsStore.peekSelectedProject().catch(() => null))?.project;
        const where = resolveViewDoctorTarget(project as Parameters<typeof resolveViewDoctorTarget>[0]);
        if (!where) {
            void showInfo('Select a database first.');
            return;
        }
        try {
            await findView(where.dbName, openView);
        } catch (error) {
            void showError(`Could not search the views of ${where.dbName}: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(registerCommand('viewDoctor.showInheriting', async (arg: unknown) => {
        const item = await target(arg);
        if (!item) {
            return;
        }
        try {
            const rows = await descendants(item.dbName, item.view.id);
            if (rows.length <= 1) {
                void showInfo(`No view inherits ${item.view.name}.`);
                return;
            }
            await pickView(item.dbName, rows, `Views inheriting ${item.view.name}`, openView);
        } catch (error) {
            void showError(`Could not list the views inheriting ${item.view.name}: ${errorMessage(error)}`);
        }
    }));
```

- [ ] **Step 7: Wire `package.json`**

- commands:
  `{ "command": "viewDoctor.findView", "title": "Find View…", "category": "Odoo DevTools", "icon": "$(search)" },`
  `{ "command": "viewDoctor.showInheriting", "title": "Views Inheriting This…", "category": "Odoo DevTools", "icon": "$(type-hierarchy-sub)" },`
- `view/title`: add findView first and renumber the two existing entries (`navigation@1` stays free for Task 7):

```json
        { "command": "viewDoctor.findView", "when": "view == viewDoctor", "group": "navigation@0" },
        { "command": "viewDoctor.createScript", "when": "view == viewDoctor", "group": "navigation@2" },
        { "command": "viewDoctor.refresh", "when": "view == viewDoctor", "group": "navigation@3" },
```

  (keep their existing multi-line style if the neighbours use it).
- `view/item/context`, after openRoot: `{ "command": "viewDoctor.showInheriting", "when": "view == viewDoctor && viewItem =~ /^odooView\\./", "group": "1_open@4" },`
- `editor/title`, after openRoot: `{ "command": "viewDoctor.showInheriting", "when": "resourceScheme == odoo-view", "group": "1_view@3" },`
- `commandPalette`: `{ "command": "viewDoctor.showInheriting", "when": "resourceScheme == odoo-view" },` (findView stays visible: no entry).

- [ ] **Step 8: Run the tests**

Run: `npx tsc -p . --noEmit && npm run lint && npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View pickers|View queries|View Doctor|Views tree"`
Expected: PASS. Then the integration suite on `odt_view_base_19` (Task 2 Step 8's command). `git checkout -- dist`.

- [ ] **Step 9: Commit**

```bash
git add src/services/views/viewQueries.ts src/views/viewPicker.ts src/views/findViewFlow.ts src/commands/viewDoctorCommands.ts package.json src/test/viewPicker.test.ts src/test/viewQueries.test.ts src/test/viewDoctorView.test.ts src/test/viewWorker.integration.test.ts
git commit -m "[ADD] Find any view, and the views inheriting one

Find View, on the Views title, opens a view of the tree's database by id or
external id, or lists a model's views. Views Inheriting This, on a row or
an arch editor, lists every view below it. Both lists show base views first
and each inheriting view under its parent, with the ones that are off
marked; picking one opens its arch.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: "Disabled only here" — hide inactive views the original also has off

**Files:**
- Modify: `src/services/views/viewQueries.ts` (`inactiveViewIds`)
- Modify: `src/services/views/viewGroups.ts` (`alsoOffInOriginal`)
- Modify: `src/services/views/viewService.ts` (`doctorGroups(dbName, originalDb?)`, `originalInactiveIds`)
- Modify: `src/views/viewDoctorView.ts` (rows, description, provider options)
- Modify: `src/commands/viewDoctorCommands.ts` (toggles), `src/extension.ts` (provider options, context key)
- Modify: `package.json`
- Test: `src/test/viewGroups.test.ts`, `src/test/viewDoctorView.test.ts`, `src/test/viewService.test.ts`

**Interfaces:**
- Consumes: `upgradePair`, `PairProject` (`src/views/viewPairing.ts`); `resolveViewDoctorTarget`.
- Produces:
  ```ts
  // viewQueries.ts
  export function inactiveViewIds(dbName: string): Promise<number[]>
  // viewGroups.ts
  export function groupViews(inactive, reported, reportedRows, edited = [], alsoOffInOriginal?: ReadonlySet<number>): ViewGroups
  //   ViewGroups.alsoOffInOriginal?: ViewRow[]
  // viewService.ts
  export function originalInactiveIds(read: (dbName: string) => Promise<number[]>, dbName: string, originalDb?: string): Promise<Set<number> | undefined>
  //   ViewService.doctorGroups(dbName: string, originalDb?: string): Promise<ViewGroups>
  // viewDoctorView.ts
  export const SHOW_ALSO_OFF_KEY = 'viewDoctor.showAlsoOff';
  export interface DoctorRowOptions { originalDb?: string; showAlsoOff?: boolean }
  export function buildDoctorRows(dbName: string, groups: ViewGroups, options?: DoctorRowOptions): vscode.TreeItem[]
  export interface ViewDoctorOptions { showAlsoOff?(): boolean; onComparing?(comparing: boolean): void }
  //   new ViewDoctorTreeProvider(service, describe?, options?)
  //   new ViewItem(dbName, view, section, versions = [], alsoOffIn?: string)
  ```
  - Context keys `odoo-debugger.viewDoctor.comparing`, `odoo-debugger.viewDoctor.showAlsoOff`; commands `viewDoctor.showAlsoOff`, `viewDoctor.hideAlsoOff`.

- [ ] **Step 1: Write the failing tests**

Append to `src/test/viewGroups.test.ts` (inside its suite):

```ts
    test('splits off the other inactive views the original has off too', () => {
        const groups = groupViews([row(10), row(20), row(21)], new Map([[10, ['18.0']]]), [], [], new Set([10, 21, 99]));
        assert.deepStrictEqual(groups.otherInactive.map(view => view.id), [20]);
        assert.deepStrictEqual(groups.alsoOffInOriginal?.map(view => view.id), [21]);
        assert.deepStrictEqual(groups.upgradeDisabled.map(view => view.id), [10], 'the upgrade\'s own list is never filtered');
        assert.deepStrictEqual(groupViews([row(20)], new Map(), []).alsoOffInOriginal ?? [], []);
    });
```

Append to `src/test/viewService.test.ts`:

```ts
suite('Views also off in the original', () => {
    test('read from the original only, and never failing the tree', async () => {
        const reads: string[] = [];
        const read = async (dbName: string) => { reads.push(dbName); return [3, 4]; };
        assert.deepStrictEqual(await originalInactiveIds(read, 'shop-18', 'shop-17'), new Set([3, 4]));
        assert.strictEqual(await originalInactiveIds(read, 'shop-18'), undefined);
        assert.strictEqual(await originalInactiveIds(read, 'shop-18', 'shop-18'), undefined);
        assert.deepStrictEqual(reads, ['shop-17']);
        assert.strictEqual(await originalInactiveIds(async () => { throw new Error('database "shop-17" does not exist'); }, 'shop-18', 'shop-17'), undefined);
    });
});
```

(import `originalInactiveIds` from `../services/views/viewService`.)

Append to `src/test/viewDoctorView.test.ts`:

```ts
    test('hides the inactive views the original also has off, and says how many', () => {
        const view = (id: number) => ({ id, name: `v${id}`, model: 'res.partner', type: 'form', active: false, inheritId: 1, xmlid: null, rootId: 1, isReport: false, writeDate: 0 });
        const groups = { upgradeDisabled: [], upgradeVersions: [], otherInactive: [view(20)], alsoOffInOriginal: [view(21), view(22)], missingIds: [], edited: [] };

        const hidden = buildDoctorRows('shop-18', groups, { originalDb: 'shop-17' })[0] as ViewGroupItem;
        assert.strictEqual(hidden.description, '1 · 2 also off in shop-17');
        assert.deepStrictEqual(hidden.children.map(item => (item as ViewItem).view.id), [20]);

        const shown = buildDoctorRows('shop-18', groups, { originalDb: 'shop-17', showAlsoOff: true })[0] as ViewGroupItem;
        assert.strictEqual(shown.description, '3 · 2 also off in shop-17');
        assert.deepStrictEqual(shown.children.map(item => [(item as ViewItem).view.id, item.description]), [
            [20, 'res.partner · #20'],
            [21, 'res.partner · #21 · off in shop-17 too'],
            [22, 'res.partner · #22 · off in shop-17 too']
        ]);

        const allHidden = buildDoctorRows('shop-18', { ...groups, otherInactive: [] }, { originalDb: 'shop-17' })[0] as ViewGroupItem;
        assert.strictEqual(allHidden.description, '0 · 2 also off in shop-17');
        assert.deepStrictEqual(allHidden.children.map(item => item.label), ['All 2 are off in shop-17 too.']);
    });

    test('the filter\'s toggles show only while comparing with an original', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
        const title = manifest.contributes.menus['view/title'] as Array<{ command: string; when?: string }>;
        const when = (command: string) => title.find(entry => entry.command === command)?.when ?? '';
        assert.match(when('viewDoctor.showAlsoOff'), /odoo-debugger\.viewDoctor\.comparing && !odoo-debugger\.viewDoctor\.showAlsoOff/);
        assert.match(when('viewDoctor.hideAlsoOff'), /odoo-debugger\.viewDoctor\.comparing && odoo-debugger\.viewDoctor\.showAlsoOff/);
    });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run compile-tests` — Expected: tsc errors (`alsoOffInOriginal`, `originalInactiveIds`, the third `buildDoctorRows` argument).

- [ ] **Step 3: The query and the grouping**

Append to `src/services/views/viewQueries.ts`:

```ts
/** The ids of the views that are off: what "also off in the original" compares with. */
export async function inactiveViewIds(dbName: string): Promise<number[]> {
    const raw = parseJson(await runSql(dbName, "SELECT coalesce(json_agg(id), '[]'::json) FROM ir_ui_view WHERE active = false;"), '[]');
    if (!Array.isArray(raw)) {
        throw new Error('Unexpected output from the inactive view query.');
    }
    return raw.filter((id): id is number => Number.isSafeInteger(id));
}
```

In `src/services/views/viewGroups.ts`:
- `ViewGroups` gains, after `otherInactive`:

```ts
    /**
     * Other inactive views the upgrade's original database has off too,
     * compared by id - the upgraded database is a copy, so ids carry over.
     * Empty outside Upgrade mode.
     */
    alsoOffInOriginal?: ViewRow[];
```

- `groupViews` gets the parameter and splits:

```ts
export function groupViews(
    inactive: ViewRow[],
    reported: Map<number, string[]>,
    reportedRows: ViewRow[],
    edited: ViewRow[] = [],
    alsoOffInOriginal?: ReadonlySet<number>
): ViewGroups {
```

  and replace the `otherInactive` computation and the return with:

```ts
    const other = inactive.filter(view =>
        !reported.has(view.id) && (view.type !== 'qweb' || view.isReport));
    const alsoOff = alsoOffInOriginal ? other.filter(view => alsoOffInOriginal.has(view.id)) : [];

    return {
        upgradeDisabled,
        upgradeVersions,
        otherInactive: alsoOffInOriginal ? other.filter(view => !alsoOffInOriginal.has(view.id)) : other,
        alsoOffInOriginal: alsoOff,
        missingIds,
        edited: [...edited].sort((a, b) => a.model.localeCompare(b.model) || a.id - b.id)
    };
```

- [ ] **Step 4: The service**

In `src/services/views/viewService.ts` (import `inactiveViewIds`):

```ts
/**
 * Which views the original database has off; undefined when there is no
 * original to ask, or it cannot be read - the tree then shows everything.
 */
export async function originalInactiveIds(
    read: (dbName: string) => Promise<number[]>,
    dbName: string,
    originalDb?: string
): Promise<Set<number> | undefined> {
    if (!originalDb || originalDb === dbName) {
        return undefined;
    }
    try {
        return new Set(await read(originalDb));
    } catch (error) {
        logger.warn(`Could not read which views are off in ${originalDb}; showing every inactive view:`, error);
        return undefined;
    }
}
```

and `doctorGroups` becomes:

```ts
    /**
     * The tree's content: psql only, so it shows without waiting for a shell.
     * Keeps the note up to date on the way. With the upgrade's original
     * database, the other inactive views it has off too are set apart.
     */
    async doctorGroups(dbName: string, originalDb?: string): Promise<ViewGroups> {
        const [inactive, messages, alsoOff] = await Promise.all([
            listInactiveViews(dbName), getReportMessages(dbName), originalInactiveIds(inactiveViewIds, dbName, originalDb)
        ]);
        // ... the existing body, unchanged ...
        return groupViews(inactive, reported, reEnabled, edited, alsoOff);
    }
```

- [ ] **Step 5: The tree**

In `src/views/viewDoctorView.ts` (import `upgradePair, type PairProject` from `./viewPairing`):
- export the key and options:

```ts
/** workspaceState: whether "Other inactive views" also lists those the original has off too. */
export const SHOW_ALSO_OFF_KEY = 'viewDoctor.showAlsoOff';

export interface DoctorRowOptions {
    /** The upgrade's original database, when the tree shows the upgraded one. */
    originalDb?: string;
    showAlsoOff?: boolean;
}

export interface ViewDoctorOptions {
    showAlsoOff?(): boolean;
    /** Told on every load whether the tree compares with an original database. */
    onComparing?(comparing: boolean): void;
}
```

- `ViewItem`'s constructor gets `alsoOffIn?: string` as a fifth parameter, and its description becomes:

```ts
        this.description = `${view.model || view.type} · ${view.xmlid ?? `#${view.id}`}${alsoOffIn ? ` · off in ${alsoOffIn} too` : ''}`;
```

- `buildDoctorRows(dbName: string, groups: ViewGroups, options: DoctorRowOptions = {})`; replace the "Other inactive views" block with:

```ts
    const alsoOff = groups.alsoOffInOriginal ?? [];
    if (groups.otherInactive.length > 0 || alsoOff.length > 0) {
        const original = options.originalDb ?? 'the original';
        const shown = options.showAlsoOff
            ? [...groups.otherInactive, ...alsoOff].sort((a, b) => a.model.localeCompare(b.model) || a.id - b.id)
            : groups.otherInactive;
        const alsoOffIds = new Set(alsoOff.map(view => view.id));
        const children: vscode.TreeItem[] = shown.map(view =>
            new ViewItem(dbName, view, 'other', [], alsoOffIds.has(view.id) ? original : undefined));
        if (shown.length === 0) {
            children.push(messageItem(`All ${alsoOff.length} are off in ${original} too.`, 'eye-closed'));
        }
        rows.push(new ViewGroupItem(
            'Other inactive views',
            `${dbName}:group:other`,
            children,
            false,
            alsoOff.length > 0 ? `${shown.length} · ${alsoOff.length} also off in ${original}` : String(shown.length)
        ));
    }
```

- `ViewDoctorTreeProvider`'s constructor gets `private readonly options: ViewDoctorOptions = {}` as a third parameter, and `load()` becomes:

```ts
    private async load(): Promise<vscode.TreeItem[]> {
        const result = await SettingsStore.peekSelectedProject().catch(() => null);
        const project = result?.project as PairProject | undefined;
        const target = resolveViewDoctorTarget(project as Parameters<typeof resolveViewDoctorTarget>[0]);
        this.describe?.(target?.dbName);
        const originalDb = target?.side === 'to' ? upgradePair(project)?.original.dbName : undefined;
        const comparing = !!target && !!originalDb && originalDb !== target.dbName;
        this.options.onComparing?.(comparing);
        if (!target) {
            return [];
        }
        try {
            const groups = await this.service.doctorGroups(target.dbName, comparing ? originalDb : undefined);
            return buildDoctorRows(target.dbName, groups, {
                originalDb: comparing ? originalDb : undefined,
                showAlsoOff: this.options.showAlsoOff?.() ?? false
            });
        } catch (error) {
            logger.warn(`Could not read the views of ${target.dbName}:`, error);
            return [messageItem(`Could not read the views of ${target.dbName}: ${errorMessage(error)}`, 'error')];
        }
    }
```

- [ ] **Step 6: Toggles and wiring**

In `src/extension.ts`: import `SHOW_ALSO_OFF_KEY` with `ViewDoctorTreeProvider`; give the provider its options:

```ts
        views: new ViewDoctorTreeProvider(viewService, dbName => {
            if (viewDoctorTreeView) {
                viewDoctorTreeView.description = dbName;
            }
        }, {
            showAlsoOff: () => context.workspaceState.get<boolean>(SHOW_ALSO_OFF_KEY, false),
            onComparing: comparing => void vscode.commands.executeCommand('setContext', 'odoo-debugger.viewDoctor.comparing', comparing)
        })
```

and, right after `providers` is built: `void vscode.commands.executeCommand('setContext', 'odoo-debugger.viewDoctor.showAlsoOff', context.workspaceState.get<boolean>(SHOW_ALSO_OFF_KEY, false));`

In `src/commands/viewDoctorCommands.ts` (import `SHOW_ALSO_OFF_KEY`):

```ts
    const showAlsoOff = async (show: boolean): Promise<void> => {
        await context.workspaceState.update(SHOW_ALSO_OFF_KEY, show);
        await vscode.commands.executeCommand('setContext', 'odoo-debugger.viewDoctor.showAlsoOff', show);
        providers.views.refresh();
    };
    context.subscriptions.push(registerCommand('viewDoctor.showAlsoOff', () => showAlsoOff(true)));
    context.subscriptions.push(registerCommand('viewDoctor.hideAlsoOff', () => showAlsoOff(false)));
```

`package.json`:
- commands:
  `{ "command": "viewDoctor.showAlsoOff", "title": "Show Views Also Off in the Original", "category": "Odoo DevTools", "icon": "$(eye)" },`
  `{ "command": "viewDoctor.hideAlsoOff", "title": "Hide Views Also Off in the Original", "category": "Odoo DevTools", "icon": "$(eye-closed)" },`
- `view/title`:
  `{ "command": "viewDoctor.showAlsoOff", "when": "view == viewDoctor && odoo-debugger.viewDoctor.comparing && !odoo-debugger.viewDoctor.showAlsoOff", "group": "navigation@1" },`
  `{ "command": "viewDoctor.hideAlsoOff", "when": "view == viewDoctor && odoo-debugger.viewDoctor.comparing && odoo-debugger.viewDoctor.showAlsoOff", "group": "navigation@1" },`
- `commandPalette`: both `"when": "false"`.

- [ ] **Step 7: Run the tests**

Run: `npx tsc -p . --noEmit && npm run lint && npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View Doctor|Views tree|View service|Views also off"`
Expected: PASS (existing `buildDoctorRows` and `groupViews` tests unchanged: their new parameters are optional). `git checkout -- dist`.

- [ ] **Step 8: Commit**

```bash
git add src/services/views/viewQueries.ts src/services/views/viewGroups.ts src/services/views/viewService.ts src/views/viewDoctorView.ts src/commands/viewDoctorCommands.ts src/extension.ts package.json src/test/viewGroups.test.ts src/test/viewDoctorView.test.ts src/test/viewService.test.ts
git commit -m "[ADD] In Upgrade mode, hide inactive views the original has off too

\"Other inactive views\" now leaves out the views that are off in the
upgrade's original database as well - compared by id, since the upgraded
database is a copy - so what the upgrade broke stands out. The group says
how many it hides, and the eye on the Views title shows them again,
remembered per workspace. If the original cannot be read, everything shows.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Render QWeb reports as HTML

**Files:**
- Modify: `resources/scripts/view_worker.py` (`_top`, `cmd_report_target`, `cmd_recent_ids` domain, `COMMANDS`)
- Modify: `src/services/views/viewService.ts` (`ReportTarget`, `reportTarget`, `recentIds` domain)
- Modify: `src/services/views/renderPlan.ts` (`reportPath`, `QWEB_FRAGMENT_MESSAGE` replaces `qwebMessage`)
- Modify: `src/services/views/renderSession.ts` (`RenderTarget.kind`, report sides, modes)
- Modify: `src/commands/viewDoctorCommands.ts` (`viewDoctor.render`)
- Test: `src/test/renderPlan.test.ts`, `src/test/renderSession.test.ts`, `src/test/viewService.test.ts`, `src/test/viewRenderPanel.test.ts` (fakes), `src/test/viewWorker.integration.test.ts`

**Interfaces:**
- Consumes: `target()` (Task 4); `findCounterpart`, `upgradePair` (viewPairing); the proxy handle (`FrameProxyHandle`).
- Produces:
  ```ts
  // viewService.ts
  export interface ReportTarget { reportName: string; name: string; model: string; domain: unknown[]; series: string }
  //   ViewService.reportTarget(dbName: string, viewId: number): Promise<ReportTarget | null>
  //   ViewService.recentIds(dbName: string, model: string, limit = 200, domain: unknown[] = []): Promise<number[]>
  // renderPlan.ts
  export const QWEB_FRAGMENT_MESSAGE: string;
  export function reportPath(reportName: string, resId: number, debug?: boolean): string
  // renderSession.ts
  //   RenderTarget.kind?: 'view' | 'report'
  //   RenderBackend.reportTarget(dbName, viewId): Promise<ReportTarget | null>
  //   RenderBackend.recentIds(dbName, model, limit?, domain?): Promise<number[]>
  ```
  - Worker `report_target { view_id }` → `{ report_name, name, model, domain, series }` or `null`; `recent_ids { model, limit, domain }`.

- [ ] **Step 1: Write the failing tests**

`src/test/renderPlan.test.ts`: change the import to `{ QWEB_FRAGMENT_MESSAGE, commonIds, framePath, reportPath, usesOdooRouter }`; replace the "QWeb says where to look instead" test with:

```ts
    test('a QWeb fragment says where to look instead', () => {
        assert.match(QWEB_FRAGMENT_MESSAGE, /^QWeb templates render inside the page that uses them/);
    });

    test('a report renders as HTML on its record', () => {
        assert.strictEqual(reportPath('account.report_invoice', 7), '/report/html/account.report_invoice/7?debug=1');
        assert.strictEqual(reportPath('odd name/x', 7, false), '/report/html/odd%20name%2Fx/7?debug=0');
    });
```

`src/test/renderSession.test.ts`: the `backend()` fake gets `reportTarget` and records `recentIds` domains. Change it to:

```ts
function backend(
    ids: Record<string, number[]>,
    actions: Record<string, Partial<RenderAction> | Error> = {},
    reports: Record<string, ReportTarget | null> = {}
): RenderBackend & { recentCalls: string[]; domains: unknown[][] } {
    const recentCalls: string[] = [];
    const domains: unknown[][] = [];
    return {
        recentCalls,
        domains,
        newSession: async dbName => `sid-${dbName}`,
        makeAction: async dbName => {
            const action = actions[dbName];
            if (action instanceof Error) {
                throw action;
            }
            return { actionId: dbName === 'shop-17' ? 11 : 21, model: 'res.partner', viewType: 'form', rootId: 7, series: dbName === 'shop-17' ? '17.0' : '18.0', ...action };
        },
        reportTarget: async dbName => dbName in reports ? reports[dbName] : null,
        recentIds: async (dbName, _model, _limit, domain = []) => {
            recentCalls.push(dbName);
            domains.push(domain);
            return ids[dbName] ?? [];
        }
    };
}
```

(import `type ReportTarget` from `../services/views/viewService`), and add tests:

```ts
    const invoice = (series: string): ReportTarget => ({ reportName: 'account.report_invoice', name: 'Invoices', model: 'account.move', domain: [['move_type', '!=', 'entry']], series });
    const reportOf = (target: RenderTarget): RenderTarget => ({ ...target, kind: 'report' });

    test('a report shows the same invoice on both sides, as HTML, and steps without a new record', async () => {
        const fake = backend({ 'shop-17': [9, 7, 5], 'shop-18': [8, 7, 5] }, {}, { 'shop-17': invoice('17.0'), 'shop-18': invoice('18.0') });
        const session = await RenderSession.prepare([reportOf(original), reportOf(upgraded)], fake, host());
        const state = await session.state();
        assert.deepStrictEqual(state.sides.map(side => nextOf(side.url)), ['/report/html/account.report_invoice/7?debug=1', '/report/html/account.report_invoice/7?debug=1']);
        assert.deepStrictEqual(state.record, { label: 'Record 7', canPrevious: false, canNext: true, canNew: false });
        assert.strictEqual(state.sides[0].detail, 'Odoo 17.0 · Invoices · record 7');
        assert.deepStrictEqual(fake.domains, [[['move_type', '!=', 'entry']], [['move_type', '!=', 'entry']]]);
        assert.strictEqual(session.newRecord(), false);
    });

    test('a report with no shared record says so in place of the frames', async () => {
        const fake = backend({ 'shop-17': [9], 'shop-18': [8] }, {}, { 'shop-17': invoice('17.0'), 'shop-18': invoice('18.0') });
        const state = await (await RenderSession.prepare([reportOf(original), reportOf(upgraded)], fake, host())).state();
        assert.ok(state.sides.every(side => !side.url && side.message === 'No account.move record exists in both databases to render this report with.'), JSON.stringify(state.sides));
        assert.strictEqual(state.record, undefined);
        const single = await (await RenderSession.prepare([reportOf(upgraded)], backend({}, {}, { 'shop-18': invoice('18.0') }), host())).state();
        assert.strictEqual(single.sides[0].message, 'No account.move record to render this report with.');
    });

    test('a side whose database has no such report says so; the other still renders', async () => {
        const fake = backend({ 'shop-18': [8] }, {}, { 'shop-17': null, 'shop-18': invoice('18.0') });
        const state = await (await RenderSession.prepare([reportOf(original), reportOf(upgraded)], fake, host())).state();
        assert.strictEqual(state.sides[0].message, 'shop-17 has no report for this template.');
        assert.strictEqual(nextOf(state.sides[1].url), '/report/html/account.report_invoice/8?debug=1');
    });
```

`src/test/viewRenderPanel.test.ts`: every `RenderBackend` literal gains `reportTarget: async () => null,`.

`src/test/viewService.test.ts`: in the first suite, `recent_ids` is now called with a domain: change the expected call to `['shop-18', 'recent_ids', { model: 'res.partner', limit: 200, domain: [] }]`, and add:

```ts
suite('View service reports', () => {
    test('resolves a report through the shell, and passes its domain to recent_ids', async () => {
        const calls: Array<[string, string, unknown]> = [];
        const service = new ViewService(fakePool({
            report_target: { report_name: 'account.report_invoice', name: 'Invoices', model: 'account.move', domain: [['move_type', '!=', 'entry']], series: '18.0' },
            recent_ids: { ids: [3] }
        }, calls));
        const report = await service.reportTarget('shop-18', 40);
        assert.deepStrictEqual(report, { reportName: 'account.report_invoice', name: 'Invoices', model: 'account.move', domain: [['move_type', '!=', 'entry']], series: '18.0' });
        assert.deepStrictEqual(await service.recentIds('shop-18', report!.model, 5, report!.domain), [3]);
        assert.deepStrictEqual(calls[1], ['shop-18', 'recent_ids', { model: 'account.move', limit: 5, domain: [['move_type', '!=', 'entry']] }]);
        assert.strictEqual(await new ViewService(fakePool({ report_target: null }, [])).reportTarget('shop-18', 41), null);
    });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run compile-tests` — Expected: tsc errors (`reportPath`, `QWEB_FRAGMENT_MESSAGE`, `ReportTarget`, `kind`).

- [ ] **Step 3: The worker**

In `resources/scripts/view_worker.py`, after `_root`:

```python
def _top(view):
    """The top of the view's inherit_id chain, whatever the modes: what the
    Views tree's isReport looks at, and odoo-manager's find_report_for_view."""
    top = view
    seen = set()
    while top.inherit_id and top.id not in seen:
        seen.add(top.id)
        top = top.inherit_id
    return top
```

Replace `cmd_recent_ids` with (signature and the search line change):

```python
def cmd_recent_ids(env, model, limit=200, domain=None):
    """The newest records of a model that the render user can open, newest
    first; none for a model this database does not have. `domain` narrows
    them (a report's records)."""
    if model not in env or env[model]._abstract:
        return {'ids': []}
    user = _render_user(env)
    try:
        # The default company, as the frame opens it, decides what is visible.
        records = env[model].with_user(user).with_context(allowed_company_ids=[user.company_id.id]).search(
            list(domain or []), order='id desc', limit=int(limit))
    except Exception as error:
        if _connection_lost(env, error):
            raise
        env.cr.rollback()
        return {'ids': []}
    return {'ids': records.ids}
```

Add after it:

```python
def cmd_report_target(env, view_id):
    """The report a QWeb view's template renders, or None: the first report
    whose report_name is an external id of the view's root - the template
    Odoo renders under that key (_root stops at a primary view), else the top
    of its chain. account.move also holds plain journal entries, which render
    an empty invoice, so its records are the other move types only."""
    view = _view(env, view_id)
    data = env['ir.model.data']
    reports = env['ir.actions.report']
    for root in dict.fromkeys([_root(view), _top(view)]):
        names = ['%s.%s' % (row.module, row.name)
                 for row in data.search([('model', '=', 'ir.ui.view'), ('res_id', '=', root.id)], order='module, name')]
        report = reports.search([('report_name', 'in', names)], order='id', limit=1) if names else reports
        if report:
            domain = [['move_type', '!=', 'entry']] if report.model == 'account.move' else []
            return {'report_name': report.report_name, 'name': report.name, 'model': report.model,
                    'domain': domain, 'series': odoo.release.serie}
    return None
```

`COMMANDS`: add `'report_target': cmd_report_target,` after `'recent_ids'`.

- [ ] **Step 4: The service**

In `src/services/views/viewService.ts`, after `RenderAction`:

```ts
/** The report a QWeb template renders, as its database's shell found it. */
export interface ReportTarget {
    /** What /report/html/<report_name>/<id> takes. */
    reportName: string;
    /** The report's name, for the frame header. */
    name: string;
    model: string;
    /** Narrows the records to render it with (account.move: no plain journal entries). */
    domain: unknown[];
    series: string;
}
```

and replace `recentIds`, adding `reportTarget`:

```ts
    /** The newest ids of a model the render user can open, newest first. */
    async recentIds(dbName: string, model: string, limit = 200, domain: unknown[] = []): Promise<number[]> {
        return (await this.pool.run<{ ids: number[] }>(dbName, 'recent_ids', { model, limit, domain })).ids;
    }

    /** The report a QWeb view's template renders; null when no report uses it. */
    async reportTarget(dbName: string, viewId: number): Promise<ReportTarget | null> {
        const raw = await this.pool.run<{ report_name: string; name: string; model: string; domain?: unknown[]; series: string } | null>(
            dbName, 'report_target', { view_id: viewId });
        return raw ? { reportName: raw.report_name, name: raw.name, model: raw.model, domain: raw.domain ?? [], series: raw.series } : null;
    }
```

- [ ] **Step 5: The render plan**

In `src/services/views/renderPlan.ts`, replace `qwebMessage` with:

```ts
/** What a QWeb template that no report renders says instead: it needs the page around it. */
export const QWEB_FRAGMENT_MESSAGE = 'QWeb templates render inside the page that uses them; open it from Odoo.';

/** A report rendered as HTML on one record, as Odoo's Print menu does. */
export function reportPath(reportName: string, resId: number, debug = true): string {
    return `/report/html/${encodeURIComponent(reportName)}/${resId}?debug=${debug ? 1 : 0}`;
}
```

(`grep -rn qwebMessage src` — the only other user is `viewDoctorCommands.ts`, changed in Step 7.)

- [ ] **Step 6: The render session**

In `src/services/views/renderSession.ts`:
- imports: `import type { RenderAction, ReportTarget } from './viewService';` and `reportPath` from `./renderPlan`.
- `RenderTarget` gains:

```ts
    /** A report renders its template on a record; a view opens in the web client. Default 'view'. */
    kind?: 'view' | 'report';
```

- `RenderBackend` becomes:

```ts
export interface RenderBackend {
    newSession(dbName: string): Promise<string>;
    makeAction(dbName: string, viewId: number): Promise<RenderAction>;
    reportTarget(dbName: string, viewId: number): Promise<ReportTarget | null>;
    recentIds(dbName: string, model: string, limit?: number, domain?: unknown[]): Promise<number[]>;
}
```

- `PreparedSide` gains `report?: ReportTarget;`.
- `prepareSide` becomes:

```ts
async function prepareSide(target: RenderTarget, backend: RenderBackend, host: FrameHost): Promise<PreparedSide> {
    try {
        const connect = async () => {
            const port = await host.portFor(target.dbName, target.versionId);
            const proxy = await host.proxyFor(target.dbName, port, () => backend.newSession(target.dbName));
            return { port, proxy };
        };
        if (target.kind === 'report') {
            const report = await backend.reportTarget(target.dbName, target.viewId);
            if (!report) {
                return { target, ids: [], error: `${target.dbName} has no report for this template.` };
            }
            const { port, proxy } = await connect();
            const [, origin, ids] = await Promise.all([
                proxy.session(),
                host.externalOrigin(`http://127.0.0.1:${proxy.port}`),
                backend.recentIds(target.dbName, report.model, RECENT_LIMIT, report.domain)
            ]);
            return { target, port, report, proxy, origin, ids };
        }
        const action = await backend.makeAction(target.dbName, target.viewId);
        const { port, proxy } = await connect();
        const [, origin, ids] = await Promise.all([
            proxy.session(),
            host.externalOrigin(`http://127.0.0.1:${proxy.port}`),
            action.viewType === 'form' ? backend.recentIds(target.dbName, action.model, RECENT_LIMIT) : Promise.resolve([])
        ]);
        return { target, port, action, proxy, origin, ids };
    } catch (error) {
        return { target, ids: [], error: errorMessage(error) };
    }
}
```

- `RenderSession`: replace the `isForm` field with `mode`, and add the no-record message. The constructor and `prepare` become:

```ts
type RenderMode = 'form' | 'report' | 'other';

export class RenderSession {
    /** Position in `records`; -1 is a new record. */
    private index: number;

    private constructor(
        private readonly sides: PreparedSide[],
        private readonly host: FrameHost,
        private readonly records: number[],
        private readonly mode: RenderMode,
        private readonly notice: string | undefined,
        /** Shown in place of a report's frames when there is no record to render it with. */
        private readonly noRecord: string | undefined
    ) {
        this.index = records.length > 0 ? 0 : -1;
    }

    static async prepare(targets: RenderTarget[], backend: RenderBackend, host: FrameHost): Promise<RenderSession> {
        const sides = await Promise.all(targets.map(target => prepareSide(target, backend, host)));
        const ready = sides.filter(side => side.action || side.report);
        const mode: RenderMode = ready.length === 0 ? 'other'
            : ready.every(side => side.report) ? 'report'
            : ready.every(side => side.action?.viewType === 'form') ? 'form' : 'other';
        let records: number[] = [];
        let notice: string | undefined;
        let noRecord: string | undefined;
        if (mode !== 'other') {
            records = ready.map(side => side.ids).reduce((a, b) => commonIds(a, b));
        }
        if (mode === 'form' && records.length === 0) {
            notice = ready.length > 1 ? NO_COMMON_RECORD : `${ready[0].action?.model} has no record yet; showing a new one.`;
        }
        if (mode === 'report' && records.length === 0) {
            const model = ready[0].report?.model;
            noRecord = ready.length > 1
                ? `No ${model} record exists in both databases to render this report with.`
                : `No ${model} record to render this report with.`;
        }
        return new RenderSession(sides, host, records, mode, notice, noRecord);
    }
```

- `state()`:

```ts
    async state(): Promise<RenderState> {
        const resId = this.index >= 0 ? this.records[this.index] : undefined;
        const sides = await Promise.all(this.sides.map(side => this.sideState(side, resId)));
        let record: RenderRecordState | undefined;
        if (this.mode === 'form') {
            record = {
                label: resId ? `Record ${resId}` : 'New record',
                canPrevious: this.index > 0 || (this.index === -1 && this.records.length > 0),
                canNext: this.index >= 0 && this.index < this.records.length - 1,
                canNew: this.index !== -1
            };
        } else if (this.mode === 'report' && resId !== undefined) {
            record = { label: `Record ${resId}`, canPrevious: this.index > 0, canNext: this.index < this.records.length - 1, canNew: false };
        }
        return { sides, notice: this.notice, record };
    }
```

- `newRecord()`: `if (this.mode !== 'form' || this.index === -1) { return false; }`
- `sideState`, at its top after `const base = …`, handle report sides first:

```ts
        if (side.report) {
            const { report, proxy, port, origin } = side;
            if (!proxy || port === undefined || !origin) {
                return { ...base, message: side.error ?? 'This side cannot render.' };
            }
            const detail = `Odoo ${report.series} · ${report.name}${resId ? ` · record ${resId}` : ''}`;
            if (resId === undefined) {
                return { ...base, detail, message: this.noRecord ?? `No ${report.model} record to render this report with.` };
            }
            if (!await this.host.isPortOpen(port)) {
                return { ...base, detail, message: `No Odoo server is answering on port ${port}.`, offerStart: true };
            }
            return { ...base, detail, url: `${origin}${proxy.gatePath(reportPath(report.reportName, resId))}` };
        }
```

  (the existing view branch below it stays; its `framePath` call is unchanged in this task.)

- [ ] **Step 7: The Render command**

In `src/commands/viewDoctorCommands.ts`: import `QWEB_FRAGMENT_MESSAGE` instead of `qwebMessage`; in `viewDoctor.render` replace the qweb early return with:

```ts
        // A template no report uses needs the page around it: nothing to render here.
        if (item.view.type === 'qweb' && !item.view.isReport) {
            void showInfo(QWEB_FRAGMENT_MESSAGE);
            return;
        }
        const kind: RenderTarget['kind'] = item.view.type === 'qweb' ? 'report' : 'view';
```

and add `kind` to each of the three `RenderTarget` literals in that command (`{ dbName: …, versionId: …, viewId: …, title: …, kind }`).

- [ ] **Step 8: Integration tests**

In `src/test/viewWorker.integration.test.ts`, add before the drop test:

```ts
    test('report_target finds a report through its template and its patches; a form has none', async () => {
        const [reportName, model, templateId] = (await runSql(copy, `
            SELECT a.report_name || '|' || a.model || '|' || d.res_id FROM ir_act_report_xml a
            JOIN ir_model_data d ON d.model = 'ir.ui.view' AND d.module || '.' || d.name = a.report_name
            ORDER BY a.id LIMIT 1;`)).split('|');
        assert.ok(reportName, 'base installs no report with a template');
        const report = await service.reportTarget(copy, Number(templateId));
        assert.deepStrictEqual([report?.reportName, report?.model, report?.domain], [reportName, model, []]);
        assert.match(report?.series ?? '', /\d+\.\d+/);

        const arch = (await archIsJsonb(copy)) ? `jsonb_build_object('en_US', '<data/>')` : `'<data/>'`;
        const patchId = Number(await runSql(copy, `INSERT INTO ir_ui_view (name, type, mode, priority, active, inherit_id, arch_db)
            VALUES ('odt.report.patch', 'qweb', 'extension', 16, false, ${Number(templateId)}, ${arch}) RETURNING id;`));
        assert.strictEqual((await service.reportTarget(copy, patchId))?.reportName, reportName);

        const formId = Number(await runSql(copy, "SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'view_partner_form';"));
        assert.strictEqual(await service.reportTarget(copy, formId), null);
        assert.deepStrictEqual(await service.recentIds(copy, 'res.partner', 5, [['id', '<', 0]]), [], 'the domain narrows the records');
    });

    test('a report renders as HTML through the frame proxy, as admin', async () => {
        const [reportName, model, templateId] = (await runSql(copy, `
            SELECT a.report_name || '|' || a.model || '|' || d.res_id FROM ir_act_report_xml a
            JOIN ir_model_data d ON d.model = 'ir.ui.view' AND d.module || '.' || d.name = a.report_name
            ORDER BY a.id LIMIT 1;`)).split('|');
        const report = await service.reportTarget(copy, Number(templateId));
        const [record] = await service.recentIds(copy, model, 1, report!.domain);
        assert.ok(record, `no ${model} record to render ${reportName} with`);
        const server = await startOdooServer(copy);
        const proxy = new OdooFrameProxy({
            targetPort: server.port,
            mintSession: async () => {
                const sid = await service.newSession(copy);
                mintedSids.push(sid);
                return sid;
            }
        });
        try {
            await proxy.listen();
            const page = await frameGet(proxy.port, proxy.gatePath(`/report/html/${encodeURIComponent(reportName)}/${record}?debug=1`), []);
            assert.strictEqual(page.status, 200, `ended on ${page.path}`);
            assert.ok(!page.path.startsWith('/web/login'), 'Odoo did not accept the minted session');
            assert.strictEqual(page.headers['x-frame-options'], undefined);
        } finally {
            await proxy.close();
            await server.stop();
        }
    });
```

(If `archIsJsonb` is not already used in the file, it is defined near the top; reuse it.)

- [ ] **Step 9: Run the tests**

Run: `npx tsc -p . --noEmit && npm run lint && npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Render|View service"` — Expected: PASS. Then the integration suite on `odt_view_base_19` (Task 2 Step 8). `git checkout -- dist`.

- [ ] **Step 10: Commit**

```bash
git add resources/scripts/view_worker.py src/services/views/viewService.ts src/services/views/renderPlan.ts src/services/views/renderSession.ts src/commands/viewDoctorCommands.ts src/test/renderPlan.test.ts src/test/renderSession.test.ts src/test/viewService.test.ts src/test/viewRenderPanel.test.ts src/test/viewWorker.integration.test.ts
git commit -m "[ADD] Render QWeb reports in the render tab

Render on a report's template, or a patch of one, now shows the report as
HTML through the same gated proxy, on the newest record both databases
share - for invoices, the newest that is not a plain journal entry - and
steps through the shared records. A side whose database has no such report,
or a model with no record, says so. Templates no report uses still say to
open them from Odoo.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Debug toggle and PDF in the render tab

**Files:**
- Create: `src/services/views/reportPdf.ts`
- Modify: `src/services/views/renderPlan.ts` (`framePath` debug)
- Modify: `src/services/views/renderSession.ts` (`state({ debug })`, `pdf` flag, `pdfSource`)
- Modify: `src/views/viewRenderPanel.ts` (checkbox, PDF button, settings, messages)
- Modify: `src/extension.ts` (panel settings)
- Test: `src/test/reportPdf.test.ts` (new), `src/test/renderPlan.test.ts`, `src/test/renderSession.test.ts`, `src/test/viewRenderPanel.test.ts`, `src/test/viewWorker.integration.test.ts`

**Interfaces:**
- Consumes: Task 8's report sides and `reportPath(name, id, debug)`.
- Produces:
  ```ts
  // reportPdf.ts
  export function reportPdfPath(reportName: string, resId: number): string
  export function pdfFileName(dbName: string, reportName: string, resId: number): string
  export function fetchReportPdf(port: number, path: string, sid: string, timeoutMs?: number): Promise<Buffer>
  // renderPlan.ts
  //   FramePathInput.debug?: boolean  (default true; false sends debug=0)
  // renderSession.ts
  //   RenderSideState.pdf?: boolean
  //   RenderSession.state(options?: { debug?: boolean }): Promise<RenderState>
  //   RenderSession.pdfSource(key: string): PdfSource | undefined
  export interface PdfSource { dbName: string; port: number; path: string; fileName: string; session(): Promise<string> }
  // viewRenderPanel.ts
  export interface RenderSettings { debug(): boolean; setDebug(debug: boolean): Thenable<void> | void }
  //   new ViewRenderPanel(backend, host?, settings?)
  //   renderPanelHtml(state, { nonce, cspSource, startLabel?, debug? })
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/test/reportPdf.test.ts`:

```ts
import * as assert from 'assert';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchReportPdf, pdfFileName, reportPdfPath } from '../services/views/reportPdf';

async function fakeOdoo(answer: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<{ port: number; close(): Promise<void> }> {
    const server = http.createServer(answer);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, close: () => new Promise(resolve => server.close(() => resolve())) };
}

suite('Report PDF', () => {
    test('paths and file names', () => {
        assert.strictEqual(reportPdfPath('account.report_invoice', 7), '/report/pdf/account.report_invoice/7');
        assert.strictEqual(pdfFileName('shop 18', 'account.report/invoice', 7), 'odt-report-shop_18-account.report_invoice-7.pdf');
    });

    test('fetches with the session cookie and accepts only a PDF', async () => {
        const cookies: string[] = [];
        const odoo = await fakeOdoo((request, response) => {
            cookies.push(String(request.headers.cookie));
            if (request.url === '/report/pdf/r/1') {
                response.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.4 fake');
            } else if (request.url === '/report/pdf/r/2') {
                response.writeHead(200, { 'content-type': 'text/html' }).end('<html>wkhtmltopdf missing</html>');
            } else {
                response.writeHead(303, { location: '/web/login' }).end();
            }
        });
        try {
            assert.strictEqual((await fetchReportPdf(odoo.port, '/report/pdf/r/1', 'abc')).toString('latin1'), '%PDF-1.4 fake');
            assert.deepStrictEqual(cookies, ['session_id=abc']);
            await assert.rejects(fetchReportPdf(odoo.port, '/report/pdf/r/2', 'abc'), /did not send a PDF/);
            await assert.rejects(fetchReportPdf(odoo.port, '/report/pdf/r/3', 'abc'), /answered 303/);
        } finally {
            await odoo.close();
        }
    });
});
```

`src/test/renderPlan.test.ts`, add:

```ts
    test('debug off is said, not left out: Odoo keeps the last debug mode in the session', () => {
        const base = { actionId: 41, model: 'res.partner', viewType: 'form', resId: 7 };
        assert.strictEqual(framePath({ ...base, series: '19.0', debug: false }), '/odoo/action-41/7?debug=0');
        assert.strictEqual(framePath({ ...base, series: '17.0', debug: false }), '/web?debug=0#action=41&model=res.partner&view_type=form&id=7');
        assert.strictEqual(framePath({ ...base, series: '19.0', debug: true }), '/odoo/action-41/7?debug=1');
    });
```

`src/test/renderSession.test.ts`, add (reusing Task 8's `invoice`/`reportOf`):

```ts
    test('the debug flag reaches every frame, and a report side offers its PDF', async () => {
        const views = await RenderSession.prepare([original, upgraded], backend({ 'shop-17': [7], 'shop-18': [7] }), host());
        assert.ok((await views.state({ debug: false })).sides.every(side => nextOf(side.url).includes('debug=0')));
        assert.ok((await views.state()).sides.every(side => !side.pdf));
        assert.strictEqual(views.pdfSource('shop-18'), undefined);

        const reports = await RenderSession.prepare([reportOf(upgraded)], backend({ 'shop-18': [8, 5] }, {}, { 'shop-18': invoice('18.0') }), host());
        const state = await reports.state({ debug: false });
        assert.strictEqual(nextOf(state.sides[0].url), '/report/html/account.report_invoice/8?debug=0');
        assert.strictEqual(state.sides[0].pdf, true);
        const source = reports.pdfSource('shop-18');
        assert.deepStrictEqual([source?.dbName, source?.port, source?.path, source?.fileName],
            ['shop-18', 8018, '/report/pdf/account.report_invoice/8', 'odt-report-shop-18-account.report_invoice-8.pdf']);
        assert.strictEqual(await source?.session(), 'sid-shop-18');
        reports.next();
        assert.strictEqual(reports.pdfSource('shop-18')?.path, '/report/pdf/account.report_invoice/5', 'follows the record shown');
        assert.strictEqual(reports.pdfSource('nope'), undefined);
    });
```

`src/test/viewRenderPanel.test.ts`, add:

```ts
    test('the Debug box shows the setting, and PDF shows only on a report side', () => {
        const report = { ...state, sides: [{ ...state.sides[0], pdf: true }, state.sides[1]] };
        const on = renderPanelHtml(report, { nonce: 'n', cspSource: 'x', debug: true });
        assert.ok(/<input type="checkbox" data-toggle="debug" checked>/.test(on), on);
        assert.strictEqual((on.match(/data-action="pdf"/g) ?? []).length, 1);
        assert.ok(on.includes('data-action="pdf" data-key="shop-17"'));
        const off = renderPanelHtml(state, { nonce: 'n', cspSource: 'x', debug: false });
        assert.ok(/<input type="checkbox" data-toggle="debug">/.test(off), off);
        assert.ok(!off.includes('data-action="pdf"'));
    });

    test('turning Debug off is remembered and reloads the frames without debug', async () => {
        let debug = true;
        const backend: RenderBackend = {
            newSession: async () => 'sid',
            makeAction: async () => ({ actionId: 3, model: 'res.partner', viewType: 'list', rootId: 1, series: '18.0' }),
            reportTarget: async () => null,
            recentIds: async () => []
        };
        const host: FrameHost = {
            portFor: async () => 8018,
            isPortOpen: async () => true,
            proxyFor: async (_db, port, mint) => ({ port: port + 1000, session: mint, gatePath: next => `/__odt/open?t=x&next=${encodeURIComponent(next)}` }),
            externalOrigin: async origin => origin
        };
        const panel = new ViewRenderPanel(backend, host, { debug: () => debug, setDebug: value => { debug = value; } });
        try {
            await panel.show({ title: 'Partners', targets: [{ dbName: 'shop-18', viewId: 1, title: 'shop-18' }], startCommand: 'x', startLabel: 'Start' });
            await (panel as unknown as { onMessage(message: unknown): Promise<void> }).onMessage({ type: 'action', action: 'debug', value: false });
            assert.strictEqual(debug, false);
            const html = (panel as unknown as { panel: { webview: { html: string } } }).panel.webview.html;
            assert.ok(html.includes('debug%3D0'), 'the frame URL did not turn debug off');
            assert.ok(/<input type="checkbox" data-toggle="debug">/.test(html));
        } finally {
            panel.dispose();
        }
    });
```

In `src/test/viewWorker.integration.test.ts`, add after the Task 8 report test:

```ts
    test('a report\'s PDF comes from the server with the minted session', async function () {
        const [reportName, model, templateId] = (await runSql(copy, `
            SELECT a.report_name || '|' || a.model || '|' || d.res_id FROM ir_act_report_xml a
            JOIN ir_model_data d ON d.model = 'ir.ui.view' AND d.module || '.' || d.name = a.report_name
            ORDER BY a.id LIMIT 1;`)).split('|');
        const report = await service.reportTarget(copy, Number(templateId));
        const [record] = await service.recentIds(copy, model, 1, report!.domain);
        const sid = await service.newSession(copy);
        mintedSids.push(sid);
        const server = await startOdooServer(copy);
        try {
            const pdf = await fetchReportPdf(server.port, reportPdfPath(reportName, record), sid);
            assert.strictEqual(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
        } finally {
            await server.stop();
        }
    });
```

(import `fetchReportPdf, reportPdfPath` from `../services/views/reportPdf`. wkhtmltopdf 0.12.6 is at `/usr/local/bin/wkhtmltopdf` on this machine.)

- [ ] **Step 2: Run them to see them fail**

Run: `npm run compile-tests` — Expected: tsc errors (`reportPdf` missing, `debug` options, `pdf`, `pdfSource`, the third panel argument).

- [ ] **Step 3: The PDF fetcher**

Create `src/services/views/reportPdf.ts`:

```ts
/**
 * A report's PDF, fetched straight from the database's Odoo server with the
 * render tab's admin session - not through the frame proxy, which only the
 * webview may use. VS Code webviews show no PDF, so the file is opened with
 * the system's viewer instead.
 */
import * as http from 'node:http';

const MAX_PDF_BYTES = 200 * 1024 * 1024;

export function reportPdfPath(reportName: string, resId: number): string {
    return `/report/pdf/${encodeURIComponent(reportName)}/${resId}`;
}

/** A file name with nothing but word characters, dots and dashes from the database and report. */
export function pdfFileName(dbName: string, reportName: string, resId: number): string {
    return `odt-report-${[dbName, reportName, String(resId)].map(part => part.replace(/[^\w.-]+/g, '_')).join('-')}.pdf`;
}

export function fetchReportPdf(port: number, path: string, sid: string, timeoutMs = 120_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const request = http.get({ host: '127.0.0.1', port, path, headers: { cookie: `session_id=${sid}` }, timeout: timeoutMs }, response => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_PDF_BYTES) {
                    request.destroy(new Error('The PDF is larger than 200 MB.'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                if (response.statusCode !== 200) {
                    const location = response.headers.location;
                    reject(new Error(`Odoo answered ${response.statusCode}${location ? ` (to ${location})` : ''}.`));
                    return;
                }
                const body = Buffer.concat(chunks);
                if (body.subarray(0, 5).toString('latin1') !== '%PDF-') {
                    reject(new Error('Odoo did not send a PDF. Is wkhtmltopdf installed where that server runs?'));
                    return;
                }
                resolve(body);
            });
            response.on('error', reject);
        });
        request.on('timeout', () => request.destroy(new Error('Odoo took too long to make the PDF.')));
        request.on('error', reject);
    });
}
```

- [ ] **Step 4: Debug in frame paths and the session; the PDF source**

`src/services/views/renderPlan.ts`: `FramePathInput` gains

```ts
    /** Odoo keeps the last ?debug= in the session, so off is sent as debug=0. Default on. */
    debug?: boolean;
```

and `framePath` uses `const debug = input.debug === false ? 0 : 1;` in both URLs: `` `/odoo/action-${input.actionId}${record ? `/${record}` : ''}?debug=${debug}` `` and `` `/web?debug=${debug}#${hash.join('&')}` ``.

`src/services/views/renderSession.ts`:
- import `pdfFileName, reportPdfPath` from `./reportPdf`.
- `RenderSideState` gains `/** A report side showing a record: it can give its PDF. */ pdf?: boolean;`
- export:

```ts
export interface PdfSource {
    dbName: string;
    /** The Odoo server's own port; the PDF does not go through the proxy. */
    port: number;
    path: string;
    fileName: string;
    /** The admin session the side's frame uses. */
    session(): Promise<string>;
}
```

- `state(options: { debug?: boolean } = {})` passes `options.debug ?? true` into `sideState(side, resId, debug)`; in `sideState` the report URL uses `reportPath(report.reportName, resId, debug)` and that return gets `pdf: true`; the view URL's `framePath({ …, resId, debug })`.
- add:

```ts
    /** What the PDF of the record a report side shows needs; undefined for any other side. */
    pdfSource(key: string): PdfSource | undefined {
        const side = this.sides.find(entry => entry.target.dbName === key);
        const resId = this.index >= 0 ? this.records[this.index] : undefined;
        if (!side?.report || !side.proxy || side.port === undefined || resId === undefined) {
            return undefined;
        }
        const { report, proxy } = side;
        return {
            dbName: side.target.dbName,
            port: side.port,
            path: reportPdfPath(report.reportName, resId),
            fileName: pdfFileName(side.target.dbName, report.reportName, resId),
            session: () => proxy.session()
        };
    }
```

- [ ] **Step 5: The panel**

In `src/views/viewRenderPanel.ts`:
- imports: `import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path';`, `fetchReportPdf` from `../services/views/reportPdf`, `showInfo` with the notifications.
- export:

```ts
/** Where the Debug box's state lives; the default keeps it for this session only. */
export interface RenderSettings {
    debug(): boolean;
    setDebug(debug: boolean): Thenable<void> | void;
}
```

- `SCRIPT` becomes:

```ts
const SCRIPT = `
const vscode = acquireVsCodeApi();
for (const button of document.querySelectorAll('button[data-action]')) {
    button.addEventListener('click', () => vscode.postMessage({ type: 'action', action: button.dataset.action, key: button.dataset.key }));
}
for (const toggle of document.querySelectorAll('input[data-toggle="debug"]')) {
    toggle.addEventListener('change', () => vscode.postMessage({ type: 'action', action: 'debug', value: toggle.checked }));
}
window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.type !== 'reload') {
        return;
    }
    for (const frame of document.querySelectorAll('iframe[data-key]')) {
        if (!message.keys || message.keys.includes(frame.dataset.key)) {
            frame.src = frame.dataset.src;
        }
    }
});
`;
```

- `STYLE` gains `.toolbar label { display: flex; gap: 4px; align-items: center; }`.
- `renderPanelHtml(state, options: { nonce: string; cspSource: string; startLabel?: string; debug?: boolean })`: the toolbar list starts with

```ts
        button('reload', 'Reload'),
        `<label><input type="checkbox" data-toggle="debug"${options.debug === false ? '' : ' checked'}> Debug</label>`,
```

  and each side's header gains, before the start button:

```ts
            ...(side.url && side.pdf ? [`<button data-action="pdf" data-key="${escapeHtml(side.key)}">PDF</button>`] : []),
```

- constructor: `constructor(private readonly backend: RenderBackend, host?: FrameHost, settings?: RenderSettings)`; store `this.settings = settings ?? memorySettings()` where, at module level:

```ts
function memorySettings(): RenderSettings {
    let debug = true;
    return { debug: () => debug, setDebug: value => { debug = value; } };
}
```

  (declare `private readonly settings: RenderSettings;` with the other fields).
- `update()`: `const state = await session.state({ debug: this.settings.debug() });` and pass `debug: this.settings.debug()` to `renderPanelHtml`.
- `onMessage`: parse the whole message once:

```ts
        const data = (message ?? {}) as { type?: unknown; action?: unknown; key?: unknown; value?: unknown };
        const action = data.type === 'action' && typeof data.action === 'string' ? data.action : undefined;
```

  and add cases:

```ts
                case 'debug':
                    await this.settings.setDebug(data.value === true);
                    // Rebuilding the page reloads both frames with the new flag.
                    await this.update();
                    return;
                case 'pdf':
                    if (typeof data.key === 'string') {
                        await this.openPdf(session, data.key);
                    }
                    return;
```

- add:

```ts
    private async openPdf(session: RenderSession, key: string): Promise<void> {
        const source = session.pdfSource(key);
        if (!source) {
            return;
        }
        if (vscode.env.remoteName) {
            void showInfo('PDF opens only in a local VS Code window for now. Print it from Odoo instead.');
            return;
        }
        const file = path.join(os.tmpdir(), source.fileName);
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Getting the PDF from ${source.dbName}…` },
                async () => {
                    const pdf = await fetchReportPdf(source.port, source.path, await source.session());
                    await fs.promises.writeFile(file, pdf, { mode: 0o600 });
                }
            );
        } catch (error) {
            void showError(`Could not get the PDF: ${errorMessage(error)}`);
            return;
        }
        await vscode.env.openExternal(vscode.Uri.file(file));
    }
```

In `src/extension.ts`, the panel gets its setting per workspace:

```ts
    const viewRender = new ViewRenderPanel(viewService, undefined, {
        debug: () => context.workspaceState.get<boolean>('viewDoctor.renderDebug', true),
        setDebug: debug => context.workspaceState.update('viewDoctor.renderDebug', debug)
    });
```

- [ ] **Step 6: Run the tests**

Run: `npx tsc -p . --noEmit && npm run lint && npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Render|Report PDF"` — Expected: PASS. Then the integration suite on `odt_view_base_19` (Task 2 Step 8), then the full suite once. `git checkout -- dist`.

- [ ] **Step 7: Commit**

```bash
git add src/services/views/reportPdf.ts src/services/views/renderPlan.ts src/services/views/renderSession.ts src/views/viewRenderPanel.ts src/extension.ts src/test/reportPdf.test.ts src/test/renderPlan.test.ts src/test/renderSession.test.ts src/test/viewRenderPanel.test.ts src/test/viewWorker.integration.test.ts
git commit -m "[ADD] Debug toggle and report PDFs in the render tab

The render tab's Debug box, on by default and remembered per workspace,
reloads both frames with or without Odoo's debug mode; off is sent as
debug=0, because Odoo keeps the last debug mode in the session. A report
side gets a PDF button: the PDF comes straight from that database's server
with the tab's admin session and opens in the system's viewer, since VS
Code webviews show no PDF. Local windows only for now.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Docs, rebuild, verification

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `dist/` (rebuilt)
- Modify (record): this plan's "Execution record" section; `docs/superpowers/notes/2026-10-06-view-doctor-handover-stage-4.md` (new)

**Interfaces:**
- Consumes: everything above.
- Produces: the shipped docs; the verification record.

- [ ] **Step 1: CHANGELOG**

In `CHANGELOG.md`, `## [Unreleased]` → `### Added`, append these bullets after the upgrade-scripts one, and edit the Render bullet's last two sentences as shown:

Render bullet: replace "QWeb templates and reports are not rendered here. It leaves one small action per rendered view in each database." with "Reports render too, as HTML on the same record, with a PDF button that opens the PDF in your system's viewer. A Debug box turns Odoo's debug mode on or off in both frames. It leaves one small action per rendered view in each database."

New bullets:

```markdown
- **Check that a fixed view's patches still apply.** Odoo turns a view on even when one of its locators matches nothing, and silently drops that patch. After you save an inheriting view, its locators are checked against its parent: one that matches nothing, or several nodes, is a warning on its `expr`, an invalid one an error. The save message says so too ("Saved, and the view is on — but 2 locators match nothing."). A long locator that works gets a faint hint, and a quick fix swaps in a shorter one that finds the same node. **Check XPaths** does the same on demand. Turn the check after saving off with `odooDebugger.views.checkXpathsOnSave`.
- **Find any view.** **Find View**, on the Views title, opens a view by id or external id, or lists a model's views. **Views Inheriting This** lists every view below one, and **Open Root View** opens the top of its chain. Lists show base views first, each inheriting view under its parent.
- **Act on a view from its editor.** Compare with Original, Render and Check XPaths are on an arch editor's title, and Open Parent, Open Root View, Views Inheriting This and Add to Upgrade Script in its "…" menu, so a view opened with Find View is not a dead end.
- **In Upgrade mode, "Other inactive views" leaves out the views the original database has off too**, so what the upgrade broke stands out. The group says how many are hidden; the eye on the Views title shows them again.
```

- [ ] **Step 2: README**

In `README.md`, "Disabled views (View Doctor)":
- In the **Render** paragraph, replace "QWeb templates and reports are not rendered; open them from Odoo." with "A report's template renders as the report itself, as HTML, on the newest record both databases have (for invoices, the newest that is not a plain journal entry); **PDF** fetches the PDF from that side's server and opens it in your system's viewer (local windows only, and the server needs wkhtmltopdf). Other QWeb templates are not rendered; open them from Odoo. The **Debug** box turns Odoo's debug mode on or off in both frames, and is remembered per workspace."
- Insert after the **Compare with Original** paragraph:

```markdown
**Check XPaths** tells you whether a fix really works. Odoo turns a view on even when one of its locators matches nothing — it drops that patch and logs a line — so "the view is on" does not mean the patch applies. The check resolves every locator of the arch you have open (`<xpath expr>` and direct ones like `<field name="x" position="after">`) against the parent as Odoo builds it, without the view itself: a locator that matches nothing or several nodes is a warning on its line, an invalid one an error, and a long one that works (Studio's `/form/sheet/...` paths) gets a faint hint. The light bulb swaps in a shorter locator that finds the same node. It runs after every save of an inheriting view (`odooDebugger.views.checkXpathsOnSave` turns that off), and on demand from a view's row or its editor's title. Other views inheriting the same parent are kept in, so a locator that only a later sibling breaks or fixes can be misjudged.

**Find View** (the search icon on the Views title) opens any view of the database by id or external id, or lists a model's views. **Views Inheriting This** lists every view below one, and **Open Root View** opens the top of its chain. In these lists, base views come first and each inheriting view sits under its parent; views that are off are marked. An arch editor's title has the row's actions too, so a view found this way can be compared, rendered and checked.

In Upgrade mode, **Other inactive views** leaves out the views that are off in the original database too (compared by id: the upgraded database is a copy), so what the upgrade broke stands out. The group says how many it hides; the eye icon on the Views title shows them again.
```

- [ ] **Step 3: Rebuild and verify**

```bash
npx tsc -p . --noEmit && npm run lint
npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npm test     # outside the sandbox
npm run compile                                                    # dist/ for the commit
```

Expected: 0 tsc errors, 0 lint errors, all passing (≥ 768 + this plan's new tests), 19+ pending (the gated suites), 0 failing. Note the counts for the record.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md dist
git commit -m "[DOC] Describe the View Doctor's XPath check, finding views and reports; rebuild

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5 (controller): gated integration on 17, 18 and 19**

For each `v` in 17 18 19: build `odt_view_base_$v` (Task 2 Step 8's command), then run the suite with `ODT_VIEW_TEST_PYTHON=/home/odoo/odoo-dev/venv-$v.0/bin/python ODT_VIEW_TEST_ODOO=/home/odoo/odoo-dev/odoo-$v.0 ODT_VIEW_TEST_DB=odt_view_base_$v`, plus once on 19 with `ODT_VIEW_TEST_TRANSPORT=tcp`. Also run the stage 3 script suite (`ODT_VIEW_TEST_UPGRADE_UTIL=/home/odoo/Dev/upgrade-util/src`) on each, since `view_worker.py` changed. Then `dropdb` every `odt_view_*` database and delete minted session files (the suite does this itself; check `~/.local/share/Odoo/sessions` for leftovers it names). Record pass counts per version.

- [ ] **Step 6 (controller): live window check under Xvfb**

Follow `docs/manual-test-brief.md` "Driving the window on this machine" and the memory notes (detached Xvfb outside the sandbox, `env -i` launch, short `HOME`, seeded `.vscode/odoo-debugger-data.json`, Odoo servers started per the stage 1 handover §5 recipe). Use a 17 → 19 pair: a copy of `odt_view_base_17` as the original and of `odt_view_base_19` as the upgraded side, with: a view whose xpath matches nothing, a Studio-style long path, a report template with a record, and an inactive view off in both databases. Check, with screenshots:

1. Save a view whose xpath matches nothing → Warning on that `expr`; the toast says "— but 1 locator matches nothing."
2. The quick fix shortens a long path; the saved arch has the short one.
3. Find View by id, by external id, and by model (the indented list).
4. Views Inheriting This; Open Root View.
5. Compare and Render from an arch editor's title.
6. Upgrade mode: the "Other inactive views" count reads "N · M also off in <original>", and the eye toggles them.
7. Render on a report row: HTML on both sides, the same record.
8. PDF opens externally (`openExternal` of a `file:` URI; under Xvfb, confirm through the log or `xdg-open` stub that it was asked to open the `.pdf`).
9. Debug off reloads both frames without debug (the frame URL has `debug=0`; Odoo's debug icon is gone).

Drop the scratch databases afterwards.

- [ ] **Step 7 (controller): record**

Append an "Execution record" to this plan (commits, test counts, integration results per version, the live check, every ruling made while executing, minors left), write `docs/superpowers/notes/2026-10-06-view-doctor-handover-stage-4.md` (what exists now, traps learned, open items), update the user's memory file `v1-5-view-doctor.md`, and commit the docs:

```bash
git add docs/superpowers/plans/2026-10-06-view-doctor-stage-4.md docs/superpowers/notes/2026-10-06-view-doctor-handover-stage-4.md
git commit -m "[DOC] Record how View Doctor stage 4 was executed

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Execution record (2026-10-06)

Done: commits 5125e32..dbd5ccb on v-1.5, run with subagent-driven development (a fresh implementer per task, a task review per task, Opus reviews for Tasks 1-3, 5, 8, 9, an Opus whole-branch review, one final fix wave with a scoped re-review).

- Unit suite: 844 passing, 26 pending, 0 failing (baseline before the plan: 768 / 19). tsc 0 errors; lint 0 errors, 117 warnings (baseline).
- Gated real-Odoo suite ("View worker against a real Odoo"): 25/25 on 17.0, 18.0 and 19.0, and on 19.0 over TCP; the stage 3 upgrade-script suite passes on all three (run at 16c1113; the fix wave re-ran the worker suite on 17 and 19, 25/25).
- Live window check under Xvfb (17 → 19 pair): 9/9 pass. Dead-xpath warning and message; quick fix to `//field[@name='vat']` saved; Find View by id, xmlid and model with the indented list; Views Inheriting This and Open Root; Compare and Render from the editor title; the filter's "2 · 1 also off in odt_view_live_17" and the eye toggles; report HTML on both sides and Next record; PDF via xdg-open from a 0700 `odt-report-*` folder, removed on close; Debug off sends `debug=0` and the bug icon goes.

### Rulings made while executing

- Ruling: work on v-1.5 in place, no worktree — the user named the branch and stages 1-3 ran the same way — cost if wrong: none.
- Ruling: show the plan and proceed without waiting — the user asked to be shown it, then to execute — cost if wrong: rework of a task the user would have changed.
- Ruling: load xpath_check.py without writing bytecode (compile + exec into a module) — `importlib` wrote resources/scripts/__pycache__, which a vsix would ship — cost if wrong: none.
- Ruling: the check's baseline also switches ON the parent and its inherit_id ancestors inside the rolled-back transaction — on 15-19 `_get_inheriting_views` skips an inactive starting view, so a child of an off parent (the usual Upgrade-mode chain) read "dead" falsely — cost if wrong: a locator that only works because an off ancestor is on reads ok while that ancestor stays off.
- Ruling: fold Task 2 minors (single-locator wording "The locator matches nothing.", `SET LOCAL lock_timeout = '5s'` before the exclusion UPDATEs, assert nothing signalled) into its fix round — cost if wrong: none.
- Ruling: the element scan accepts non-ASCII tag names (`[^\s/>!?][^\s/>]*` on the blanked text) — lxml accepts them, and skipping one shifts later locators onto the wrong sibling — cost if wrong: none.
- Ruling: a check that finishes after its arch closed shows nothing (the spec's "closing clears its diagnostics" over the plan's code); a save that runs no check, or whose check fails, clears that arch's XPath squiggles; a report error is logged; the save hook's own errors are caught and logged — cost if wrong: a manual check's squiggles vanish on the next save with the setting off.
- Ruling: one commit's trailer (8f153bd) names Sonnet — left as is, as stage 2 ruled — cost if wrong: one commit's attribution differs.
- Ruling: the Python test wrapper runs `python -B` — it wrote the stray __pycache__ — cost if wrong: none.
- Ruling: report tabs show no "New record" button (an explicit `showNew` flag), a report steps by shared id, and `report_target` matches only qweb-html/pdf/text reports — cost if wrong: none.
- Ruling: report PDFs go into a private `mkdtemp` folder per render tab (0700), removed when the tab closes — amends spec rule 8's literal `os.tmpdir()/odt-report-…pdf`, which another local user could pre-create — cost if wrong: an open PDF viewer may lose its file when the tab closes.
- Ruling: PDF clicks are ignored while one is in flight (per tab generation); a dropped session reads "Odoo no longer accepts the render's session; press Reload and try again."; `openExternal` returning false names the file — cost if wrong: none.
- Ruling (final review): report sides on different models are not paired by id — each shows its own newest record with a notice; the PDF button is only for qweb-pdf/qweb-html; Find View says "Nothing matches '<value>' in <db>."; a PDF written after its tab closed is removed and not opened; CHANGELOG says "a warning on its locator" — cost if wrong: none.
- Ruling: Add to Upgrade Script stays on every `odoo-view:` editor title — P10/P11 — cost if wrong: one surprising menu entry.
- Ruling: `.vscodeignore` excludes root dotfiles and dot-folders — `vsce ls` showed `.claude/settings*.json`, `.mcp.json`, `.bashrc`, `.gitconfig`, `.superpowers/` would be packaged from this checkout (pre-existing) — cost if wrong: none.
- Ruling: Render showing a silent login page when the server reads sessions from another data folder is documented (README) rather than fixed — a fix touches the security-reviewed proxy; the extension's own launches share the folder — cost if wrong: a confusing login page for servers started with their own `--data-dir`.
- Ruling: the four session files the live check may have minted in `~/.local/share/Odoo/sessions` are left for the user — the sweep was refused as too broad, and they cannot be proven to be only ours — cost if wrong: they linger until Odoo's 7-day cleanup.

### Minors left as they are

- Task 1: the checker's mocha suite is pending, not failing, on a Python without lxml; locators come xpath-first, then direct (nothing relies on order).
- Task 2: a cyclic inherit chain hangs Odoo's own `_get_combined_arch` (only raw SQL can make one); website-specific parents are left out of the baseline without a `website_id` context.
- Task 3: a span is not cross-checked with the locator's expr (fixes are guarded by checked-text equality); a fallback locator loses its Hint; a blank fallback line is zero-width; `positionAt` is O(n) per call; no tests for an out-of-range element, an ambiguous direct locator with shorter equivalents, a DOCTYPE internal subset.
- Task 4: openParent/openRoot read rows outside a try (registerCommand handles it); `target()` has no direct test.
- Task 5: Check XPaths' closed-document guard and the report-error log line have no test.
- Task 6: the Find View QuickPick is not disposed if building it throws; model-less (QWeb) views are reachable by id or external id only; no unit test of the flow.
- Task 7: no test drives `ViewDoctorTreeProvider.load()` (the live check did); menu `when` clauses are tested by regex.
- Task 8: the account.move domain and the top-of-chain fallback have no real-database test (base-only databases).
- Task 9: the PDF fetch's timeout is idle, not total; a click during `openExternal` can rewrite the file; folders can outlive a hard shutdown (0700, private).
- Final fix wave: two clicks from different render generations in one open tab can write the same PDF name at once, and the stale click's cleanup may remove the new one (click again); a PDF clicked just before a new render that then fails is discarded; README/CHANGELOG describe the common report case only (not the cross-model fallback or that text reports have no PDF button).
