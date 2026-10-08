# How servers per database (compare spec, Part A) were executed (2026-10-08)

Plan: docs/superpowers/plans/2026-10-08-servers-per-database.md. Commits 7d81d3a..ffb6826 on v-1.5. The execution ledger follows, unchanged: per-task reviews, fix rounds, every ruling (decision — why — cost if wrong), deferred minors, parked findings, and both live checks.


Spec: docs/superpowers/specs/2026-10-07-compare-and-multi-server-design.md Part A (user: "go ahead", 2026-10-08). Plan rulings A1–A6 are in the plan.
Ruling: work directly on v-1.5, as for checkpoints — the user's standing rule — cost if wrong: none.

## Pre-flight scan

| Pair / task | Produces → consumes | Finding |
|---|---|---|
| T1 → T3 | runRecords/runForDatabase/ALONGSIDE_MARKER/RunDetails → runAlongside, copyRuntime.ownRun | consistent |
| T1 → T4 | runForDatabase, getRunningInstances → stopServer, picker | consistent |
| T2 → T3 | pickFreePort, reservePort, reservedPorts, workersOf, realtimePortFlag, alongsideArgs, checkoutConflicts | consistent; T2 uses checkpoint T1's extraParamValue (exists) |
| T3 → T4 | runAlongside(dbId, {noDebug}) | consistent |
| T3 ↔ checkpoint copyRuntime | ManagedRun.kind added; connectionRelease test fixture gets kind | plan covers |
| T1 self | debugSessions.test call sites change from string to RunDetails | plan covers |
| T2 self | alongsideArgs always puts -p first; test expectations agree | agree |
| T3 self | showError return value used for buttons; implementer must verify its signature | flagged in brief |
| T4 self | upgradeGuards "keyed to database|checkpoint" test: new entries keyed to database | agree |
| T5 self | needs Odoo 17 venv + PG, outside sandbox; may create base db (~1 min) | ok |
| T6 | docs + dist | none |

Scan clean.

## Progress
Task 1: minor (deferred): `as never[]` casts in describeSession hide the IdentityCandidate mismatch; runs without -d are tracked but not shown as managed instances; RED not captured
Ruling: Task 1 minor 2 carried into Task 4 — the Versions tree prefers a version's primary run over an alongside run when both run (Map last-wins today) — the row describes the version's own F5 entry — cost if wrong: none.
Task 1: complete (commits 7d81d3a..81c3898, review clean)
Ruling: Task 2 Important (plan-mandated) — alongsideArgs also strips port flags given as one token with a space or attached value (`--http-port 9000`, `-p 9000`, `-p9000`, `-p=9000`, same for gevent/longpolling/xmlrpc), since comma-split extraParams arrive that way — cost if wrong: none.
Task 2: minor (deferred): a stale release() can free a newer reservation of the same port (>30 s start); timers not unref()'d
Ruling: Task 2 minor 2 carried into Task 3 — runAlongside serializes its pick-and-reserve step (module-level promise chain) so two concurrent starts cannot pick the same port while pickFreePort awaits probes — cost if wrong: none.
Task 2: fix round 1/5 (1 addressed, 0 open — one-token port flags stripped; commits a11489f..7182870)
Task 2: complete (commits 81c3898..7182870, review clean after round 1)
Ruling: Task 3 deviations accepted — the alongside stop in startServerForVersion sits after every refusal (a start that cannot happen stops nothing); no wait after that stop (same as the existing restart); an in-flight guard per database ("already starting"); reservations released only once recorded — each is safer than the brief — cost if wrong: two servers share a database for a moment on different ports.
Task 3: minor (deferred): alongside config lacks user-added fields of the version's launch entry (env, envFile, justMyCode, gevent, subProcess) — F5 has them
Task 3: minor (deferred): F5's port-holder lookup ignores alongside runs when a version's port is set by hand into 8100–8199
Task 3: minor (deferred): initialize/resolveReposForDatabase/getRepoBranch throws escape runAlongside's {ok,message}; ensureCustomWorktrees problems dropped
Task 3: minor (deferred): handleAlongsideAction rejections unhandled; only the first conflict's button offered
Task 3: minor (deferred): getRepoBranch 3 s cache can hide a conflict right after an outside git checkout
Task 3: complete (commits 7182870..0e014e7, review clean)
Task 4: minor (deferred): palette picker silent when no databases/project; runningByVersion keeps first on ties (report said unchanged); no handler tests; "never inline" test name loose
Task 4: complete (commits 0e014e7..26839f9, review clean)
Ruling: Task 5 Important — the test proves each server serves its own database through pg_stat_activity: connections whose application_name is `odoo-<server pid>` (Odoo sets it; fall back to PGAPPNAME if 15-style) are only on that server's database; status asserted exactly 200 — a port answering is not the claim — cost if wrong: none.
Task 5: minor (deferred): teardown catch silent; no spawn 'error' listener; servers[length-2] fragile
Task 5: fix round 1/5 (1 addressed, 0 open — pg_stat_activity per server pid, exact 200; commits d178786..b8854e3)
Task 5: complete (commits 26839f9..b8854e3, review clean after round 1; controller ran it: passing)
Task 6: complete (commits b8854e3..80938c2, docs review clean; full 965 passing / 33 pending / 0 failing; real-Odoo alongside 3 passing; real-PG checkpoints 4 passing)
Live check (Xvfb, odt6, stubs listen on -p and hold a PG connection): a F5 X :8017, alongside Y :8100 (17 code), Z :8101 (18 code), launch.json only has odoo:17.0; b select Y → tree unchanged; c Run Alongside X → "already running … on port 8017", nothing started; e checkpoint of Z → stop modal, Z back alongside on 8101 with 18 code (not 8018); g F5 with Y selected stopped Y's alongside, Y primary on 8017; d Stop Server on Z stopped only Z; f X mapped to feature-x in a checkout-mode repo → refusal naming main/feature-x, button opened the one-copy-per-branch modal; after Create Copies, X ran alongside :8100 from acme@feature-x while Y ran main. All pass. Databases dropped.
Live check: fixture note — the 18.0 version had no selected database (never selected), so no odoo:18.0 launch entry; not a Part A defect.
Final review (opus): With fixes — 0 Critical, 4 Important.
Ruling: Final I1 — the alongside stop also happens when a primary session starts by any route (VS Code's own F5 / Run and Debug included): on tracking a primary record for database D in server.ts, a live alongside run of D in this window is stopped — the docs promise it and two servers on one database break Stop Server and checkpoints — cost if wrong: none.
Ruling: Final I2 — selecting a database never checks out a repository branch under a running ALONGSIDE run that uses that same checkout on another branch: that checkout is held back, the switch says so naming the repo and the run, and offers Use One Copy Per Branch; the version's primary keeps today's behaviour (F5 restarts it) — alongside runs exist to keep running while you select something else — cost if wrong: the selected database runs on the held-back branch until the user acts.
Ruling: Final I3 — the realtime port is part of the run record (marker + RunDetails.realtimePort) and counted as taken — cost if wrong: none.
Ruling: Final I4 (promoted Task 3 minor) — an alongside configuration starts from the version's own launch entry (user-added fields such as env, envFile, justMyCode, gevent, subProcess kept), then overrides name, args and marker — spec A3 "built the same way as the primary entry" — cost if wrong: none.
Ruling: Final minors folded (cheap, user-visible): the status bar counts only a version's primary run; Stop Both Servers also stops a side's database running alongside (by run record); the row command is titled "Stop This Database's Server" so the palette has no two "Stop Server" entries. Other minors stay deferred.
Final fix wave: commits 80938c2..ffb6826 (4d54fe7, c2eb440, ffb6826); re-review (opus): all addressed, no new breakage. Full 971 passing / 33 pending / 0 failing; real-Odoo 3; real-PG 4.
Final: parked — an alongside database with NO branch assigned for a single-checkout repo is not protected by the I2 hold-back (it runs whatever the checkout was on) — Ruling: park (no second fix wave; the cheap follow-up is to treat the checkout's current branch as the kept branch, or record a run's branches at start) — cost if wrong: selecting another database can change that alongside run's code.
Final: parked — core repos (odoo/enterprise/themes) shared by two versions are neither checked at Run Alongside nor held back on switch — Ruling: park; uncommon layout — cost if wrong: an alongside run of another series runs the wrong core code.
Final: parked — environment.ts ↔ versionRepos.ts import cycle (call-time only, CommonJS) — Ruling: park; safe today, needs a comment — cost if wrong: a future top-level use breaks at load.
Final: parked — debugpy subprocess child sessions may copy the marker (workers) — unverified; parent tracked first — Ruling: park — cost if wrong: extra records for one run.
Live re-check after fix wave (Xvfb, odt6): I2 — with Y alongside on main, selecting X (acme→feature-x) kept acme on main with the warning naming odt_al_y and offering Use One Copy Per Branch; I1 — with Y alongside on 8100, starting the native launch.json entry from VS Code's own Start Debugging picker stopped the alongside run; only the primary on 8017 remained. Databases dropped.
