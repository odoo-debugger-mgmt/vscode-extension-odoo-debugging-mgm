# Compare (Part C): execution notes

Plan: docs/superpowers/plans/2026-10-08-compare.md. Commits 1f00b4b..95a51ce on v-1.5. The execution ledger follows, unchanged: per-task reviews, fix rounds, every ruling (decision — why — cost if wrong), deferred minors, the final review and its fix wave, and the live check.

# SDD ledger — plan: docs/superpowers/plans/2026-10-08-compare.md

Spec: docs/superpowers/specs/2026-10-07-compare-and-multi-server-design.md Part C (user: "go ahead", 2026-10-08). Plan rulings C-R1–C-R6 are in the plan.
Ruling: work directly on v-1.5 — standing rule — cost if wrong: none.

## Pre-flight scan

| Pair / task | Produces → consumes | Finding |
|---|---|---|
| T1 → T2/T3 | SideRoots, rootOf, resolveCounterpart, codeSides, realFsProbe | consistent |
| T2 → T3 | listTree (reused to list .py/.xml), compareCommands.ts shared file | consistent |
| T1/T2/T3 → T4 | codeSides not used by T4 (record compare uses partnerFor directly; checkpoints allowed) | consistent with C-R1 |
| T1 self | counterpart test intent fixed in plan before dispatch (same-name-in-module case) | agree |
| T3 self | scanner end-line rule vs test (class end 12 = line after last non-blank body line 11) | agree |
| T4 self | gated test needs real Odoo 17 + PG, outside sandbox | ok |
| T5 | docs + dist | none |

Scan clean.

## Progress
Ruling: Task 1 Important — sideRootsFor resolves odooPath/enterprisePath/designThemesPath with resolveOptionalPath (as debugger.ts does) before sideRolesFor, which stays pure — default "./odoo" versions otherwise never match — cost if wrong: none.
Ruling: Task 1 minor promoted — a file under the Odoo root itself (role `odoo`, e.g. odoo/models.py) skips C1 step 6 (same name anywhere in addons): framework files do not move into modules, and the 50 models.py candidates are noise — cost if wrong: a framework file moved into a module is reported as having no counterpart.
Task 1: minor (deferred): step 6 walks every addons tree for a name with no match (slow on enterprise, one stat per entry, follows symlinks to depth 8); collect counts duplicates before dedupe; stock fixture unasserted; no skip-folder test
Task 1: fix round 1/5 (3 addressed, 0 open — resolve version paths; odoo-root skips name search; boundary + skip tests; commits 1f00b4b..f4b13b9)
Task 1: minor (deferred): a leftover bare `{ … }` block in resolveCounterpart (cosmetic)
Task 1: complete (commits fa11a3d..f4b13b9, review clean after round 1)
Ruling: Task 2 Important — the module variant of the C3 message reads "<module> is the same module in <left> and <right>."; and when a file matches both sides, this side is preferred (the brief's rule) — cost if wrong: none.
Task 2: minor (deferred): no handler tests (order-the-sides helper would make them testable); listTree stats serially and skips symlinks silently; a subfolder compares its whole module (unstated); partner prompt before the not-part-of check
Task 2: fix round 1/5 (2 addressed, 0 open — "same module" wording; matchSide prefers this side; commits fd6ce40..551d7fd)
Task 2: complete (commits f4b13b9..551d7fd, review clean after round 1)
Ruling: Task 3 Important 1–3 (2 and 3 plan-mandated) — the scanner (a) extends a body through lines inside a multi-line string, (b) treats a def/class signature as open until its brackets balance before applying the indent rule, (c) walks back over multi-line decorators to their `@` line, (d) ignores `"""` inside `#` comments; measured against Python's ast over Odoo 17 community (reviewer's 457/27,461 baseline) — the brief's rules were too simple for real Odoo — cost if wrong: none.
Ruling: Task 3 Important 4 — when no counterpart FILE is found, Compare This still searches the same-named counterpart module (same root first, then other roots, as C1 step 3) for the symbol / XML id before offering the name pick — a file renamed inside a module that still exists is the common case (sale_views.xml → sale_order_views.xml) — cost if wrong: none.
Ruling: Task 3 minors folded (correctness): exact `_name` matches win over `_inherit`-only; with no `_name`, an `_inherit` match requires the class to have no other `_name`; a nested helper never falls back to an unrelated model method; the provider's name picks the duplicate containing the cursor; modelKeyOf reads class-level assignments only; snapshot labels keep the file extension for highlighting — cost if wrong: none.
Task 3: fix round 1/5 (Important 1-4 + folded minors; ast 457→0 wrong; commit 3396a7e)
Ruling: Task 4 Step 4.6 — the no-table check uses the abstract model `ir.qweb`, not `base.module.update`: a TransientModel has a real table in Odoo 17, so the brief's example would never give the no-table error — cost if wrong: none.
Ruling: Task 4 fieldsSql — the information_schema join also filters `c.table_schema = current_schema()`, so a same-named table in another schema cannot add columns — cost if wrong: none.
minor (deferred): Task 3 — modelKeyOf misses _name/_inherit when the class text starts with a class decorator (rare in Odoo); the nested-helper test does not pin the command-level guard; lex ignores backslash continuations (0 mismatches over Odoo 17) — parked for the final review.
Task 3: complete (commits 78cf67a..3396a7e, re-review Approved after round 1)
Task 4: dispatched (BASE 3396a7e, sonnet)
Task 4: implemented 75a05e5 (DONE_WITH_CONCERNS: no RED run; one-side-missing model shows error; both-missing shows left error); review dispatched (sonnet)
Ruling: Task 4 Important (properties) — the en_US pick applies only to translatable ttypes (char, text, html); any other object value (properties, json) renders as JSON.stringify with sorted keys — a properties field otherwise hides every key but one — cost if wrong: none.
Ruling: Task 4 minor folded — when the model has stored columns on one side only, that side renders "(model not installed in <db>)" and the diff opens; only both sides without a table is the no-table error; both sides missing the record says so naming both databases; the SQL-safety unit test asserts the expected hex — the one-side-missing model is the common upgrade case — cost if wrong: none.
minor (deferred): Task 4 — a model with a custom _table reports "has no table" (tableOf assumes model→table) — rare.
Task 4: review Needs fixes (1 Important, 4 minor); fix round 1 dispatched
Task 4: fix round 1/5 (properties JSON, planSides one-side model, both-missing message, hex test; commit a920e5f)
minor (deferred): Task 4 — no test for missing-on-one-side + no-table-on-the-other; command wiring only covered through planSides.
Task 4: complete (commits 75a05e5..a920e5f, re-review Approved after round 1)
Task 5: dispatched (BASE a920e5f, sonnet)
Ruling: Task 5 task review done by the controller (a 5-line docs diff checked against the brief's verbatim text plus the one ruled clause; dist is a build output; the suites ran green) — a reviewer seat for verbatim docs buys nothing; the final review covers the branch — cost if wrong: a docs wording slip, caught in the final review.
Task 5: complete (commit 330b05f; gated PG 9, alongside 3, compare record 4; full 1056/42/0)
Final review dispatched (opus, fa11a3d..330b05f)
Final review (opus): With fixes — 0 Critical, 3 Important (I1 module with no counterpart → 50 unrelated manifests; I2 ir.actions.* "no table" (custom _table, promoted from deferred); I3 attachment binaries dropped), M1–M10 minors, 11 declined. Full text: final-review.md.
Ruling: final I1–I3 fixed — I1 module compare resolves by module name only (counterpartModuleDir) and says "<module> has no counterpart in <side>."; file compare skips the name walk for __manifest__.py/__init__.py; I2 tableOf uses a map of the core `_table` exceptions (ir.actions.* family) and the no-table message stops guessing "abstract or transient" when ir_model_fields has stored fields; I3 attachment binaries are read from ir_attachment (file_size, checksum) and rendered in the existing size/sha1 form — all three are the common upgrade case — cost if wrong: a custom module's own `_table` still reports no table (message now says so neutrally).
Ruling: final minors folded — M1 withProgress on file/module compare; M2 module = nearest __manifest__ under the root (nested modules); M3 a step-4 hit from another folder is offered as a pick, not opened; M4 a char/text/html object is a translation only when its keys look like language codes, else stableJson (company-dependent fields in 18); M5 editor right-click entries honour odooDebugger.editorActions.enabled; M6 palette Compare Module falls back to the active editor's module; M7 the side-ordering/candidate logic moves to a pure helper with unit tests; M8 no-table on one side + no-record on the other gives a message, not a diff of two notes; M9 text/html values with newlines render as an indented multi-line block; README notes that many2many/one2many are not compared — each is cheap and visible to a user — cost if wrong: none.
Ruling: final declined list accepted as declined (spec/plan rulings, Part B design, legacy paths); numeric precision and dirty-editor reads parked.
Final fix wave: commits 7f590db..de2284e (I1–I3, M1–M9, README); full 1075/44/0; gated record 6 passing
Final re-review (opus, resumed): Approved — I1–I3, M1–M9 addressed and re-checked on real trees / the real 18 db; 2 new Minors.
Ruling: final residuals fixed by the controller (two one-line guards, after the live check): counterpartModuleDir also requires folder/__manifest__.py; storedCountSql leaves out one2many/many2many — both turn a misleading result into the right one at no risk — cost if wrong: none.
Residual commit 95a51ce (controller): counterpartModuleDir requires __manifest__.py; storedCountSql leaves out one2many/many2many; the Compare Record prompt says "with" (it said "this ↔ partner" while the diff puts the partner left — found in the live check). Full 1077/44/0; gated record 6 passing.
Live check (Xvfb, REAL trees: v17 on odoo-17.0, v18 on odoo-18.0; dbs odt_pc_a/odt_pc_b base 17 (b: main partner renamed "Changed" + comment), odt_pc_c empty for 18): a editor "…" → Compare with Partner on sale/models/sale_order.py: "sale_order.py: odt_pc_c ↔ odt_pc_a", 18 left (SQL import), 17 right; b Compare This in _compute_amounts: "SaleOrder._compute_amounts: odt_pc_c ↔ odt_pc_a", both bodies with decorators, highlighted; c Compare This inside view_order_form (sale_order_views.xml): both records, only real differences marked; d Compare Module (palette fallback; the Modules view lists project-repo modules only and the fixture has none): "sale: odt_pc_c ↔ odt_pc_a", 143 changed · 15 added · 75 removed, controllers/portal.py opens its diff; e Compare Record from odt_pc_b's row, base.main_partner: odt_pc_a left, odt_pc_b right, exactly comment and name differ, image_* sizes/sha1 shown; f checkpoint "live f" of odt_pc_a as partner: Compare with Partner refuses "A checkpoint runs the same code as odt_pc_a…"; Compare Record res.partner,1 vs the checkpoint opens (checkpoint left) and datallowconn is false afterwards. Observed, not Part C: selecting a database row runs the environment switch, which tries to check out 17.0 in /home/odoo/odoo-dev/odoo-17.0 and git refuses (branch used by the worktree at /home/odoo/Dev/odoo) — a warning toast, no change on disk; same as the Part B run. All databases dropped.
Part C: complete (fa11a3d..95a51ce).
