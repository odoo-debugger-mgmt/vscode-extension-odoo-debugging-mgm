# Comparison Partner (Compare spec, Part B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every database can have one comparison partner: another database of the project, or one of its own checkpoints. The View Doctor's Compare, Render side by side and the "also off" filter work with that partner outside Upgrade mode. Upgrade mode only picks the partner for you.

**Architecture:**
- **Pure core.** `src/services/comparisonPartner.ts` holds the stored partner and its normalizer, the resolution order (upgrade pair → stored → ask), left/right placement, and whether the partner is a copy of the database.
- **Reading a checkpoint.** A checkpoint refuses connections, so `src/services/checkpointReads.ts` opens it for the duration of a read (reference-counted) and closes it again in a `finally`.
- **Snapshots.** A checkpoint side of a diff is a read-only snapshot under a new `odoo-compare:` scheme, provided by `src/views/compareDocuments.ts`, which Part C extends.
- **Wiring.** The View Doctor commands and the Views tree switch from `upgradePair` to the partner.

**Tech Stack:** TypeScript, VS Code API (TextDocumentContentProvider, diff editor), psql.

**Spec:** `docs/superpowers/specs/2026-10-07-compare-and-multi-server-design.md`, Part B (B1–B3) and §5. The user said "go ahead" on 2026-10-08. Ruling P1 of the checkpoint plan applies: reads of a checkpoint partner must not race each other's protect/unprotect.

## Global Constraints

- Branch `v-1.5` only; never merge or push. Leave `.vscode/launch.json`, `.vscode/tasks.json` and the root dotfiles alone. Add files by name.
- Commits: `[ADD]`/`[IMP]`/`[FIX]`/`[REF]`/`[DOC]`, ending with a `Co-Authored-By:` trailer that names the model that wrote them. dist/ only in the last task.
- **The stored partner** is `comparePartner?: { dbName: string; kind: 'database' | 'checkpoint' }` on the database record. It is read only through `partnerOf()`, because projects are plain JSON. A stored partner that no longer exists (a deleted database, a deleted checkpoint) counts as none.
- **Resolution order (B1):**
  1. In upgrade mode, if the database is one side of the pair, its partner is the other side, always.
  2. Otherwise, the stored partner.
  3. Otherwise ask with the existing `pickOtherDatabase` list (running databases first), extended with this database's checkpoints, and remember the answer.
  - Background reads (the Views tree) never ask; they use 1 or 2 only.
- **Left and right (B2):**
  - In upgrade mode the original (From) is on the left.
  - With a checkpoint partner, the checkpoint is on the left.
  - Otherwise the partner is on the left and the database you started from is on the right, where it can be edited.
- **A checkpoint partner refuses connections.** Every read of it goes through `withCheckpointOpen()`: open it with `ALTER DATABASE … WITH ALLOW_CONNECTIONS true`, read, and close it with `ALLOW_CONNECTIONS false` in a `finally`. Concurrent reads share one opening (reference count), and the last one closes it. A checkpoint cannot be rendered or run; those actions say "Restore it, or clone it, to run it."
- **"Also off in the original"** shows only when the partner is a copy of this database:
  - a checkpoint;
  - the upgrade's original;
  - a database cloned from this one, or this one cloned from it, recorded as `clonedFrom` on new clones.
  - For any other partner it is hidden.
- **Run Partner Alongside** (a database row) runs the partner with Part A's `runAlongside`. Start/Stop Both Servers stay as they are, for upgrade mode.
- **The command `viewDoctor.compare` is retitled "Compare with Partner".** In upgrade mode the partner is the original. Diff titles stay `<view>: <left db> ↔ <right db>`.
- **Docs.** The README gains a "Comparing two databases" section that says upgrade mode sets the partner for you. Upgrade-mode text that described these features points to it.
- **Verification:**
  - `npx tsc -p . --noEmit` and `npm run lint` (0 errors, 117 warnings baseline).
  - Tests run outside the sandbox: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "<suite>"`; the full suite is `npm test`. Baseline: 971 passing, 33 pending, 0 failing.

## Review Focus

1. **A stored partner that was deleted.** A database deleted, or a checkpoint deleted or restored over, is treated as no partner. The user is asked again, and nothing breaks or reads a missing database. (Task 1 test; Task 4 path.)
2. **Two reads of a checkpoint at once**, for example the Views tree's "also off" read while Compare reads the arch. One open and one close; the database is never left open, and is not closed while the other read is running. (Task 2 test.)
3. **A read that throws while the checkpoint is open** still closes it. (Task 2 test.)
4. **Comparing from the original side in upgrade mode.** The original stays on the left, and the upgraded counterpart is on the right. (Task 1 test of `comparisonSides`.)
5. **An extension host that dies while a checkpoint is open** leaves it connectable. On activation, the extension closes every checkpoint recorded in the store that is still open. (Task 2.)

## Rulings made while planning

- **B-R1.** `viewDoctor.compare` gets one title, "Compare with Partner", instead of a second command per mode. VS Code titles are static, and duplicated menus double the guard tests — cost if wrong: upgrade users read "Partner" where they read "Original"; the README says the partner is the original there.
- **B-R2.** A clone records its source (`clonedFrom`) from now on. Older clones are not treated as copies — cost if wrong: an older clone partner does not get the "also off" filter.
- **B-R3.** A checkpoint side of a diff is a snapshot, read once, not the live `odoo-view:` file. A checkpoint cannot change, and the live file's 3 s poll would open and close it constantly — cost if wrong: none.
- **B-R4.** Render with no partner yet asks (B1 step 3), like Compare. With a checkpoint partner it renders this database alone, with the notice "A checkpoint cannot be rendered: restore it, or clone it, to run it." — cost if wrong: none.
- **B-R5.** Opening a checkpoint is reference-counted per database, not one-at-a-time. Reads never wait on each other, and only the last read closes it. This refines ruling P1, which avoided a read closing it under another — cost if wrong: none.
- **B-R6.** On activation, every checkpoint recorded in this workspace's store that is open (`datallowconn = true`) is closed again — cost if wrong: none; a checkpoint is never meant to be open.
- **B-R7.** Render's start button runs the sides that are not running alongside, through a hidden `dbSelector.runPairAlongside` command with arguments. `RenderRequest` gains `startArgs?: unknown[]` — cost if wrong: none.

## File structure

| File | Responsibility |
|---|---|
| `src/services/comparisonPartner.ts` (new) | `PartnerModel`, `partnerOf`/`setPartner`, `resolveStoredPartner`, `comparisonSides`, `isCopyPartner`, `partnerChoices`. Pure |
| `src/models/db.ts` | `comparePartner?`, `clonedFrom?` fields |
| `src/dbs.ts` | clone records `clonedFrom` |
| `src/services/checkpointReads.ts` (new) | `withCheckpointOpen` (ref-counted, over a small backend), `realCheckpointOpener`, `closeOpenCheckpoints` |
| `src/views/compareDocuments.ts` (new) | `odoo-compare:` read-only content provider; `snapshotUri(side, label, content)` |
| `src/views/viewPairing.ts` | `partnerFor(project, dbId, { ask })`, the checkpoint entries in `pickOtherDatabase` |
| `src/commands/partnerCommands.ts` (new), `src/commands/index.ts`, `package.json` | Set / Clear Comparison Partner, Run Partner Alongside, hidden Run Pair Alongside |
| `src/views/dbsView.ts` | tooltip names the partner |
| `src/views/viewRenderPanel.ts` | `startArgs` |
| `src/commands/viewDoctorCommands.ts`, `src/views/viewDoctorView.ts` | Compare, Render and "also off" use the partner |
| `src/extension.ts` | register the content provider; close open checkpoints on activation |
| `README.md`, `CHANGELOG.md`, walkthrough if it names these features, `dist/` | last task |

---

### Task 1: The partner model and its pure rules

**Files:**
- Create: `src/services/comparisonPartner.ts`
- Modify: `src/models/db.ts` (two optional fields with doc comments, plus constructor options); `src/dbs.ts` `cloneDatabaseFlow` (the clone gets `clonedFrom: db.id`)
- Test: `src/test/comparisonPartner.test.ts`

**Interfaces:**
- Produces:
  - `interface PartnerModel { dbName: string; kind: 'database' | 'checkpoint' }`
  - `partnerOf(db: { comparePartner?: unknown }): PartnerModel | undefined`
  - `setPartner(db: { comparePartner?: unknown }, partner: PartnerModel | undefined): void`
  - `interface PartnerProject { dbs?: Array<{ id: string; versionId?: string; comparePartner?: unknown; checkpoints?: unknown; clonedFrom?: unknown }>; upgradeConfig?: unknown }`
  - `interface ResolvedPartner { dbName: string; kind: 'database' | 'checkpoint'; source: 'upgrade' | 'stored'; versionId?: string; label: string }`. For a checkpoint, `label` is the checkpoint's label and `versionId` is its database's version.
  - `resolveStoredPartner(project: PartnerProject | undefined, dbId: string, pair: { original: { dbName: string; versionId?: string }; upgraded: { dbName: string; versionId?: string } } | undefined): ResolvedPartner | undefined`, which covers B1 steps 1 and 2.
  - `comparisonSides(current: string, partner: ResolvedPartner, pair?: { original: { dbName: string } }): { left: string; right: string; editable: 'left' | 'right' | 'none' }`
  - `isCopyPartner(project: PartnerProject | undefined, dbId: string, partner: ResolvedPartner): boolean`
  - `partnerChoices(project: PartnerProject | undefined, dbId: string, running: ReadonlySet<string>): Array<{ dbName: string; kind: 'database' | 'checkpoint'; label: string; running: boolean }>`. Other databases come first, running before stopped, then this database's checkpoints, newest first.

- [ ] **Step 1: Write the failing test** `src/test/comparisonPartner.test.ts`

```ts
import * as assert from 'assert';
import {
    comparisonSides, isCopyPartner, partnerChoices, partnerOf, resolveStoredPartner, setPartner, PartnerProject
} from '../services/comparisonPartner';

const cp = (id: string, label: string, at: string) => ({ id, label, createdAt: at, filestore: true });

const project: PartnerProject = {
    dbs: [
        { id: 'shop', versionId: 'v17', comparePartner: { dbName: 'shop-copy', kind: 'database' }, checkpoints: [cp('shop__cp_1', 'before', '2026-10-01T00:00:00Z'), cp('shop__cp_2', 'after', '2026-10-02T00:00:00Z')] },
        { id: 'shop-copy', versionId: 'v17', clonedFrom: 'shop' },
        { id: 'other', versionId: 'v18', comparePartner: { dbName: 'gone', kind: 'database' } },
        { id: 'withcp', versionId: 'v17', comparePartner: { dbName: 'withcp__cp_9', kind: 'checkpoint' }, checkpoints: [] }
    ]
};
const pair = { original: { dbName: 'old17', versionId: 'v17' }, upgraded: { dbName: 'new18', versionId: 'v18' } };

suite('Comparison partner', () => {
    test('partnerOf reads only a well-formed record', () => {
        assert.deepStrictEqual(partnerOf({ comparePartner: { dbName: 'x', kind: 'checkpoint' } }), { dbName: 'x', kind: 'checkpoint' });
        assert.strictEqual(partnerOf({}), undefined);
        assert.strictEqual(partnerOf({ comparePartner: { dbName: '', kind: 'database' } }), undefined);
        assert.strictEqual(partnerOf({ comparePartner: { dbName: 'x', kind: 'nope' } }), undefined);
        const db: { comparePartner?: unknown } = {};
        setPartner(db, { dbName: 'y', kind: 'database' });
        assert.strictEqual(partnerOf(db)?.dbName, 'y');
        setPartner(db, undefined);
        assert.strictEqual(db.comparePartner, undefined);
    });

    test('upgrade mode pairs the two sides, whatever is stored', () => {
        const withPair: PartnerProject = { dbs: [{ id: 'new18', comparePartner: { dbName: 'shop', kind: 'database' } }, { id: 'old17' }, { id: 'shop' }] };
        assert.deepStrictEqual(resolveStoredPartner(withPair, 'new18', pair), { dbName: 'old17', kind: 'database', source: 'upgrade', versionId: 'v17', label: 'old17' });
        assert.strictEqual(resolveStoredPartner(withPair, 'old17', pair)?.dbName, 'new18');
    });

    test('otherwise the stored partner, when it still exists', () => {
        assert.deepStrictEqual(resolveStoredPartner(project, 'shop', undefined), { dbName: 'shop-copy', kind: 'database', source: 'stored', versionId: 'v17', label: 'shop-copy' });
        assert.strictEqual(resolveStoredPartner(project, 'other', undefined), undefined, 'a deleted database is no partner');
        assert.strictEqual(resolveStoredPartner(project, 'withcp', undefined), undefined, 'a deleted checkpoint is no partner');
        assert.strictEqual(resolveStoredPartner(project, 'shop-copy', undefined), undefined, 'none stored');
    });

    test('a checkpoint partner carries its label and its database version', () => {
        const p: PartnerProject = { dbs: [{ id: 'shop', versionId: 'v17', comparePartner: { dbName: 'shop__cp_1', kind: 'checkpoint' }, checkpoints: [cp('shop__cp_1', 'before', '2026-10-01T00:00:00Z')] }] };
        assert.deepStrictEqual(resolveStoredPartner(p, 'shop', undefined), { dbName: 'shop__cp_1', kind: 'checkpoint', source: 'stored', versionId: 'v17', label: 'before' });
    });

    test('left and right', () => {
        const db = (dbName: string, kind: 'database' | 'checkpoint' = 'database', source: 'upgrade' | 'stored' = 'stored') => ({ dbName, kind, source, label: dbName });
        assert.deepStrictEqual(comparisonSides('new18', db('old17', 'database', 'upgrade'), pair), { left: 'old17', right: 'new18', editable: 'right' });
        assert.deepStrictEqual(comparisonSides('old17', db('new18', 'database', 'upgrade'), pair), { left: 'old17', right: 'new18', editable: 'right' });
        assert.deepStrictEqual(comparisonSides('shop', db('shop__cp_1', 'checkpoint')), { left: 'shop__cp_1', right: 'shop', editable: 'right' });
        assert.deepStrictEqual(comparisonSides('shop', db('shop-copy')), { left: 'shop-copy', right: 'shop', editable: 'right' });
    });

    test('only a copy of this database gets the "also off" filter', () => {
        const as = (dbName: string, kind: 'database' | 'checkpoint', source: 'upgrade' | 'stored') => ({ dbName, kind, source, label: dbName });
        assert.strictEqual(isCopyPartner(project, 'shop', as('shop__cp_1', 'checkpoint', 'stored')), true);
        assert.strictEqual(isCopyPartner(project, 'new18', as('old17', 'database', 'upgrade')), true);
        assert.strictEqual(isCopyPartner(project, 'shop', as('shop-copy', 'database', 'stored')), true, 'clone of this one');
        assert.strictEqual(isCopyPartner(project, 'shop-copy', as('shop', 'database', 'stored')), true, 'this one is the clone');
        assert.strictEqual(isCopyPartner(project, 'shop', as('other', 'database', 'stored')), false);
    });

    test('choices: other databases (running first), then this database\'s checkpoints, newest first', () => {
        const choices = partnerChoices(project, 'shop', new Set(['other']));
        assert.deepStrictEqual(choices.map(c => [c.dbName, c.kind, c.running]), [
            ['other', 'database', true],
            ['shop-copy', 'database', false],
            ['withcp', 'database', false],
            ['shop__cp_2', 'checkpoint', false],
            ['shop__cp_1', 'checkpoint', false]
        ]);
        assert.strictEqual(choices[3].label, 'after');
    });
});
```

- [ ] **Step 2: Run it to see it fail** — `npm run compile-tests`.

- [ ] **Step 3: Implement `src/services/comparisonPartner.ts`.** Use `checkpointsOf` from `./checkpoints` to read checkpoints, and keep the module pure, with no vscode import.
  - `resolveStoredPartner`:
    - When `pair` is given and `dbId` is one of its sides, return the other side (`source: 'upgrade'`, `label` = its dbName).
    - Else read `partnerOf(db)`:
      - kind `database`: it exists when `project.dbs` has that id, and `versionId` comes from that database;
      - kind `checkpoint`: it exists when `checkpointsOf(db)` has that id; `label` is the checkpoint's label, and `versionId` is the database's own.
  - `comparisonSides`:
    - if `pair` is given and the partner's source is `upgrade`, left is `pair.original.dbName` and right is the other one;
    - else left is the partner and right is current.
    - `editable` is `'right'` in all three cases. It exists for Part C, so keep it.
  - `isCopyPartner` returns true for a checkpoint, for the upgrade source, or for a `clonedFrom` relation in either direction.
  - `partnerChoices` as described in the Interfaces.

- [ ] **Step 4: Add the model fields** in `src/models/db.ts`:
  - `comparePartner?: { dbName: string; kind: 'database' | 'checkpoint' }`, documented "read through partnerOf()";
  - `clonedFrom?: string`, documented "the database this one was cloned from, recorded since 1.5".
  - Add both to `DatabaseOptions` and to the constructor, copying them when well-formed.
  - In `src/dbs.ts` `cloneDatabaseFlow`, pass `clonedFrom: db.id` to the clone's `DatabaseModel`.

- [ ] **Step 5: Run it to see it pass** — `--grep "Comparison partner"`, then the full suite once.

- [ ] **Step 6: Commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist 2>/dev/null; git add src/services/comparisonPartner.ts src/models/db.ts src/dbs.ts src/test/comparisonPartner.test.ts
git commit -m "[ADD] A comparison partner for every database: model and rules

Upgrade pair first, then the stored partner while it exists. Left and
right sides; whether the partner is a copy of the database.

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 2: Reading a checkpoint, and read-only snapshots

**Files:**
- Create: `src/services/checkpointReads.ts`, `src/views/compareDocuments.ts`
- Modify: `src/extension.ts` (register the provider; close open checkpoints after activation, best effort, not awaited before the views appear)
- Test: `src/test/checkpointReads.test.ts`, `src/test/compareDocuments.test.ts`

**Interfaces:**
- Consumes:
  - `quotePgIdentifier` and `runSql` (postgres.ts);
  - `sqlText` (viewQueries.ts);
  - `checkpointsOf` (checkpoints.ts);
  - `SettingsStore.get('odoo-debugger-data.json')`, the read the reconcile code uses.
- Produces:
  - `interface CheckpointOpener { open(db: string): Promise<void>; close(db: string): Promise<void> }`
  - `withCheckpointOpen<T>(db: string, read: () => Promise<T>, opener?: CheckpointOpener): Promise<T>`, ref-counted per db.
  - `realCheckpointOpener: CheckpointOpener`, which runs `ALTER DATABASE <q> WITH ALLOW_CONNECTIONS true|false;` through `runSql('postgres', …)`.
  - `closeOpenCheckpoints(): Promise<string[]>`, which returns the names it closed.
  - compareDocuments.ts:
    - `COMPARE_SCHEME = 'odoo-compare'`;
    - `class CompareDocuments implements vscode.TextDocumentContentProvider`, with `provideTextDocumentContent(uri)`;
    - `snapshotUri(side: string, label: string, content: string): vscode.Uri`, which stores the content and returns `odoo-compare:/<side>/<label>?n=<counter>`;
    - `compareDocuments`, a singleton instance registered in extension.ts.

- [ ] **Step 1: Write the failing tests**

`src/test/checkpointReads.test.ts`:

```ts
import * as assert from 'assert';
import { withCheckpointOpen, CheckpointOpener } from '../services/checkpointReads';

function opener() {
    const calls: string[] = [];
    const o: CheckpointOpener = {
        open: async db => { calls.push(`open ${db}`); },
        close: async db => { calls.push(`close ${db}`); }
    };
    return { o, calls };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

suite('Reading a checkpoint', () => {
    test('opens for the read and closes after', async () => {
        const { o, calls } = opener();
        const value = await withCheckpointOpen('cp', async () => { calls.push('read'); return 42; }, o);
        assert.strictEqual(value, 42);
        assert.deepStrictEqual(calls, ['open cp', 'read', 'close cp']);
    });

    test('two reads at once share one opening, and the last closes it', async () => {
        const { o, calls } = opener();
        let release!: () => void;
        const slow = new Promise<void>(resolve => { release = resolve; });
        const a = withCheckpointOpen('cp', async () => { calls.push('a start'); await slow; calls.push('a end'); }, o);
        await tick();
        const b = withCheckpointOpen('cp', async () => { calls.push('b'); }, o);
        await b;
        assert.ok(!calls.includes('close cp'), 'b must not close it under a');
        release();
        await a;
        assert.deepStrictEqual(calls.filter(c => c.startsWith('open') || c.startsWith('close')), ['open cp', 'close cp']);
    });

    test('a read that throws still closes it', async () => {
        const { o, calls } = opener();
        await assert.rejects(withCheckpointOpen('cp', async () => { throw new Error('boom'); }, o), /boom/);
        assert.deepStrictEqual(calls, ['open cp', 'close cp']);
    });

    test('a failed open does not count as opened', async () => {
        const calls: string[] = [];
        const o: CheckpointOpener = { open: async () => { throw new Error('denied'); }, close: async db => { calls.push(`close ${db}`); } };
        await assert.rejects(withCheckpointOpen('cp', async () => 1, o), /denied/);
        assert.deepStrictEqual(calls, []);
        const ok = opener();
        assert.strictEqual(await withCheckpointOpen('cp', async () => 2, ok.o), 2, 'the count is back to zero');
        assert.deepStrictEqual(ok.calls, ['open cp', 'close cp']);
    });

    test('different checkpoints are counted apart', async () => {
        const { o, calls } = opener();
        await Promise.all([withCheckpointOpen('a', async () => 1, o), withCheckpointOpen('b', async () => 2, o)]);
        assert.deepStrictEqual(calls.sort(), ['close a', 'close b', 'open a', 'open b']);
    });
});
```

`src/test/compareDocuments.test.ts`:

```ts
import * as assert from 'assert';
import { CompareDocuments, COMPARE_SCHEME } from '../views/compareDocuments';

suite('Compare documents', () => {
    test('a snapshot reads back as it was stored, under its own uri', () => {
        const docs = new CompareDocuments();
        const a = docs.snapshotUri('left', 'shop__cp_1 · view.xml', '<form/>');
        const b = docs.snapshotUri('left', 'shop__cp_1 · view.xml', '<tree/>');
        assert.strictEqual(a.scheme, COMPARE_SCHEME);
        assert.notStrictEqual(a.toString(), b.toString());
        assert.strictEqual(docs.provideTextDocumentContent(a), '<form/>');
        assert.strictEqual(docs.provideTextDocumentContent(b), '<tree/>');
    });

    test('an unknown uri reads as a short explanation, not an error', () => {
        const docs = new CompareDocuments();
        const text = docs.provideTextDocumentContent(docs.snapshotUri('x', 'y', 'z').with({ query: 'n=999999' }));
        assert.ok(/no longer available/i.test(text));
    });
});
```

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement `checkpointReads.ts`**

```ts
/**
 * Reading a checkpoint. A checkpoint refuses connections so that it cannot
 * change (checkpoints spec §3.1); a comparison still has to read it. Each read
 * opens it, and the last of any reads running at once closes it again, in a
 * finally.
 */
import { quotePgIdentifier, runSql } from './postgres';
import { SettingsStore } from '../settingsStore';
import { checkpointsOf } from './checkpoints';
import { sqlText } from './views/viewQueries';
import { logger } from './logger';

export interface CheckpointOpener {
    open(db: string): Promise<void>;
    close(db: string): Promise<void>;
}

export const realCheckpointOpener: CheckpointOpener = {
    open: async db => { await runSql('postgres', `ALTER DATABASE ${quotePgIdentifier(db)} WITH ALLOW_CONNECTIONS true;`); },
    close: async db => { await runSql('postgres', `ALTER DATABASE ${quotePgIdentifier(db)} WITH ALLOW_CONNECTIONS false;`); }
};

const openings = new Map<string, { count: number; ready: Promise<void> }>();

export async function withCheckpointOpen<T>(db: string, read: () => Promise<T>, opener: CheckpointOpener = realCheckpointOpener): Promise<T> {
    let entry = openings.get(db);
    if (!entry) {
        const ready = opener.open(db);
        entry = { count: 0, ready };
        openings.set(db, entry);
        ready.catch(() => {
            if (openings.get(db) === entry) {
                openings.delete(db);
            }
        });
    }
    entry.count++;
    try {
        await entry.ready;
    } catch (error) {
        entry.count--;
        throw error;
    }
    try {
        return await read();
    } finally {
        entry.count--;
        if (entry.count === 0 && openings.get(db) === entry) {
            openings.delete(db);
            await opener.close(db).catch(error => logger.warn(`Could not close checkpoint ${db} again:`, error));
        }
    }
}

/** Closes every recorded checkpoint left open, e.g. by a host that died mid-read. */
export async function closeOpenCheckpoints(): Promise<string[]> {
    const data = await SettingsStore.get('odoo-debugger-data.json').catch(() => undefined);
    const names = (data?.projects ?? []).flatMap(project => (project.dbs ?? []).flatMap(db => checkpointsOf(db ?? {}).map(cp => cp.id)));
    if (names.length === 0) {
        return [];
    }
    const open = (await runSql('postgres',
        `SELECT datname FROM pg_database WHERE datistemplate AND datallowconn AND datname IN (${names.map(sqlText).join(', ')});`))
        .split('\n').map(line => line.trim()).filter(Boolean);
    for (const name of open) {
        await realCheckpointOpener.close(name).catch(error => logger.warn(`Could not close checkpoint ${name}:`, error));
    }
    return open;
}
```

Check the `SettingsStore.get` return type: `data.projects` may be typed, so adapt the casts as `findStaleReferences` does.

- [ ] **Step 4: Implement `compareDocuments.ts`**

```ts
/**
 * Read-only documents for one side of a comparison: a checkpoint's view, and
 * (Part C) a method, an XML element or a record. Each snapshot gets its own
 * uri, so two compares never share a document.
 */
import * as vscode from 'vscode';

export const COMPARE_SCHEME = 'odoo-compare';

export class CompareDocuments implements vscode.TextDocumentContentProvider {
    private readonly contents = new Map<string, string>();
    private counter = 0;

    snapshotUri(side: string, label: string, content: string): vscode.Uri {
        const n = ++this.counter;
        const uri = vscode.Uri.from({ scheme: COMPARE_SCHEME, path: `/${side}/${label}`, query: `n=${n}` });
        this.contents.set(uri.toString(), content);
        return uri;
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.toString())
            ?? 'This comparison is no longer available. Run the compare again.';
    }
}

export const compareDocuments = new CompareDocuments();
```

The label may contain characters such as `/` or `?`. Replace `/` with `∕` (U+2215) in `label` before building the path, and keep the rest. Add that to the test if you change behaviour.

- [ ] **Step 5: `extension.ts`.**
  - Register the provider: `context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(COMPARE_SCHEME, compareDocuments))`.
  - Fire `void closeOpenCheckpoints().then(closed => closed.length && logger.info(\`Closed checkpoints left open: ${closed.join(', ')}\`)).catch(error => logger.debug('Could not check for open checkpoints:', error))` after the stores are ready, where `logStaleReferences` is called.

- [ ] **Step 6: Run the tests to see them pass**, then commit.

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist 2>/dev/null; git add src/services/checkpointReads.ts src/views/compareDocuments.ts src/extension.ts src/test/checkpointReads.test.ts src/test/compareDocuments.test.ts
git commit -m "[ADD] Read a checkpoint without leaving it open; read-only compare documents

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 3: Partner commands, tooltip, and Render's start arguments

**Files:**
- Create: `src/commands/partnerCommands.ts`
- Modify:
  - `src/views/viewPairing.ts`: add `partnerFor`, and checkpoints in the picker;
  - `src/views/dbsView.ts`: the tooltip;
  - `src/views/viewRenderPanel.ts`: `startArgs`;
  - `src/commands/index.ts`;
  - `package.json`;
  - `src/test/upgradeGuards.test.ts`.
- Test: `src/test/partnerMenus.test.ts`

**Interfaces:**
- Consumes: Task 1 (`resolveStoredPartner`, `partnerChoices`, `setPartner`, `PartnerModel`, `ResolvedPartner`); Part A's `runAlongside`; `upgradePair`; `getRunningInstances`; `SettingsStore.getSelectedProject`/`saveWithoutComments`/`stripSettings`.
- Produces:
  - `partnerFor(project: PairProject | undefined, dbId: string, options: { ask: boolean }): Promise<ResolvedPartner | undefined>` in viewPairing.ts. With `ask`, when nothing resolves, it shows the picker (`partnerChoices` with running state), saves the answer as the stored partner, and returns it with `source: 'stored'`.
  - The commands:
    - `dbSelector.setComparisonPartner`, titled "Set Comparison Partner…";
    - `dbSelector.clearComparisonPartner`, titled "Clear Comparison Partner";
    - `dbSelector.runPartnerAlongside`, titled "Run Partner Alongside";
    - `dbSelector.runPairAlongside`, hidden with palette `when: false`, which takes `(...dbIds: string[])`.
  - `RenderRequest.startArgs?: unknown[]`, passed to `executeCommand(startCommand, ...startArgs)`.

- [ ] **Step 1: The failing menu test** `src/test/partnerMenus.test.ts`:
  - all four commands are contributed with the titles above;
  - Set, Clear and Run Partner Alongside are on `view == dbSelector && viewItem == database` rows in a group starting with `3_compare`, with no `upgrade_enabled` guard and no inline entry;
  - `dbSelector.runPairAlongside` has a commandPalette entry with `when: "false"` and no row entry.

  Write it in the style of `src/test/alongsideMenus.test.ts`. Add the three row commands to `MUST_STAY` in `src/test/upgradeGuards.test.ts`.

- [ ] **Step 2: package.json.** Add the four commands with category "Odoo DevTools", the three row menu entries (`3_compare@1..3`), and the palette `when: false` for `runPairAlongside`. Format them like the surrounding entries.

- [ ] **Step 3: `partnerFor` in viewPairing.ts**

```ts
/**
 * The database's comparison partner (Part B): the upgrade's other side, else
 * the stored one while it exists, else - when the caller may ask - one the user
 * picks, which is then remembered.
 */
export async function partnerFor(project: PairProject | undefined, dbId: string, options: { ask: boolean }): Promise<ResolvedPartner | undefined> {
    const resolved = resolveStoredPartner(project as PartnerProject | undefined, dbId, upgradePair(project));
    if (resolved || !options.ask) {
        return resolved;
    }
    const running = new Set((await getRunningInstances()).map(instance => instance.dbName));
    const choices = partnerChoices(project as PartnerProject | undefined, dbId, running);
    if (choices.length === 0) {
        void showInfo(`The project has no other database or checkpoint to compare ${dbId} with.`);
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(choices.map(choice => ({
        label: choice.kind === 'checkpoint' ? `$(history) ${choice.label}` : choice.dbName,
        description: choice.kind === 'checkpoint' ? `checkpoint of ${dbId}` : (choice.running ? 'running' : undefined),
        choice
    })), { title: `Compare ${dbId} with…`, placeHolder: 'Its comparison partner, remembered for next time' });
    if (!picked) {
        return undefined;
    }
    await storePartner(dbId, { dbName: picked.choice.dbName, kind: picked.choice.kind });
    return resolveStoredPartner({ ...(project as PartnerProject), dbs: (project?.dbs ?? []).map(db => db.id === dbId ? { ...db, comparePartner: { dbName: picked.choice.dbName, kind: picked.choice.kind } } : db) }, dbId, undefined);
}

/** Saves (or, with undefined, clears) a database's stored partner. */
export async function storePartner(dbId: string, partner: PartnerModel | undefined): Promise<void> {
    const result = await SettingsStore.getSelectedProject();
    const db = (result?.project.dbs as Array<{ id: string; comparePartner?: unknown }> | undefined)?.find(entry => entry.id === dbId);
    if (!result || !db) {
        return;
    }
    setPartner(db, partner);
    await SettingsStore.saveWithoutComments(stripSettings(result.data));
}
```

Add `comparePartner?`, `checkpoints?` and `clonedFrom?` to `PairProject.dbs`'s element type, so that it is assignable to `PartnerProject`. Keep `pickOtherDatabase` and `compareTargets` exported, since other code may still use them. Task 4 replaces their View Doctor uses.

- [ ] **Step 4: `src/commands/partnerCommands.ts`**
  - **Set Comparison Partner…** shows the picker from `partnerChoices` and stores the answer. It needs a row (`extractDatabaseFromEvent`); from the palette it asks which database first, reusing the picker from `alongsideCommands.ts` (export `databaseFor` there if needed).
    - In upgrade mode, for a pair member, it shows "In Upgrade mode, <db>'s partner is the other side of the upgrade." and still stores the choice for later.
  - **Clear Comparison Partner** calls `storePartner(db.id, undefined)` and says so.
  - **Run Partner Alongside** calls `partnerFor(project, db.id, { ask: true })`.
    - A checkpoint partner shows "A checkpoint cannot be run: restore it, or clone it, to run it."
    - Otherwise it calls `await runAlongside(partner.dbName, {})`.
  - **runPairAlongside(...dbIds)** runs `await runAlongside(id, { quiet: true })` for each id. A database already running is fine, because `runAlongside` returns ok. It collects failures and shows one error that lists them.
  - Call `refreshAll({ reason: 'ui' })` after every change. Register the commands in `index.ts` after `registerAlongsideCommands`.

- [ ] **Step 5: The tooltip.** In `dbsView.ts` `buildTooltip`, add `**Comparison partner:** <label>` after the version lines. Use `resolveStoredPartner(project, db.id, pair)`; `buildDatabaseItem` already receives the upgrade side, so pass the project/pair down as the code allows. For a checkpoint add ` (checkpoint)`, and for `source: 'upgrade'` add ` (the other side of the upgrade)`. Show nothing when there is no partner.

- [ ] **Step 6: `startArgs`.** In `viewRenderPanel.ts`, add `startArgs?: unknown[]` to `RenderRequest`, and in `startServers` call `executeCommand(this.request.startCommand, ...(this.request.startArgs ?? []))`.

- [ ] **Step 7: Run tests and commit.** Run `--grep "Partner menus|What upgrade mode hides|Extension Test Suite|Comparison partner"`, then the full suite.

```bash
git add src/commands/partnerCommands.ts src/views/viewPairing.ts src/views/dbsView.ts src/views/viewRenderPanel.ts src/commands/index.ts package.json src/test/partnerMenus.test.ts src/test/upgradeGuards.test.ts
git commit -m "[ADD] Set, clear and run a database's comparison partner

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 4: The View Doctor uses the partner

**Files:**
- Modify:
  - `src/commands/viewDoctorCommands.ts`: `viewDoctor.compare` and `viewDoctor.render`;
  - `src/views/viewDoctorView.ts`: the "also off" source;
  - `package.json`: the `viewDoctor.compare` title.
- Test: `src/test/viewPairing.test.ts` (extend), plus a new pure helper test as needed.

**Interfaces:**
- Consumes:
  - Task 1: `comparisonSides`, `isCopyPartner`, `resolveStoredPartner`;
  - Task 2: `withCheckpointOpen`, `compareDocuments.snapshotUri`;
  - Task 3: `partnerFor`, `startArgs`;
  - existing: `findCounterpart`, `diffArguments`, `viewUri`, and the view service's `getArch` (used by `ViewFileSystemProvider.readFile`), plus `viewService.doctorGroups`.
- Produces: a pure helper `alsoOffSource(project, dbId, pair): { dbName: string; checkpoint: boolean } | undefined`, exported from viewPairing.ts, used by the Views tree.

- [ ] **Step 1: Write the failing test for `alsoOffSource`** in `src/test/viewPairing.test.ts`:
  - upgrade, upgraded side: `{ dbName: original, checkpoint: false }`;
  - upgrade, original side: `undefined`, since the original has no "also off";
  - a stored checkpoint partner: `{ dbName: cp, checkpoint: true }`;
  - a stored clone partner (`clonedFrom`): `{ dbName, checkpoint: false }`;
  - an unrelated stored partner: `undefined`;
  - no partner: `undefined`.

  Implement it with `resolveStoredPartner` and `isCopyPartner`. On the upgrade original side it returns undefined: keep the existing `target?.side === 'to'` behaviour.

- [ ] **Step 2: Compare.** In `viewDoctor.compare`:
  1. Read `project`, then `partner = await partnerFor(project, item.dbName, { ask: true })`. If there is none, return.
  2. Get `{ left, right } = comparisonSides(item.dbName, partner, upgradePair(project))`. The item's database is one side and the partner's database is the other.
  3. Find the counterpart in the partner's database with `findCounterpart(item.view, partner.dbName)`. When `partner.kind === 'checkpoint'`, wrap it: `withCheckpointOpen(partner.dbName, () => findCounterpart(...))`. The pick dialog inside `findCounterpart` may then run while the checkpoint is open; that is accepted.
  4. Build the two uris.
     - The item's side is `viewUri(item.dbName, item.view.id, …)`, as today.
     - A database partner's side is `viewUri(partner.dbName, counterpart.id, …)`.
     - A checkpoint partner's side is `compareDocuments.snapshotUri('left', \`${partner.label} · ${counterpart.xmlid ?? counterpart.id}.xml\`, await withCheckpointOpen(partner.dbName, () => viewService.getArch(partner.dbName, counterpart.id)))`.
     - Use whatever the arch-reading function is actually called; check `ViewFileSystemProvider`'s backend.
  5. Order the uris by `left`/`right`.
  6. The title is `${item.view.name}: ${leftLabel} ↔ ${rightLabel}`, with the checkpoint's label in place of its database name.
  7. Open it with `vscode.diff`.

  Keep the existing "has no … view to compare with" message, naming the partner's label. Retitle the command in package.json to "Compare with Partner".

- [ ] **Step 3: Render.** In `viewDoctor.render`:
  - Keep the upgrade path as it is.
  - Otherwise call `partnerFor(project, item.dbName, { ask: true })`:
    - **Undefined:** render the item alone, as today.
    - **A checkpoint:** render the item alone with `notice: 'A checkpoint cannot be rendered: restore it, or clone it, to run it.'`.
    - **A database:** find the counterpart in the partner's database, as the upgrade path does. Put the targets in `comparisonSides` order, with titles `${partner.dbName}` and `${item.dbName}` and each database's own `versionId`. Then:
      - set `startCommand: 'dbSelector.runPairAlongside'`, `startArgs: [left, right]` and `startLabel: 'Run Both'`;
      - keep the existing `notice` when the partner has no matching view, worded with the partner's name.

- [ ] **Step 4: "Also off".** In `viewDoctorView.ts` `load()`:
  - Replace the `originalDb` computation with `alsoOffSource(project, target.dbName, upgradePair(project))`. Keep using `target.side === 'to'` for the upgrade case, as `alsoOffSource` does.
  - When the source is a checkpoint, call `withCheckpointOpen(source.dbName, () => this.service.doctorGroups(target.dbName, source.dbName))`; otherwise call it as before.
  - `comparing` becomes `!!source && source.dbName !== target.dbName`.
  - The tree's existing "shows N also off" text stays. If it names the original database, it should name `source.dbName`; check the strings.

- [ ] **Step 5: Run tests and commit.** Run `--grep "View pairing|Views tree|View Doctor"`, using the suite names the files declare (check them), then the full suite.

```bash
git add src/commands/viewDoctorCommands.ts src/views/viewDoctorView.ts src/views/viewPairing.ts package.json src/test/viewPairing.test.ts
git commit -m "[IMP] Compare, render and the also-off filter use the comparison partner

Outside Upgrade mode too: the stored partner, asked for once. A
checkpoint partner is read as a snapshot, opened only for the read.

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 5: Gated real-PostgreSQL test of a checkpoint partner

**Files:**
- Create: `src/test/checkpointReads.integration.test.ts`. Gate it with `ODT_PG_TEST=1`, in the style of `src/test/checkpoints.integration.test.ts`. Its teardown drops only this run's prefix, with LIKE's `_` and `%` escaped, through `sqlText`.

It must:
1. Create `odt_cpr_<run>`, with a table holding one row and a fake `ir_ui_view`-like table `t(v text)` containing `'arch'`.
2. Make a protected checkpoint with `copyDatabase(realCopyBackend(), db, cp, { protect: { comment: checkpointComment(db) } })`.
3. Assert that `runSql(cp, 'SELECT 1')` rejects while the checkpoint is protected.
4. Run two overlapping `withCheckpointOpen(cp, …)` reads through `runSql(cp, 'SELECT v FROM t')`, with one delayed by a 300 ms sleep inside. Both return `'arch'`.
5. Afterwards `datallowconn` is false.
6. A read that throws (a bad SQL inside) still leaves `datallowconn` false.
7. Set `datallowconn` true by hand with `ALTER`, record the checkpoint in a temporary store, and check that `closeOpenCheckpoints()` closes it. If faking the store is not practical, call `realCheckpointOpener.close` and assert the flag instead, and say so in the report.

- [ ] **Step 1:** Write the test.
- [ ] **Step 2:** Run it for real, outside the sandbox: `npm run compile-tests && ODT_PG_TEST=1 env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Checkpoint partner reads on a real PostgreSQL"`. Expect everything to pass, and no `odt_cpr_*` databases left.
- [ ] **Step 3:** Commit with the message `[ADD] Test reading a checkpoint partner on a real PostgreSQL`.

---

### Task 6: Docs, the full suite, and the build

**Files:** `README.md`, `CHANGELOG.md`, any walkthrough file under `media/walkthrough/` that names Compare with Original or Render side by side, and `dist/`.

- [ ] **Step 1: README.**
  - Add a section **"### Comparing two databases"** before `### Disabled views (View Doctor)`:

```markdown
### Comparing two databases

Every database can have a **comparison partner**: another database of the project, or one of its own checkpoints. The first compare asks for it and remembers it; **Set Comparison Partner…** and **Clear Comparison Partner** on a database's right-click menu change it, and the database's tooltip names it. In Upgrade mode the partner is always the other side of the upgrade, so it is set for you.

- **Compare with Partner** (the View Doctor) opens the same view in both databases in the diff editor: the partner on the left — the upgrade's original, or the checkpoint — and your database on the right, where saving fixes it. A checkpoint's side is a read-only snapshot.
- **Render** shows the view in both databases side by side when the partner is a database. A side with no server offers **Run Both**, which runs what is not running alongside.
- **"Other inactive views" leaves out the views the partner has off too** when the partner is a copy of the database: a checkpoint, a clone made from it, or the upgrade's original.
- **Run Partner Alongside** runs the partner next to your database. A checkpoint cannot be run: restore it, or clone it.
```

  - In `### Disabled views (View Doctor)`, change the **Compare with Original** paragraph to describe **Compare with Partner** in one sentence, pointing to the new section. Also change the "In Upgrade mode, Other inactive views …" paragraph and the Render paragraph's "In Upgrade mode both databases show side by side" so they say it works for any database partner, with a pointer to the section. Keep the details that are still true: read-only original, the proxy, PDF, Debug.
  - Check `### Upgrade mode` for a sentence that lists these features. If there is one, add "(see Comparing two databases)".

- [ ] **Step 2: CHANGELOG** `[Unreleased]` → `### Added`:

```markdown
- **A comparison partner for every database.** Compare with Partner, Render side by side and the "also off" filter now work outside Upgrade mode: a database compares with its partner — another database, or one of its checkpoints — picked once and remembered. Set or clear it from the database's right-click menu; Run Partner Alongside runs it. Upgrade mode still pairs the two sides for you. A checkpoint is read as a snapshot and is never left open to connections.
```

- [ ] **Step 3: The walkthrough.** Run `grep -rn "Compare with Original\|side by side" media/walkthrough/`. Update any mention so that it matches.

- [ ] **Step 4: Verify.** Run the full suite and all three gated suites, outside the sandbox:
  - `--grep "Checkpoint partner reads on a real PostgreSQL"` with `ODT_PG_TEST=1`;
  - "Checkpoints on a real PostgreSQL";
  - "Alongside on a real Odoo", with its env vars.

  Then run `npm run compile`.

- [ ] **Step 5: Commit** README, CHANGELOG, the walkthrough files and dist, with the message `[DOC] Describe comparing two databases; rebuild`.

## After the tasks (controller)

1. Run the final whole-branch review on the most capable model.
2. Run the live window check under Xvfb. Use a **real Odoo 17** version (`/home/odoo/odoo-dev/odoo-17.0`, venv python `/home/odoo/odoo-dev/venv-17.0/bin/python`) and two databases with base installed (`odoo-bin -i base --stop-after-init`), plus a checkpoint of one of them:
   - a. Set Comparison Partner on A, choosing B. The tooltip names B.
   - b. In the View Doctor, Compare with Partner opens B left and A right, with no prompt.
   - c. Render with both stopped offers Run Both. It runs both alongside, and two frames show.
   - d. Set the partner to the checkpoint. Compare opens a read-only snapshot on the left. Afterwards `datallowconn` is false, and the "also off" filter appears and hides views the checkpoint has off too.
   - e. Clear Comparison Partner, then Compare asks.
   - f. In upgrade mode (if cheap to set up; otherwise rely on the unit tests) the pair still wins.
3. Drop every database you made.
