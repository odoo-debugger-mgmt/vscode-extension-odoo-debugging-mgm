# How database checkpoints were executed (2026-10-08)

Plan: docs/superpowers/plans/2026-10-08-database-checkpoints.md. Commits a61ad9d..44e6bee on v-1.5. The execution ledger follows, unchanged: per-task reviews, fix rounds, every ruling (decision — why — cost if wrong), deferred minors, parked findings, and both live checks.


Spec: docs/superpowers/specs/2026-10-07-database-checkpoints-design.md (user: "go ahead", 2026-10-08; then "continue with execution, I will be away").
Plan rulings P1–P16 live in the plan's "Rulings made while planning" section; each counts as a ledger ruling.

Ruling: work directly on branch v-1.5, no worktree — the user's standing rule is that this work lives on v-1.5, and prior sessions worked in place; the uncommitted .vscode/launch.json and tasks.json are never staged — cost if wrong: none, the commits are the same.
Ruling: spec Status lines left at "draft for review" — the permission check refused an edit marking them approved; the plan quotes the user's words instead — cost if wrong: the user updates two lines.

## Pre-flight scan

| Pair / task | Produces → consumes | Finding |
|---|---|---|
| T1 → T3 | LinkTreeResult type → FilestoreOps.linkTree | consistent |
| T1 → T4 | linkTree/dirExists/removeTree/renameDir, resolveOdooDataDir/filestoreRootOf → copyRuntime | consistent |
| T1 → T5 | dirExists, renameDir → template rename | consistent |
| T2 → T3 | derivedDbName → stageRestore/swapInRestored | consistent |
| T2 → T5/T6/T7/T8 | checkpointsOf, setCheckpoints, comment SQL, size SQL → reconcile, tree, commands, integration | consistent; db.ts imports type from services/checkpoints (type-only, no cycle) |
| T3 → T4/T5/T7/T8 | CopyBackend, copyDatabase, discardDatabase, stageRestore, swapInRestored, databaseExistsVia | consistent |
| T4 → T5/T7/T8 | withReleased, realCopyBackend, filestoreRootFor, realReleaseHost, releaseForCopy | consistent; copyRuntime → debugger.ts: debugger does not import dbs.ts or copyRuntime, so no cycle |
| T6 → T7 | extractCheckpointFromEvent, contextValue 'checkpoint' → commands, menus | consistent |
| T7 ↔ upgradeGuards.test | the "keyed to viewItem == database" test vs. checkpoint menus | plan already widens the assertion (self-review fix) |
| T1 self | tests vs code: -D forms, HOME fallback, win32 paths | agree |
| T2 self | byte limits, labels, formatBytes rounding | agree (1.45 GB → 1.4) |
| T3 self | fake regex vs sqlText output `convert_from(decode('<hex>', 'hex'), 'UTF8')`; rollback sequences | agree |
| T4 self | snapshot polling vs test expectations | agree |
| T5 self | no new test for dbs.ts UI flows (only reconcile pure part) | accepted: covered by live Xvfb check (controller step) |
| T6 self | SortPreferences(memento) ctor | agrees with src/sortPreferences.ts:9 |
| T7 self | palette `when: false` entries, inline group | agree |
| T8 self | needs real PG outside sandbox | run by implementer outside sandbox |
| T9 | docs + dist | none |

Scan clean apart from the T7 row, which the plan already handles.

## Progress
Task 1: minor (deferred): linkTree leaves a partial dst on failure (callers clean up; Task 3 copyDatabase removes the target folder)
Task 1: minor (deferred): serial walk; ENOENT if Odoo GC unlinks mid-walk aborts the copy; untested symlink/EPERM/-c forms; -D prefix matches any -D token
Task 1: complete (commits a61ad9d..c96a703, review clean)
Ruling: implementer commits carry a Co-Authored-By trailer naming the model that wrote them (Haiku 4.5 on c96a703, 3cfe435), not the plan's Opus line — attribution should be truthful; no history rewrite — cost if wrong: two trailers amended by hand.
Task 2: minor (deferred): checkpointSizeSql([]) gives `IN ()` (caller must guard — Task 6 readCheckpointSizes returns early); checkpointsOf invents createdAt=now for bad dates (unstable until saved); formatBytes 1023.95 KB → "1024 KB"; '|' in db names misparses
Task 2: complete (commits c96a703..3cfe435, review clean apart from trailer ruling)
Ruling: Task 3 Critical (plan-mandated) — COMMENT ON DATABASE takes only a string literal (verified PG 17.6); set the comment through `DO $$ BEGIN EXECUTE format('COMMENT ON DATABASE %I IS %L', <sqlText(target)>, <sqlText(comment)>); END $$;` — keeps the sqlText-only constraint — cost if wrong: none, Task 8's real-PG test checks the comment.
Ruling: Task 3 Important — stageRestore also refuses when the FOLDER <db>__replaced exists (named, like the database case); swapInRestored no longer removes a stale <db>__replaced folder; the undo-failure error names where the database and the filestore each are — a failed folder undo must never let a later restore delete the only filestore — cost if wrong: the user moves a folder by hand once.
Ruling: Task 3 Important (plan-mandated, revises plan ruling P10) — a folder under a copy's target name with no database is moved aside to `<target>.orphan-<base36 epoch ms>` and logged, not removed — a shared data dir across PG clusters or a case-insensitive file system makes "nobody owns it" false — cost if wrong: stray folders accumulate in the filestore dir.
Task 3: minor (deferred): retryWhileBusy matches English message text; non-English lc_messages never retries (safe; SQLSTATE 55006 would need psql VERBOSITY verbose in runSql)
Task 3: minor (deferred): an error from freeOwnConnections inside retryWhileBusy replaces the original busy error
Task 3: minor (deferred): fake file ops never fail (no test for failing remove during swap)
Task 3: fix round 1/5 (3 addressed, 0 open — COMMENT via DO/format; __replaced folder guard + split undo error; orphan folder moved aside; commits 6c96a8d..42cc8a4)
Task 3: complete (commits 3cfe435..42cc8a4, review clean after round 1)
Task 4: note: copyRuntime not yet imported anywhere; import-cycle check deferred to Task 5 (dbs.ts imports it) — controller checks full suite then
Ruling: Task 4 Important (plan-mandated) — after our server is stopped, any error in releaseForCopy restarts it and rethrows the original error; a restart failure there is caught, logged/warned through a new optional host hook, and never replaces the original outcome (folds in Minor 1, same code) — "It restarts afterwards" is a promise in the modal — cost if wrong: none.
Task 4: minor (deferred): stop() 30 s timeout throws without restart if the server exits just after
Task 4: minor (deferred): 10 s wasted wait when a stranger is connected alongside our stopped server
Task 4: minor (deferred): "Could not end the connections" also said for new pids (e.g. external Odoo reconnecting) — wording
Task 4: minor (deferred): filestoreRootFor silently falls back to the active version for an unknown versionId
Task 4: minor (deferred): one connection → "End it to continue?" with button "End Them"
Task 4: minor (deferred): two versions of this window on one database → only one stopped (mergeRunningInstances keeps one per db) — pre-existing
Task 4: minor (deferred): no test that endOwn follows stop; noDebug flag location to confirm in live check
Task 4: fix round 1/5 (1 addressed, 0 open — restart after any post-stop error, restartFailed hook; commits abd1190..a89f81e)
Task 4: minor (deferred): host.stop(run) rejecting partway restarts nothing; survived-path failed-restart untested
Task 4: complete (commits 42cc8a4..a89f81e, review clean after round 1)
Ruling: Task 5 Important — Delete Database runs under withReleased(db.id, 'delete it', …) and drops with discardDatabase directly (no more setupDatabase(remove), which swallowed drop errors); declining changes nothing; a failed drop reaches the user and leaves the record and checkpoints untouched; checkpoints are dropped only after the database is gone — cost if wrong: none.
Ruling: Task 5 Important (plan-mandated, extends the move-aside ruling) — discardDatabase removes <root>/<name> only when it dropped that database itself; a folder with no database behind it is moved aside to `<name>.orphan-<base36 ms>` and logged — same reasoning as copyDatabase — cost if wrong: orphan folders accumulate (e.g. leftover __restoring folders).
Ruling: Task 5 Important (plan-mandated, refines P15) — a template records the filestore root it was created with (`DatabaseTemplateModel.filestoreRoot?`, kept by sanitizeDatabaseTemplates); Create from Template, Rename and Delete Template use `template.filestoreRoot ?? filestoreRootFor()` — cost if wrong: a database created from a template lands its filestore in the template's data dir when versions differ.
Task 5: minor (deferred): template rename: DB renamed before renameDir; ENOTEMPTY leaves metadata stale, nothing undone
Task 5: minor (deferred): reconcile orphan drop loop has no per-item catch
Task 5: minor (deferred): "Delete with N" trusts stored ids (could check comment source == db.id)
Task 5: minor (deferred): logStaleReferences message omits checkpoint findings ("()" when only those)
Task 5: minor (deferred): collectStaleCheckpoints test is one case; RED step not captured
Task 5: fix round 1/5 (3 addressed, 0 open — release-first delete; discard moves ownerless folder aside; template filestoreRoot; commits d6a899b..e6734fe)
Ruling: Task 5 (from re-review, out-of-scope note promoted) — Delete Database must not restart the server it stopped: withReleased gets an option `{ restart: false }`; the stop modal then reads "Stop it to delete it?" without "It restarts afterwards." — restarting would start Odoo on a dropped database (it may even recreate it) — cost if wrong: none.
Task 5: fix round 2/5 (1 addressed, 0 open — no restart after delete; commits e6734fe..38a7bcd)
Task 5: minor (deferred): no unit test for withReleased restart:false / modal text (vscode-bound; live check covers h)
Task 5: complete (commits a89f81e..38a7bcd, review clean after round 2)
Task 6: minor (deferred): checkpointRowCache never pruned; size failure logged at debug; NaN createdAt sort unstable; tests skip root getChildren/buildDatabaseItem (live check b covers)
Task 6: complete (commits 38a7bcd..380c9a8, review clean)
Ruling: Task 7 Important — when recording a new checkpoint fails (save throws, or the database is no longer in the selected project), takeCheckpoint drops the copy it just made (discardDatabase, it owns it) and throws "…; nothing was kept" — Reconcile cannot find a commented checkpoint whose source still exists, and widening Reconcile would offer other workspaces' checkpoints — cost if wrong: a checkpoint is lost when the store refuses, and the user retries.
Task 7: minor (deferred): Delete Checkpoint trusts stored id (guard id != db.id / datistemplate)
Task 7: minor (deferred): drop succeeded + save failed → "Failed to delete" message although it is gone
Task 7: minor (deferred): Rename ignores updateCheckpoints false
Task 7: minor (deferred): no behaviour tests for restore paths (live check e/f)
Task 7: minor (deferred): Restore refreshAll() without reason 'ui' (deliberate: data changed)
Task 7: fix round 1/5 (1 addressed, 0 open — drop unrecorded checkpoint copy; commits 6f85870..66091f4)
Task 7: complete (commits 380c9a8..66091f4, review clean after round 1)
Ruling: Task 8 Important (plan-mandated) — teardown drops only this run's databases (`datname LIKE '<db>%'` with `_` escaped), not every odt_cp_* database — a test must never be able to drop a user's database — cost if wrong: a leaked database from a crashed earlier run stays until dropped by hand.
Task 8: minor (deferred): teardown catch silent; setup-failure leaves rm(root undefined); test 1 doesn't assert the holder's backend is gone nor the "no" path; spawn('psql') has no error handler; tests chained
Task 8: fix round 1/5 (1 addressed, 0 open — teardown scoped to run's names; commits f36ec1f..59cc468)
Task 8: complete (commits 66091f4..59cc468, review clean after round 1; controller re-ran the real-PG suite: 4 passing, no odt_* left)
Task 9: minor (deferred): README Checkpoints bullet is long next to its neighbours
Task 9: complete (commits 59cc468..75c2db1, docs review clean; full suite 929 passing / 30 pending / 0 failing; real-PG 4 passing)
Live check: fixture /tmp/claude/odt6 (stub odoo-bin holds a psycopg2 connection to -d; data dir /tmp/claude/odt6/data via --data-dir), db odt_cp_live
Live check (Xvfb, odt6, real PG): 10/10 pass — a inline bookmark + menu entry + prefilled label; b collapsible "1 checkpoint", child "label • just now • 7.4 MB", history icon, protected + comment + same-inode filestore; c stop modal verbatim, server stopped and restarted (new pid), no-debug kept (debuggee plain python3, no debugpy); d End Them names "outside-holder (local socket)", ends it; e restore: data and filestore back, server restarted, no __restoring/__replaced left, staged copy made before stop; f "Before restoring original state" added; g rename + delete (db and folder gone); h delete dialog lists checkpoints, two buttons; delete stop modal "Stop it to delete it?" with no restart promise, nothing restarted; i orphan listed unticked, Drop modal, dropped with folder; j clone keeps hard links, server restarted. No odt* databases left.
Live check: minor (deferred): Delete dialog with one checkpoint says "Delete keeps them"
Final review (opus): With fixes — 1 Critical, 3 Important, 2 deferred minors promoted, minors 5–10.
Ruling: Final C1 — Clone / Create from Template never drop an existing database: the silent pre-drop in cloneDatabaseFromTemplate goes; the name prompts also refuse names that exist in PostgreSQL (live list), and copyDatabase's own refusal stays as the backstop — the old overwrite predates the branch but now also removed the filestore; losing another workspace's database by pressing Enter is unacceptable — cost if wrong: a user who wanted to overwrite deletes the old database first.
Ruling: Final I2 — in discardDatabase a folder-removal failure after a successful DROP is a logged warning, not an error; withReleased with restart:false restarts on failure only if the database still exists — cost if wrong: a leftover folder (logged).
Ruling: Final I3 — CheckpointModel gains optional `filestoreRoot` recorded at creation; restore and delete use `cp.filestoreRoot ?? filestoreRootFor(db.versionId)`; stageRestore refuses when the checkpoint recorded a filestore and its folder is missing, naming the path — never restore a database without its attachments — cost if wrong: a checkpoint whose data dir moved needs the folder put back.
Ruling: Final I4 — "our server on this database" is matched on the running session's `-d` argument, not the version's current selection; ManagedRun carries dbName; restart is skipped with a warning when the version would now start another database — cost if wrong: none.
Ruling: Final (deferred minor promoted) — before Delete Checkpoint, Delete with N and Restore act on a stored checkpoint id, PostgreSQL must confirm it is a template whose comment is checkpointComment(<db>); otherwise refuse and name it — destructive paths must not trust editable JSON — cost if wrong: a hand-made checkpoint without the comment can't be deleted from the tree.
Ruling: Final (deferred minor promoted) — template rename refuses when a folder of the new name exists, and renames the database back if moving the folder fails — cost if wrong: none.
Ruling: Final minors 5, 7, 8 folded into the fix wave (cheap, data-adjacent): undo renames use retryWhileBusy; the staged copy is given the live database's owner (best effort, logged on failure); the View Doctor is released again after a successful swap. Minors 6, 9, 10 left (contrived or honest failures) — cost if wrong: two windows restoring one database at once can mix their staging copies.
Final fix wave: commits 75c2db1..44e6bee (0827de6, 40426e5, 44e6bee); re-review (opus): all 7 addressed, no new breakage. Full suite 939 passing / 30 pending / 0 failing; real-PG 4 passing.
Live re-check after fix wave (Xvfb, odt6): c (ownRun by -d: stop modal, restart new pid, filestoreRoot recorded), e (restore: data + filestore back, owner kept, restart), j (clone refuses a name taken in PostgreSQL) — pass. All odt* databases dropped.
Final: parked — restore when the recorded filestoreRoot differs from the version's current root swaps folders under the recorded root while Odoo reads the new one — Ruling: park; needs a data-dir change that keeps the old dir; a cheap refusal is the follow-up — cost if wrong: attachments deleted since the checkpoint stay missing after such a restore, silently.
Final: parked — Fresh and From Dump creation still drop an unlinked PostgreSQL database of the same name (pre-existing, no filestore involved) — Ruling: park; outside this branch's change — cost if wrong: inconsistent with Clone/Template, which now refuse.
Final: parked — a filestore folder that could not be removed after a successful restore leaves <db>__replaced (logged at info), and the next restore is refused with an alarming message — Ruling: park; safe — cost if wrong: one confusing refusal.
Final: parked — Reconcile drops an orphan's folder under the active version's root only — Ruling: park; safe — cost if wrong: a leftover folder.
Final: parked — VS Code-bound paths (prompts, template rename, ownRun/start, withReleased restart branch) have no unit tests — Ruling: park; covered by the two live checks — cost if wrong: a regression there is caught only by hand.
