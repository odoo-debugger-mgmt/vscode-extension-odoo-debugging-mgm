# Database checkpoints — design

**Date:** 2026-10-07 · **Branch:** `v-1.5` · **Status:** draft for review

## 1. What the user asked for

> A feature that allows us to create a copy of the current database as a separate database, which can be restored at any later point. It should work like a transaction checkpoint: several checkpoints at different points in time, and restore the system to any of them when needed. Similar to SH backups, but stored as an actual PostgreSQL database rather than a dump file, so restoring is much faster. — *"I think templates would help here."*

Confirmed in conversation: stopping the database's server for the copy (after asking) is acceptable.

**Success looks like:** right-click a database → *Create Checkpoint* → a few seconds later a checkpoint row sits under it. Later, right-click the checkpoint → *Restore* → the database is exactly as it was, attachments included, and its server is running again if it was before.

## 2. What exists today, and what is wrong with it

- `createDatabase(db, template)` runs `createdb -T` (src/services/postgres.ts). **Templates** (a global list, *Manage Database Templates*) and **Clone Database** are built on it.
- **Neither copies the filestore.** Nothing in the extension touches `<data_dir>/filestore/<db>`, so a clone's attachments, and every asset bundle Odoo stored as an attachment, point at files that do not exist. A restored copy would be just as broken.
- **Neither handles connections.** PostgreSQL refuses to copy a database that has other sessions. `releaseDatabase` only ends the View Doctor's shells; a running Odoo server makes Clone fail with "source database is being accessed by other users".
- The Databases tree is flat: `getChildren` ignores its `element`, and `getParent` returns undefined. Child rows need both handled (a `getChildren` that ignores `element` recurses as soon as any row is collapsible).

Checkpoints fix all three, and Clone and Templates get the same fixes because they share the copy.

## 3. Design

### 3.1 One copy routine for everything

A new service, `src/services/databaseCopy.ts`, with one entry point:

```ts
copyDatabase(source: string, target: string, options: { filestore: boolean; protect?: boolean }): Promise<CopyResult>
```

It runs these steps in order:
1. **Release the source.** Run the existing release listeners. Stop the extension's own server on the source, after asking (§3.4). End the extension's own `odoo-devtools-query` backends. Then count the remaining connections. If any are left (a server in another window, a psql session), say who holds them (`application_name`, client) and offer **End Them** in a modal. That runs `pg_terminate_backend` for that database only.
2. **Copy the database** with `CREATE DATABASE "<target>" TEMPLATE "<source>" STRATEGY FILE_COPY` on PostgreSQL 15 or later, and plain `createdb -T` before 15.
   - FILE_COPY copies the data files directly instead of writing every page to the WAL. For large databases that is the difference between seconds and minutes, and it is what makes "faster than a dump" true.
   - The version comes from `SHOW server_version_num`, once per session.
3. **Copy the filestore** when `filestore` is set (§3.3).
4. **Protect the copy** when `protect` is set. Checkpoints set it: `ALTER DATABASE "<target>" WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`.
   - Nothing can connect to a protected copy and change it, so a checkpoint cannot drift.
   - Odoo's own database list (`list_dbs`) skips databases with `datallowconn = false` or `datistemplate = true`, so checkpoints never appear in Odoo's database selector or manager.
   - Dropping a protected copy flips `IS_TEMPLATE false` first.
5. **Restart the server** if step 1 stopped one.

If any step fails, everything the routine created is removed and the source is left as it was.

Clone Database, *Create Template from Database* and *Create from Template* all switch to this routine, with `filestore: true`.

### 3.2 Checkpoints

**Model.** Add `checkpoints?: CheckpointModel[]` to `DatabaseModel`, read only through an `ensureCheckpoints()` normalizer, because a project from `SettingsStore` is plain JSON cast to the model, not hydrated: a new field is `undefined` on every existing project:

```ts
interface CheckpointModel {
  dbName: string;      // the PostgreSQL database holding it
  label: string;       // user-facing; defaults to the creation time, e.g. "7 Oct 15:42"
  createdAt: string;   // ISO
  filestore: boolean;  // false when the source had no filestore folder
}
```

**Name.** `<db>__cp_<base36 epoch seconds>`. When that would exceed PostgreSQL's 63-byte limit, the database part is cut and a 6-character hash of the full name is added, as `dbNaming.ts` already does. The name is never shown; the label is.

**Create** (`dbSelector.createCheckpoint`):
- It is on the database row's context menu. It is also the row's inline icon, because creating is not destructive.
- It runs `copyDatabase(db, cpName, { filestore: true, protect: true })` and asks for an optional label. The input is pre-filled with the timestamp, so Enter accepts it.
- From the palette it acts on the selected database.

**Restore** (`dbSelector.restoreCheckpoint`):
- It is on the checkpoint row's context menu only. It is never inline, because it is destructive.
- A modal asks: "Restore *db* to *label*? Everything since is lost." The buttons are **Restore** and **Checkpoint Current State, then Restore**.
- The restore is done so the database never goes missing:
  1. Copy the checkpoint into `<db>__restoring`, unprotected.
  2. Release `<db>` (§3.1 step 1).
  3. `ALTER DATABASE <db> RENAME TO <db>__replaced`, then `ALTER DATABASE <db>__restoring RENAME TO <db>`.
  4. Swap the filestore folders the same way.
  5. Drop `<db>__replaced` and its filestore.
  6. Restart the server if one was stopped.
  - If a rename fails, the steps already done are reversed.
- The checkpoint itself is kept, so you can restore it again.
- Afterwards the caches are cleared: installed modules (`clearInstalledModuleCache`), the View Doctor's arch cache and its shell (through the release listeners), and the running-state probe.

**Rename label** and **Delete** sit on the checkpoint row's context menu. Delete asks in a modal, unprotects the database, drops it and removes its filestore.

**Delete Database** now names the database's checkpoints in its confirmation and offers two buttons: **Delete** (keeps the checkpoints, which Reconcile then lists as orphaned) and **Delete with N Checkpoints**.

**Reconcile Databases** (existing) also:
- drops checkpoint records whose database no longer exists;
- offers to delete orphaned `__cp_` databases whose source database is gone.

### 3.3 The filestore

**Where it is.** Odoo keeps attachments in `<data_dir>/filestore/<dbname>/`. The data dir is resolved the way Odoo resolves it, first match wins:
1. `--data-dir=` or `-D` in the version's `extraParams`;
2. `data_dir` in the config file named by `-c` / `--config` in `extraParams`, else `$ODOO_RC`, else `~/.odoorc`, else `~/.openerp_serverrc`;
3. the platform default:
   - Linux: `~/.local/share/Odoo`
   - macOS: `~/Library/Application Support/Odoo`
   - Windows: `%LOCALAPPDATA%\OpenERP S.A.\Odoo`

This lives in a small pure function, `resolveOdooDataDir(settings, env, platform)`, and is unit-tested.

**How it is copied.** By **hard links**: the same directory tree is created under the target's filestore folder, and every file is linked rather than copied.
- This is safe because Odoo never changes a filestore file in place. A file's name is the SHA-1 of its content, it is written once only when it does not exist yet, and the garbage collector only unlinks.
- So the two folders can share the underlying files forever, and a checkpoint of a 5 GB filestore costs almost no space and well under a second.
- If linking fails (EXDEV across filesystems, EPERM on some Windows volumes), the routine falls back to a real copy, says so in the log, and keeps going.

**When a database has no filestore folder,** the checkpoint records `filestore: false`, and restoring it removes the live database's filestore folder.

### 3.4 Running servers

- **Our own server on the database.** If it was started by this window (a tracked debug session whose database is this one), the modal says: "*db* is running in this window. Stop it to take the checkpoint? It restarts afterwards." Its buttons are **Stop and Continue** and Cancel. The server is restarted with `startServerForVersion` on the same version, in debug or no-debug mode as before.
- **Anything else connected.** The modal above lists the other connections and offers **End Them**. Nothing is ended without that click.
- **The View Doctor's shell** is let go of silently, as now, and comes back on its next use.

### 3.5 Upgrade mode

- Checkpoints are allowed on both databases of an upgrade, and so is restoring one. Restoring the upgraded database to its pre-fix state is a main use.
- *Restore* is not added to the actions upgrade mode refuses (`refuseDuringUpgrade`), because it changes data and leaves the pair's identity alone.

### 3.6 The tree

- A database row with checkpoints becomes collapsible and shows the count in its description ("3 checkpoints").
- Each checkpoint row:
  - label: the checkpoint's label
  - description: its age ("2 h ago") and size
  - tooltip: created at, size, whether it has a filestore, and its PostgreSQL name
  - icon: `history`
  - contextValue: `checkpoint`
- The size comes from `pg_database_size`, read once per refresh for all checkpoints in one query. Reading the size does not connect to the checkpoint itself.
- `getChildren(element)` returns the checkpoint rows for a database row, and nothing for a checkpoint row.
- `getParent` returns the database row for a checkpoint row, so reveal still works.

## 4. Out of scope

- Scheduled or automatic checkpoints.
- Checkpoints that live outside this PostgreSQL server.
- Exporting a checkpoint as a dump. A dump import already exists the other way.
- Comparing a database with one of its checkpoints. That is the comparison spec's job; a checkpoint will be a valid comparison partner there.

## 5. Rulings made in this spec (override any of them)

| Ruling | Why | Cost if wrong |
|---|---|---|
| A checkpoint is protected (`ALLOW_CONNECTIONS false`, `IS_TEMPLATE true`) | It can never drift, and it stays out of Odoo's database list | Opening a checkpoint in Odoo needs Restore, or a clone of it, first |
| The filestore is hard-linked, with a copy as fallback | Instant and free for any filestore size; safe because Odoo writes filestore files once | Cheap to change if a version is ever found that rewrites files in place |
| Restore swaps databases by rename, not drop-then-create | The database never goes missing if the copy fails | It needs room for one extra copy during the restore |
| Clone and Templates switch to the same copy routine, with filestore | They are broken the same way today | Clones now take filestore links; noticeably slower only when linking falls back to copying |
| Checkpoints are kept when the database is deleted, unless chosen | Deleting a database should not silently delete its history | Orphans need Reconcile to clean up |
| No keybinding | The palette and the row are enough | Easy to add one |

## 6. Testing

- **Unit:**
  - `resolveOdooDataDir` on all three platforms, with every source of the setting;
  - checkpoint naming, including truncation to 63 bytes;
  - the hard-link tree copy and its fallback, using temp folders and a forced EXDEV;
  - the restore step order and its rollback, against a fake runner;
  - the tree's `getChildren` and `getParent`.
- **Gated real PostgreSQL integration** (in the style of `ODT_VIEW_TEST_*`):
  - create a checkpoint of a database that has one open session, ending it after an approved prompt;
  - change data, restore, and check the data and the filestore are back;
  - check that `datallowconn = false` keeps a checkpoint out of `list_dbs`, using Odoo 17/18/19's own query text;
  - check the size query.
- **Live window under Xvfb:** create, restore with the server running (it comes back), delete, and tree expansion with the count, the age and the size.
