# Compare across databases and versions, and several servers at once — design

**Date:** 2026-10-07 · **Branch:** `v-1.5` · **Status:** draft for review

## 1. What the user asked for

Three requests, which the user asked to put in one spec:

- **(3) Compare old against new code during an upgrade:** a *Compare* action at several levels (file, method, record, …) that opens a diff.
- **(4) Upgrade features that apply to any workspace:** find them and expose them outside upgrade mode.
- **(5) Several databases at once:** several databases on one version, several projects, several versions — running together.

Constraints the user set: **any number of servers can run at once, but a comparison is always between exactly two sides.**

**Success looks like:**
- Right-click a database → *Run Alongside* → it starts on its own port next to whatever already runs, on the same version or another one.
- In any Python or XML file, *Compare with Partner* opens a diff against the same file, method or record in the other side's code.
- *Compare Record…* diffs one record across two databases.
- None of this needs upgrade mode. Upgrade mode only picks the partner for you.

## 2. Where things stand

- **One server per version.**
  - The port, the debugger name and the launch entry belong to the version.
  - `dbForVersion` gives each version one database.
  - `startServerForVersion` stops the version's running session before starting.
  - Two databases on one version therefore cannot run together, and two windows on the same version collide on its port. The second one refuses with "already running on port N".
- **Sessions** are keyed by launch-entry name (`debugSessions.ts`). Since the 2026-10-07 change, each also records the version it started as. `RunningInstance` is derived from sessions, one per version.
- **Pairs exist only in upgrade mode.** `upgradePair()` (viewPairing.ts) feeds:
  - View Doctor's Compare with Original, which falls back to a database picker outside upgrade mode;
  - Render side by side, which renders one database outside upgrade mode;
  - "also off in the original";
  - Start/Stop Both Servers.
- **No code diff exists.** The one `vscode.diff` call is View Doctor's view compare.
- **Each database's code can be located:**
  - a version's core trees come from `coreAddonsPaths(settings)`;
  - project repos come from `resolveReposForDatabase(project, db)`, per version and per branch;
  - `findModuleForFile` maps a file to its module.

## 3. Design

The design comes in three parts. Each one ships on its own, in this order: **A** is what B and C rely on.

### Part A — Servers keyed by database

**A1. A run is (version, database, port).**
- `debugSessions.ts` keeps a record per session: `{ name, versionId, dbId, port, kind: 'primary' | 'alongside' }`.
- `RunningInstance` comes from these records, not from versions. Running state, the Databases tree's `running :port`, Open in Browser and Render's port lookup all read it.

**A2. The primary entry is unchanged.** Each version keeps its one launch.json entry, run by F5, with its own name and port (editable since the 2026-10-07 change). Starting it still stops that entry's previous session: restart semantics.

**A3. Run Alongside** (`dbSelector.runAlongside`, on any database row, and in the palette for a picked database):
- It starts a server for that database without touching the others.
- The database's version must be provisioned.
- The configuration is built the same way as the primary entry (`prepareArgs` with a database override). It is passed to `vscode.debug.startDebugging` as an object and never written to launch.json.
- Its name is `<debuggerName> · <db>`.
- Its port is always the first free port from `8100` upwards, probed live, and lasts for that run only. It never takes the version's own port, which stays free for that version's F5 entry.
- Debug or no-debug follows the command used (Run Alongside, or Run Alongside Without Debugging).
- If the database already has a run in this window, the command just says where it runs. It never starts a second one.

**A4. What can run together.** Two runs of the same version share its code checkout. When their project repos need different branches in a repo that is in *checkout* mode (one shared clone), they cannot both be right. Run Alongside refuses with the repo and the two branches named, and offers *Use One Copy Per Branch* for that repo. In worktree mode each branch has its own folder, so it just works.

**A5. Stopping and the rest.**
- *Stop Server* on a database row stops that database's run.
- The existing Stop Server command still prefers the active version's primary run and asks when several are running.
- Stop Both and Start Both keep working, built on A1.
- A run in another window is still detected through `pg_stat_activity` (external) and the port probe, and is never stopped from here.

**A6. Several projects or windows.** Each window runs what it starts. Run Alongside's fallback port means a second window on the same version no longer collides: it takes the next free port. Nothing is coordinated across windows beyond the live port probe.

### Part B — A comparison partner for every database

**B1. The partner.**
- Every database can have **one** partner: another database of the project, or one of its checkpoints (from the checkpoints spec).
- It is stored as `comparePartner?: { dbName: string; kind: 'database' | 'checkpoint' }` on `DatabaseModel`, read only through a normalizer.
- The partner is used in this order:
  1. In upgrade mode, the other side, always. Upgrade mode stays the way to set a pair up with two versions in one step.
  2. Otherwise the stored partner.
  3. Otherwise ask, with the existing `pickOtherDatabase` list (running databases first, now with checkpoints too), and remember the answer.
- *Set Comparison Partner…* and *Clear Comparison Partner* are on the database row. The row's tooltip names the partner.
- **A checkpoint partner refuses connections** (checkpoints spec §3.1). Every read of it (a view's arch, the "also off" ids, a record) goes through one function. That function allows connections, runs the read, and protects the checkpoint again in a `finally`. A checkpoint cannot be rendered or run: those actions say "restore it, or clone it, to run it".

**B2. Left and right.**
- In upgrade mode the original (From) is on the left.
- With a checkpoint, the checkpoint is on the left.
- Otherwise the partner is on the left, and the database you started from on the right, where you can edit.

**B3. What moves out of upgrade mode** (the answer to request 4):

| Feature | Today | After |
|---|---|---|
| View Doctor: Compare with Original | upgrade pair, else a fresh pick | the partner (B1), labelled "Compare with *partner*" |
| View Doctor: Render side by side | upgrade mode only | any database whose partner is a database, not a checkpoint. A side with no server offers *Run Alongside* (A3) |
| "Also off in the original" filter | upgrade mode only | any partner that is a copy of this database, i.e. a checkpoint, a clone, or the upgrade's original, because it matches by id. It is hidden for an unrelated partner |
| Start / Stop Both Servers | upgrade pair | "Run Partner Alongside" on any database with a partner; Start/Stop Both stay for upgrade mode |
| Code compare (Part C) | — | the partner's version and code |
| Read-only original, source-module staging | upgrade only | unchanged: these describe an upgrade |

The README and walkthrough move these features out of the "Upgrade mode" section into a new "Comparing two databases" section, which says that upgrade mode sets the partner for you.

### Part C — Compare

Every compare opens VS Code's diff editor. Each side is a real file when one exists, so the right-hand side stays editable. Otherwise it is a read-only virtual document under a new `odoo-compare:` scheme, whose URIs carry the side and the source. The diff title is `<what>: <left side> ↔ <right side>`, the way View Doctor's titles are.

**C1. Where "the other side's code" is.**

`resolveCounterpartPath(file, fromDb, toDb)`:
1. Find which root the file is under on its own side:
   - a core tree from `coreAddonsPaths` of the database's version, or the Odoo root itself (for `odoo/models.py` and similar);
   - otherwise a project repo from `resolveReposForDatabase`.
2. Take the path relative to that root.
3. Join it to the same root on the other side: the same repository name, or the same core tree.
4. When that file does not exist (a module was renamed or split between versions):
   - search the counterpart module's folder for the same file name;
   - then search the counterpart addons folders for a module of the same name;
   - then offer a quick pick of files with the same name, limited to 50;
   - if nothing is found, report "*x* has no counterpart in *side*".

This is a pure function plus an `fs` probe, unit-tested on fake trees.

**C2. The levels.**

| Level | Where you start it | What is compared |
|---|---|---|
| **File** | editor title "…" menu, editor and Explorer context menus: *Compare with Partner* | the file and its counterpart (C1) |
| **Module** | Modules view row, and Explorer on a module folder: *Compare Module with Partner* | a quick pick of the module's files that were added, removed or changed. Files are compared by size, then content hash. Picking a file opens its diff. A summary line gives the counts |
| **Class / method** | editor context menu when the cursor is in a Python class or function: *Compare This with Partner* | the enclosing class, or method, against its counterpart, as two virtual documents (below) |
| **XML record** | editor context menu inside an XML `<record>` / `<template>` / `<menuitem>`: *Compare This with Partner* | the element with the same `id` in the counterpart module's XML files |
| **Database record** | palette and the Databases row: *Compare Record…* | one record's stored field values in both databases (below) |
| **View** | View Doctor (exists) | arch in both databases, now using the partner |

**Class and method counterparts.**
- The enclosing symbol comes from `vscode.executeDocumentSymbolProvider`, which the Python extension provides. Without it, an indentation-based scan of `class`/`def` lines is used.
- The counterpart is the symbol with the same qualified name (`SaleOrder._compute_amounts`) in the counterpart file.
- If it is not there, the counterpart module's Python files are searched for a class with the same `_name`, or the same `_inherit` when there is no `_name`, that defines the method. Odoo moves methods between files across versions far more often than it renames them.

**Database records.**
- A record is named by its external id (`sale.order_1`), or by its model and id.
- Both sides are read with SQL through `runSql`: the model's table and its stored columns, with `ir_model_fields` used for field names and types.
- Translated (jsonb) fields show their `en_US` value. Binary and attachment fields show size and hash only.
- Each side is rendered as sorted `field: value` lines, so unchanged fields line up.
- A record found on one side only gets an empty other side with a note saying it is missing there.
- A checkpoint partner is read through B1's unprotect-read-protect function.

**C3. Which code is "the partner's".** It is the partner database's version, plus its project repos resolved for that database: a branch and, in worktree mode, its own folder. When both sides resolve to the same file (same version, same checkout), the command says so and opens nothing.

## 4. Out of scope

- A comparison with more than two sides.
- Diffing whole databases, or every record of a model.
- Comparing two arbitrary versions without databases. A database is what ties code to a version; you can still compare a file through any database of each version.
- Coordinating servers across windows beyond the port probe.

## 5. Rulings made in this spec (override any of them)

| Ruling | Why | Cost if wrong |
|---|---|---|
| Alongside runs are never written to launch.json | F5's entry stays one per version, as the editable-identity change made it; extra runs come and go | They cannot be re-run from the Run and Debug dropdown, only from the database row |
| Alongside runs always take the first free port from 8100 up | Clear of the 8000+series range the automatic ports use, and never in the way of a version's F5 entry | A user with services in 8100+ sees the probe skip them; a setting can come later |
| One partner per database, set implicitly by first use | "Comparison is restricted to 2"; asking once and remembering removes every later prompt | A user flipping between two partners re-sets it each time |
| Upgrade mode overrides the stored partner | The upgrade's pair is the point of the mode | You set the partner while upgrading and it seems ignored; the tooltip says why |
| Records are read with SQL, not through an Odoo shell | Instant, works without the version's code or server | Computed non-stored fields are not compared |
| Method counterparts fall back to `_name`/`_inherit` search inside the module | Methods move between files across versions | A method moved to another module is not found; the C1 file quick pick is the fallback |
| Same-checkout conflicts refuse Run Alongside instead of switching branches | Silently checking out a branch under a running server breaks it | You switch the repo to one copy per branch once |

## 6. Testing

- **Unit:**
  - the run records and `RunningInstance` derivation;
  - port fallback over a fake probe;
  - the branch-conflict check;
  - partner resolution order;
  - left and right sides;
  - `resolveCounterpartPath` on fake trees, including a renamed module and a split one;
  - the module diff listing;
  - symbol counterparts, with and without a symbol provider;
  - the XML element finder;
  - record rendering, including translated and binary fields.
- **Gated real Odoo** (17/18/19 base databases, as stage 4's):
  - Run Alongside two databases of one version, check both answer on their ports, and stop one;
  - Compare Record across two databases, and across a checkpoint (it is re-protected afterwards);
  - Render with a non-upgrade partner.
- **Live window under Xvfb:**
  - run three servers (two databases of one version and one of another) and check the tree's ports;
  - Compare with Partner at file, method and XML-record level on a 17→18 pair of real Odoo trees;
  - Compare Module, and the partner's left/right placement;
  - "also off" with a checkpoint partner.
