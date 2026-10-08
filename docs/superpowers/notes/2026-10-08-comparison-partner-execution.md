# How the comparison partner (compare spec, Part B) was executed (2026-10-08)

Plan: docs/superpowers/plans/2026-10-08-comparison-partner.md. Commits 77e967e..7c0638e on v-1.5. The execution ledger follows, unchanged: per-task reviews, fix rounds, every ruling (decision — why — cost if wrong), deferred minors, parked findings, and both live checks.


Spec: docs/superpowers/specs/2026-10-07-compare-and-multi-server-design.md Part B (user: "go ahead", 2026-10-08). Plan rulings B-R1–B-R7 are in the plan.
Ruling: work directly on v-1.5 — standing rule — cost if wrong: none.

## Pre-flight scan

| Pair / task | Produces → consumes | Finding |
|---|---|---|
| T1 → T3/T4 | resolveStoredPartner, partnerChoices, comparisonSides, isCopyPartner, setPartner | consistent |
| T2 → T4/T5 | withCheckpointOpen, compareDocuments.snapshotUri, closeOpenCheckpoints, realCheckpointOpener | consistent |
| T3 → T4 | partnerFor, RenderRequest.startArgs, dbSelector.runPairAlongside | consistent |
| T1 self | test expectations vs rules (upgrade original side, deleted partners, choice order) | agree |
| T2 self | ref-count semantics in test vs code (failed open resets) | agree |
| T3 self | PairProject element type must widen to be assignable to PartnerProject | flagged in brief |
| T4 self | arch read function name must be looked up (getArch backend) | flagged in brief |
| T5 self | closeOpenCheckpoints needs a store; fallback allowed and must be reported | flagged |
| T6 | docs + walkthrough grep | none |

Scan clean.

## Progress
Task 1: minor (deferred): non-array dbs / null entries throw; a self-partner from hand-edited JSON resolves; no garbage-input tests; RED not captured
Task 1: complete (commits 77e967e..8fa9de8, review clean)
Ruling: Task 2 Important 1 — per-database ordering: a new opening waits for the pending close of the same checkpoint (a `closing` map, chain never rejects) — two psql ALTERs otherwise commit in any order and close the checkpoint under the new read — cost if wrong: none.
Ruling: Task 2 Important 2 — the activation sweep goes through the same machinery: it skips a checkpoint with an in-process opening, skips one that has any live connection in pg_stat_activity (another window reading), and records its close in `closing` — a sweep must never close a checkpoint under a read, in this window or another — cost if wrong: a checkpoint held open by a crashed window with a lingering backend stays open until the next sweep.
Task 2: minor (deferred): snapshot map unbounded for the session; an open whose ALTER committed but psql failed leaves it open until the sweep; side not sanitized; deterministic handshake instead of 5 ms tick; restore/clone from a checkpoint while a read holds it fails "being accessed" (Task 4/5 forward risk)
Task 2: fix round 1/5 (1 addressed, 1 open — sweep check-then-close not atomic: openings not re-checked after the pg_stat_activity await; commits 3cbf47a..b1c82f0)
Task 2: known gap (recorded): the same check-then-close race across windows needs a cross-process lock (advisory lock) — beyond the ruling; cost: a sweep in a newly activated window can close a checkpoint another window opened in the same instant.
Task 2: fix round 2/5 (1 addressed, 0 open — re-check openings after the connection check; commits b1c82f0..423dc85)
Task 2: complete (commits 8fa9de8..423dc85, review clean after round 2)
Task 3: minor (deferred): picker duplicated in partnerCommands vs partnerFor; storePartner silent when db missing; Clear message untrue for an upgrade-pair member; runPairAlongside doesn't catch a throw; upgradePair parsed per row; no behaviour tests
Task 3: complete (commits 423dc85..552c44a, review clean)
Ruling: Task 4 deviations — the checkpoint snapshot reads arch_db with psql (readStoredArch, en_US first) inside withCheckpointOpen, not through the Odoo shell (which cannot start on a checkpoint and would hold a connection for 10 min); Render from the upgrade's original side now shows both sides like the upgraded side (spec B1/B2: the partner is the other side, original left) — cost if wrong: the stored arch, not Odoo's combined view, is what the checkpoint side shows (same as the live odoo-view file).
Ruling: Task 4 Important (plan-mandated) — Render asks for a partner only when there is one to pick: `partnerFor` gains a `quiet` option (no "no other database" message), and Render passes it; Compare keeps the message — Render of a one-database project must stay silent as before — cost if wrong: none.
Ruling: Task 4 minors promoted (user-visible text, same files): toggle titles say "…Also Off in the Partner"; the tree names a checkpoint by its label (alsoOffSource returns label); dead pickOtherDatabase/otherDatabaseChoices removed and Compare calls diffArguments (reworked to left/right + labels) so its test covers the live path — cost if wrong: none.
Task 4: minor (deferred): the tree keeps the checkpoint open across all of doctorGroups (pass a reader wrapper later); NULL arch_db reads as "no longer exists"; to_jsonb sends all translations; checkpoint opened twice in Compare
Task 4: fix round 1/5 (4 addressed, 0 open — quiet Render, partner wording, label, dead code/diffArguments; commits 23f68f1..82b7e45)
Task 4: complete (commits 552c44a..82b7e45, review clean after round 1)
Task 5: minor (deferred): teardown drop catch silent; overlap timing-based not latched
Task 5: complete (commits 82b7e45..d322cab, review clean; controller ran it: 5 passing)
Task 6: minor (deferred): README "a side with no server offers Run Both" is outside-upgrade only (upgrade offers Start Both Servers); Render paragraph long
Task 6: complete (commits d322cab..bbbe4c8, docs review clean; full 1004 passing / 38 pending / 0 failing; real-PG 9; real-Odoo alongside 3)
Live check (Xvfb, REAL Odoo 17 venv, base dbs odt_pb_a/odt_pb_b, view 213 off in A, checkpoint "before 214", then 214 off in A): a Set partner A→B, tooltip "Comparison partner: odt_pb_b"; b Compare with Partner: title "…: odt_pb_b ↔ odt_pb_a", B left, A right, no prompt (real Odoo shells); c Render: two frames B|A offering "Run Both"; Run Both started B on 8100 and A on 8101 alongside — DEFECT: the render tab kept waiting on 8017 (ports fixed when sides are prepared; Reload doesn't re-prepare); d checkpoint of A taken while A ran alongside (stop, copy, restart on 8100 with real Odoo); partner → checkpoint (picker lists "before 214 · checkpoint of odt_pb_a"); Views tree "Other inactive views 1 · 1 also off in before 214" (213 hidden, 214 shown, label used); Compare on 214: left read-only snapshot "/left/before 214 · …", right live A; datallowconn false afterwards; tooltip "(checkpoint)"; e Clear → toast, filter gone (2 views), Compare asks with B + checkpoint. f upgrade mode: unit tests only (plan allowed). All databases dropped.
Live check: observed — the Versions row shows ":8017 running" when only an alongside run (8100) of that version is up (Part A runningByVersion keeps the alongside instance but the row prints the version's own port)
Final review (opus): With fixes — 0 Critical, 1 Important (Render ports after Run Both / Reload), minors 2–7.
Ruling: Final I1 — after Render's start command, and on Reload when any side's port re-resolves differently, the render sides are prepared again (ports through resolvePortForDatabase, which reads run records), guarded by the panel's generation check; a unit test with a fake host whose port moves 8017→8100 — Run Both is Part B's main Render path — cost if wrong: none.
Ruling: Final minors folded (cheap, user-visible or lifecycle): #2 the checkpoint is open only for the row reads, the counterpart pick runs outside it; #3 Run Both starts only the databases shown; #4 a read refused with "not currently accepting connections" re-opens and retries once (cross-window close); #5 a partner remembered by Compare/Render refreshes the trees; #6 Clear on an upgrade-pair member says the other side stays its partner; #7 the Versions row of a version running only alongside shows "alongside on :<port>" — cost if wrong: none.
Final fix wave: commits bbbe4c8..7c0638e (5db5961, 6721dc8, 7c0638e); re-review (opus): all 7 addressed, no new breakage. Full 1011 passing / 38 pending / 0 failing; real-PG 9; real-Odoo alongside 3.
Note: the fix-wave implementer used `git stash` to show its test failing, against the shared-stash rule; the stash list is empty afterwards and the user's .vscode edits are intact. Later implementers are told never to use git stash.
Live re-check (Xvfb, real Odoo 17): Render of view 214 with partner B, both stopped → Run Both → B on 8100, A on 8101, both frames show the real res.users form on record 2; Versions row "alongside on :8100". Databases dropped.
Final: parked — reload while a start is still running replaces the session and skips the wait; a re-prepare resets the record cursor; cross-window open/close still lacks an advisory lock (retry-once covers the common case) — Ruling: park — cost if wrong: a click on Reload or Run Both again recovers.
