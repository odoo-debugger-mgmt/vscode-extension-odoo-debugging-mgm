# View Doctor Stage 3 (Upgrade Script) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the views fixed in the View Doctor into an `upgrade-util` script, written into a module's `migrations/<version>/` folder or an untitled editor (the user's request 4).

**Architecture:** A per-database note (`viewNotes.ts`, a JSON file under `globalStorageUri/view-notes/`) records which upgrade-disabled views were still off when first listed, with an arch hash, plus a journal of every save and Turn On made through the extension. A pure generator (`upgradeScript.ts`, ported from odoo-manager's `upgrade_script.py`) renders `ACTIVATE` / `VIEWS` lists and an `edit_view` loop, and can parse its own output back so later additions merge into the same file. `scriptBuilder.ts` decides which views go in and whether each needs its arch (odoo-manager's `unchanged_reason`); `migrationsFolder.ts` writes the file and handles manifest versions; `scriptDestination.ts` and `upgradeScriptFlow.ts` are the VS Code side (picker, InputBox, toasts).

**Tech Stack:** TypeScript, VS Code extension API, mocha (`suite`/`test`, run inside the Extension Host), psql through `runSql`, `odoo-bin shell` through the existing `ViewWorkerPool`, python3 (tests only, to check the generated Python).

**Spec:** `docs/superpowers/specs/2026-10-02-view-doctor-design.md` — §5 and the `viewNotes.ts` part of §1. Brief: `docs/superpowers/notes/2026-10-05-view-doctor-handover-stage-3.md`. Reference implementation: `/home/odoo/Dev/odoo-manager` (`odoo_manager/view_note.py`, `odoo_manager/upgrade_script.py`, `docker_manager.py:2764-2795`, `CLAUDE.md:135-203`, `tests/test_view_note.py`, `tests/test_view_note_flow.py`, `tests/test_upgrade_script.py`).

## Global Constraints

- Branch `v-1.5`. **Never merge it anywhere, never push, never offer to.**
- Commits: Odoo-style prefix `[ADD]` / `[IMP]` / `[FIX]` / `[REF]` / `[DOC]`, a body, and the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. **Never `git add -A`**; add the exact paths.
- `npx tsc -p . --noEmit` clean; `npm run lint` **0 errors** (117 warnings is the baseline; do not add warnings in new files).
- Tests run outside the Bash sandbox (`dangerouslyDisableSandbox: true`) with `env -u ELECTRON_RUN_AS_NODE`. Focused: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "<suite name>"`. The test run rebuilds `dist/`: run `git checkout -- dist` before committing unless the commit ships `dist/` (only Task 9 does).
- Every `util.edit_view` call passes `skip_if_not_noupdate=False, active=True`.
- **Every doubt keeps the arch.** A view's arch is left out (re-enable only) only when `unchangedReason` proves it was not edited.
- A view's external id is always the first `ir_model_data` row ordered by `(module, name)` — the same subquery everywhere.
- Projects from `SettingsStore` are plain JSON, not models: never call model methods on them; normalize anything read from `workspaceState` or disk.
- A missing, garbled or foreign note is an empty note, never an error. Nothing in the note ever fails the tree, a save, or Turn On.
- Never overwrite a script file the extension cannot parse back exactly.
- Copy: plain, short sentences, the voice of the existing CHANGELOG and README.
- Destructive actions are right-click only, behind a modal. (Nothing in this stage is destructive.)
- `IDE OWL000` diagnostics in TS files are false positives; trust `tsc`.

## Review Focus

1. **A note file written by the other build, half-written, or garbled** (the F5 sandbox and the installed build share `globalStorageUri`): it reads as an empty note and the tree still loads; writes are atomic (temp file + rename). Pinned in Task 1.
2. **A database dropped and recreated under the same name, or replaced by a different restore:** the old note must not leak in. The note is stamped with `database.uuid`; a mismatch reads as empty. Pinned in Task 4.
3. **An existing `end-update_views.py` the user changed** (code added to `migrate`, entries rewritten by hand, CRLF line endings): never overwritten; merged only when it parses back exactly, otherwise the next numbered sibling is used. Pinned in Tasks 3 and 6.
4. **Arches and names with backslashes, `"""`, `\r`, non-ASCII, or newlines in a Studio view name:** the script stays valid Python, the arch round-trips exactly, a name cannot inject code. Pinned in Task 3.
5. **Fingerprints that cannot be read** (an Odoo without `arch_updated`, a psql failure): the note is still taken without a baseline, and every view keeps its arch. Pinned in Tasks 4 and 5.

## Rulings made while planning

Each is `Ruling: decision — why — cost if wrong`. Executors add theirs to the end of this list.

1. Only the list-shaped script (`render_instance_script`) is ported; **Add to Upgrade Script writes a one-entry list file**, so later additions merge into it. `render_replace_script` is not ported — one shape means every file the extension writes is mergeable — a single-view script is a few lines longer than odoo-manager's.
2. **The script header is fixed text** (no counts, no database); each entry names its database (`— id 42 in shop-18`) — the header must survive merges from several runs — a reviewer reads the database per entry instead of once.
3. **A merge is allowed only when the file re-renders byte for byte from what was parsed** (entries kept verbatim, so comments edited inside an entry survive); anything else goes to `end-update_views_2.py`, `_3`…, merging into the first sibling that parses — never overwrite — a hand-edited `migrate` forces a sibling file.
4. **A view already in the file is replaced in place**; when it moves between `ACTIVATE` and `VIEWS` it leaves the other list — no duplicates — none.
5. **Notes are per database name, stamped with `database.uuid`**; a different uuid reads as empty. No hook on drop, no "replace" mode — this extension restores dumps under reused names all the time — a restore of the same dump keeps its old note (harmless: its views are off again, so they are left out as still off).
6. **Note file names percent-encode every byte outside `[A-Za-z0-9_-]`** — no `..`, no Windows-illegal characters — two names differing only in case share a file on a case-insensitive disk (the uuid stamp then keeps them apart, at the cost of one note being dropped).
7. **The journal records saves and Turn On made through the extension. Create Upgrade Script covers noted ∪ journaled views that are on now**; still-off ones are left out and counted — the user asked for "re-enabled or edited" — a still-off view the user wants must be fixed first.
8. **The journal never forces an arch in**; `unchangedReason` decides, as in odoo-manager. A save through the extension writes `arch`, which sets `arch_updated = True` — the port stays faithful — none found.
9. **"Edited here"** lists every journaled view (saved or turned on), expanded, between "Disabled by upgrade" and "Other inactive views" — cheap once the journal exists — one more group in the tree.
10. **Add to Upgrade Script shows only on active rows**, right-click group `4_script` — an off view would be scripted as on while broken — a user wanting it must turn it on first.
11. **Reported views re-enabled before the note existed are not noted** (odoo-manager's rule), but the summary counts them and points to Add to Upgrade Script — counting them would script work nobody can prove — the user adds those one by one.
12. **Arches are read one by one through the existing `get_arch`**; a shell error aborts the command with its reason; an empty arch is reported as "no arch" — no new worker command — a slower script for many views (one socket round trip each).
13. **`classify`/`status`, the "replace" note mode and legacy `taken_at` strings are not ported** — no UI uses them; uuid replaces "replace" — none.
14. **Picker order:** last used, then modules owning the views (by external id, custom repos only), then the other modules by name, then Untitled Python Editor. Modules are the project repos' discovered modules minus anything under the version's `odooPath`/`enterprisePath` — never offer core or enterprise — none.
15. **Version folder prefill:** the remembered version for that module when its folder still exists; otherwise the manifest version bumped one patch; `1.1` when the manifest has none (Odoo's default `1.0`); empty when it is not numeric. Input must match `^\d+(\.\d+){1,5}$` — repeated Adds land in the same file — a user who wants a new folder edits the prefill.
16. **The manifest bump is offered** (toast button **Set Version**) only when the folder is above the manifest version (compared Odoo-style, series-prefixed when fewer than two dots); the manifest is re-read just before writing; a missing `version` key is inserted after `{` — Odoo runs `migrations/<v>/` only up to the manifest version — none.
17. **CRLF is read as LF when parsing a script; arches are written with LF** — XML parsers normalize line ends anyway — none.
18. **No new setting:** nothing here runs on its own beyond bookkeeping; the bump is an offer — none.
19. **The real end-to-end check is a gated integration test** (Task 8) using manifest versions `1.0.0` → `1.0.1`, which need no series prefix — repeatable on 17/18/19 — it needs the `ODT_VIEW_TEST_*` databases rebuilt.
20. **Fingerprint `written` is epoch milliseconds**, like `ViewRow.writeDate`, and `notedAt`/`takenAt` are `Date.now()` — one unit everywhere — none.

---

### Task 1: The note (`viewNotes.ts`) — pure logic and the file store

**Files:**
- Create: `src/services/views/viewNotes.ts`
- Test: `src/test/viewNotes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const NOT_SHIPPED_MODULES: readonly string[];
  export interface NotedView { id: number; name: string; model: string; type: string; xmlid: string | null; listedIn: string[]; notedAt?: number; archMd5?: string | null; }
  export interface JournalEntry { id: number; saved: boolean; activated: boolean; at: number; }
  export interface ViewNote { dbUuid?: string; takenAt?: number; updatedAt?: number; views: NotedView[]; journal: JournalEntry[]; }
  export interface NoteRow { active: boolean; name: string; model: string; type: string; xmlid: string | null; archMd5?: string; }
  export interface Fingerprint { archMd5: string | null; written: number | null; archUpdated: boolean | null; module: string | null; noupdate: boolean | null; }
  export type UnchangedReason = 'noted' | 'not-edited';
  export interface BuildSummary { listed: number; added: number; extended: number; alreadyEnabled: number; missing: number; noted: number; }
  export function emptyNote(): ViewNote;
  export function normalizeNote(raw: unknown): ViewNote;
  export function buildNote(existing: ViewNote, listed: Map<number, string[]>, rows: Map<number, NoteRow>, now: number): { note: ViewNote; summary: BuildSummary };
  export function baseline(note: ViewNote, fingerprints: Map<number, Fingerprint> | undefined): { note: ViewNote; baselined: number; tried: number };
  export function isShipped(fp: Fingerprint): boolean;
  export function unchangedReason(entry: { archMd5?: string | null } | undefined, fp: Fingerprint | undefined): UnchangedReason | null;
  export function recordJournal(note: ViewNote, viewId: number, kinds: Array<'saved' | 'activated'>, now: number): ViewNote;
  export function noteFileName(dbName: string): string;
  export class ViewNoteStore { constructor(dir: string); load(dbName: string): Promise<ViewNote>; save(dbName: string, note: ViewNote): Promise<void>; update(dbName: string, change: (note: ViewNote) => Promise<{ note: ViewNote; write: boolean }>): Promise<ViewNote>; }
  ```

- [ ] **Step 1: Write the failing tests** (ported from odoo-manager `tests/test_view_note.py`; read it alongside)

```ts
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    baseline, buildNote, emptyNote, normalizeNote, noteFileName, recordJournal, unchangedReason, ViewNoteStore,
    type Fingerprint, type NoteRow, type ViewNote
} from '../services/views/viewNotes';

function row(active: boolean, overrides: Partial<NoteRow> = {}): NoteRow {
    return { active, name: 'Partner form', model: 'res.partner', type: 'form', xmlid: 'acme.view_partner', ...overrides };
}

function fp(overrides: Partial<Fingerprint> = {}): Fingerprint {
    return { archMd5: 'aaa', written: 1000, archUpdated: false, module: 'acme', noupdate: false, ...overrides };
}

suite('View note', () => {
    test('notes only reported views that are still disabled', () => {
        const listed = new Map([[1, ['17.0']], [2, ['17.0']], [3, ['17.0']]]);
        const rows = new Map([[1, row(false)], [2, row(true)]]);
        const { note, summary } = buildNote(emptyNote(), listed, rows, 5000);
        assert.deepStrictEqual(note.views.map(view => view.id), [1]);
        assert.deepStrictEqual(summary, { listed: 3, added: 1, extended: 0, alreadyEnabled: 1, missing: 1, noted: 1 });
    });

    test('records which upgrade steps listed a view, and when', () => {
        const { note } = buildNote(emptyNote(), new Map([[1, ['17.0', '18.0']]]), new Map([[1, row(false)]]), 5000);
        assert.deepStrictEqual(note.views[0], {
            id: 1, name: 'Partner form', model: 'res.partner', type: 'form', xmlid: 'acme.view_partner',
            listedIn: ['17.0', '18.0'], notedAt: 5000
        });
        assert.strictEqual(note.takenAt, 5000);
    });

    test('re-reading never forgets a view that was fixed since, and adds only the genuinely new', () => {
        const first = buildNote(emptyNote(), new Map([[1, ['17.0']]]), new Map([[1, row(false)]]), 5000).note;
        const rows = new Map([[1, row(true)], [2, row(false)]]);
        const { note, summary } = buildNote(first, new Map([[1, ['17.0', '18.0']], [2, ['18.0']]]), rows, 9000);
        assert.deepStrictEqual(note.views.map(view => [view.id, view.listedIn, view.notedAt]), [[1, ['17.0', '18.0'], 5000], [2, ['18.0'], 9000]]);
        assert.strictEqual(summary.added, 1);
        assert.strictEqual(summary.extended, 1);
        assert.strictEqual(note.takenAt, 5000);
    });

    test('re-reading does not mutate the earlier note', () => {
        const first = buildNote(emptyNote(), new Map([[1, ['17.0']]]), new Map([[1, row(false)]]), 5000).note;
        const copy = JSON.parse(JSON.stringify(first));
        buildNote(first, new Map([[1, ['18.0']], [2, ['18.0']]]), new Map([[2, row(false)]]), 9000);
        assert.deepStrictEqual(first, copy);
    });

    test('no reports note nothing', () => {
        const { note, summary } = buildNote(emptyNote(), new Map(), new Map(), 5000);
        assert.deepStrictEqual(note.views, []);
        assert.strictEqual(summary.noted, 0);
    });

    test('a view noted with a fingerprint keeps its baseline; one noted without leaves the key out', () => {
        const rows = new Map([[1, row(false, { archMd5: 'abc' })], [2, row(false)]]);
        const { note } = buildNote(emptyNote(), new Map([[1, ['17.0']], [2, ['17.0']]]), rows, 5000);
        assert.strictEqual(note.views[0].archMd5, 'abc');
        assert.ok(!('archMd5' in note.views[1]));
    });

    test('merging never touches an existing baseline', () => {
        const first = buildNote(emptyNote(), new Map([[1, ['17.0']]]), new Map([[1, row(false, { archMd5: 'old' })]]), 5000).note;
        const { note } = buildNote(first, new Map([[1, ['17.0']]]), new Map([[1, row(false, { archMd5: 'new' })]]), 9000);
        assert.strictEqual(note.views[0].archMd5, 'old');
    });

    test('baseline records the hash of a view untouched since it was noted', () => {
        const note: ViewNote = { ...emptyNote(), views: [{ id: 1, name: '', model: '', type: '', xmlid: null, listedIn: [], notedAt: 5000 }] };
        const result = baseline(note, new Map([[1, fp({ archMd5: 'abc', written: 4000 })]]));
        assert.strictEqual(result.note.views[0].archMd5, 'abc');
        assert.deepStrictEqual([result.baselined, result.tried], [1, 1]);
    });

    test('baseline cannot prove a view written since, marks it tried, and stops asking', () => {
        const note: ViewNote = { ...emptyNote(), views: [{ id: 1, name: '', model: '', type: '', xmlid: null, listedIn: [], notedAt: 5000 }] };
        const once = baseline(note, new Map([[1, fp({ written: 6000 })]]));
        assert.strictEqual(once.note.views[0].archMd5, null);
        assert.deepStrictEqual([once.baselined, once.tried], [0, 1]);
        const twice = baseline(once.note, new Map([[1, fp({ written: 1 })]]));
        assert.strictEqual(twice.note.views[0].archMd5, null);
        assert.strictEqual(twice.tried, 0);
    });

    test('baseline falls back to the note\'s takenAt for a view with no noted time', () => {
        const note: ViewNote = { ...emptyNote(), takenAt: 5000, views: [{ id: 1, name: '', model: '', type: '', xmlid: null, listedIn: [] }] };
        assert.strictEqual(baseline(note, new Map([[1, fp({ archMd5: 'abc', written: 4000 })]])).note.views[0].archMd5, 'abc');
    });

    test('baseline with nothing readable touches nothing, and leaves a missing view alone', () => {
        const note: ViewNote = { ...emptyNote(), views: [{ id: 1, name: '', model: '', type: '', xmlid: null, listedIn: [], notedAt: 5000 }] };
        assert.strictEqual(baseline(note, undefined).note, note);
        const result = baseline(note, new Map());
        assert.ok(!('archMd5' in result.note.views[0]));
        assert.strictEqual(result.tried, 0);
    });

    test('baseline does not modify the note it was given', () => {
        const note: ViewNote = { ...emptyNote(), views: [{ id: 1, name: '', model: '', type: '', xmlid: null, listedIn: [], notedAt: 5000 }] };
        baseline(note, new Map([[1, fp({ written: 4000 })]]));
        assert.ok(!('archMd5' in note.views[0]));
    });

    test('unchanged reason: identical to the baseline is unchanged, differing is changed', () => {
        assert.strictEqual(unchangedReason({ archMd5: 'aaa' }, fp({ archMd5: 'aaa', archUpdated: true })), 'noted');
        assert.strictEqual(unchangedReason({ archMd5: 'aaa' }, fp({ archMd5: 'bbb', archUpdated: true })), null);
    });

    test('unchanged reason: a module view rewritten by a module update is still just re-enabled', () => {
        assert.strictEqual(unchangedReason({ archMd5: 'aaa' }, fp({ archMd5: 'bbb', archUpdated: false })), 'not-edited');
    });

    test('unchanged reason: a module view someone did edit is changed', () => {
        assert.strictEqual(unchangedReason({ archMd5: 'aaa' }, fp({ archMd5: 'bbb', archUpdated: true })), null);
    });

    test('unchanged reason: views no module ships never get the module benefit', () => {
        for (const module of ['studio_customization', '__export__', '__import__']) {
            assert.strictEqual(unchangedReason({ archMd5: 'aaa' }, fp({ archMd5: 'bbb', module })), null);
        }
        assert.strictEqual(unchangedReason({ archMd5: 'aaa' }, fp({ archMd5: 'bbb', noupdate: true })), null);
        assert.strictEqual(unchangedReason({ archMd5: 'aaa' }, fp({ archMd5: 'bbb', module: null, noupdate: null })), null);
    });

    test('unchanged reason without a baseline: Odoo\'s flag decides, and a null flag counts as never edited', () => {
        assert.strictEqual(unchangedReason({}, fp({ archUpdated: false })), 'not-edited');
        assert.strictEqual(unchangedReason(undefined, fp({ archUpdated: null })), 'not-edited');
        assert.strictEqual(unchangedReason({ archMd5: null }, fp({ archUpdated: true })), null);
        assert.strictEqual(unchangedReason({}, fp({ archUpdated: true })), null);
    });

    test('no fingerprint proves nothing', () => {
        assert.strictEqual(unchangedReason({ archMd5: 'aaa' }, undefined), null);
    });

    test('the journal keeps one entry per view and only ever adds flags', () => {
        let note = recordJournal(emptyNote(), 7, ['activated'], 100);
        note = recordJournal(note, 7, ['saved'], 200);
        note = recordJournal(note, 8, ['saved', 'activated'], 300);
        assert.deepStrictEqual(note.journal, [
            { id: 7, saved: true, activated: true, at: 200 },
            { id: 8, saved: true, activated: true, at: 300 }
        ]);
    });

    test('normalizing keeps a good note and repairs or drops anything else', () => {
        const good: ViewNote = {
            dbUuid: 'u', takenAt: 1, updatedAt: 2,
            views: [{ id: 1, name: 'n', model: 'm', type: 'form', xmlid: null, listedIn: ['17.0'], notedAt: 1, archMd5: null }],
            journal: [{ id: 1, saved: true, activated: false, at: 3 }]
        };
        assert.deepStrictEqual(normalizeNote(JSON.parse(JSON.stringify(good))), good);
        for (const garbage of [null, 3, 'x', [], { views: 'no' }]) {
            assert.deepStrictEqual(normalizeNote(garbage), emptyNote());
        }
        const repaired = normalizeNote({ views: [{ id: '2' }, { id: -1 }, { id: 4, listedIn: [5, '18.0'], archMd5: 7 }], journal: [{ id: 4 }, 'x'] });
        assert.deepStrictEqual(repaired.views.map(view => [view.id, view.listedIn, 'archMd5' in view]), [[4, ['18.0'], false]]);
        assert.deepStrictEqual(repaired.journal, [{ id: 4, saved: false, activated: false, at: 0 }]);
    });

    test('a database name cannot escape the notes folder', () => {
        assert.strictEqual(noteFileName('shop-18_x'), 'shop-18_x.json');
        assert.strictEqual(noteFileName('../etc'), '%2E%2E%2Fetc.json');
        assert.strictEqual(noteFileName('a b*é'), 'a%20b%2A%C3%A9.json');
        assert.throws(() => noteFileName(''));
    });
});

suite('View note store', () => {
    let dir: string;
    setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-notes-')); });
    teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('save and load round-trip, and a missing file is an empty note', async () => {
        const store = new ViewNoteStore(path.join(dir, 'view-notes'));
        assert.deepStrictEqual(await store.load('shop'), emptyNote());
        const note = recordJournal(emptyNote(), 3, ['saved'], 10);
        await store.save('shop', note);
        assert.deepStrictEqual(await store.load('shop'), note);
        assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'view-notes')), ['shop.json']);
    });

    test('a corrupt or half-written file is an empty note', async () => {
        const store = new ViewNoteStore(dir);
        fs.writeFileSync(path.join(dir, 'shop.json'), '{"views": [');
        assert.deepStrictEqual(await store.load('shop'), emptyNote());
    });

    test('updates to one database run one after another, and write only when asked', async () => {
        const store = new ViewNoteStore(dir);
        await Promise.all([1, 2, 3].map(id => store.update('shop', async note => {
            await new Promise(resolve => setTimeout(resolve, 5));
            return { note: recordJournal(note, id, ['saved'], id), write: true };
        })));
        assert.deepStrictEqual((await store.load('shop')).journal.map(entry => entry.id), [1, 2, 3]);
        const result = await store.update('other', async note => ({ note: recordJournal(note, 9, ['saved'], 1), write: false }));
        assert.deepStrictEqual(result.journal.map(entry => entry.id), [9]);
        assert.ok(!fs.existsSync(path.join(dir, 'other.json')));
    });

    test('a failed update does not block the next one', async () => {
        const store = new ViewNoteStore(dir);
        await assert.rejects(store.update('shop', async () => { throw new Error('boom'); }));
        const note = await store.update('shop', async current => ({ note: recordJournal(current, 1, ['saved'], 1), write: true }));
        assert.strictEqual(note.journal.length, 1);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run compile-tests` — Expected: compile errors, `viewNotes` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * The View Doctor's note of a database's disabled views, and the journal of
 * what the extension changed. Port of odoo-manager's view_note.py.
 *
 * The note is a baseline: the views upgrade-util's report in Discuss says the
 * upgrade disabled *and that are still disabled when first listed*. Only what
 * the report lists (a real upgraded database has hundreds of views off by
 * design), and only what is still off (a listed view already on was fixed
 * before anyone looked, and scripting it would claim work nobody did here).
 *
 * Each noted view keeps a hash of its arch as it was when noted, so the script
 * can tell a view that was only re-enabled from one that was edited and leave
 * the arch out for the first kind (unchangedReason). write_date cannot be that
 * signal: turning a view on is an ORM write too.
 *
 * The journal is every view this extension saved or turned on, so a fix made
 * on a view no report lists still reaches the script.
 *
 * One JSON file per database name, machine-local. Both the installed build
 * and the F5 sandbox read it (globalStorageUri is not profile-isolated), and
 * they see the same PostgreSQL, so sharing it is right; writes are atomic and
 * reads tolerate anything.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** External id modules no file ships: Studio's, and what data export/import creates. */
export const NOT_SHIPPED_MODULES: readonly string[] = ['studio_customization', '__export__', '__import__'];

export interface NotedView {
    id: number;
    name: string;
    model: string;
    type: string;
    xmlid: string | null;
    /** The Odoo versions whose upgrade report listed it, in report order. */
    listedIn: string[];
    /** When it was noted, epoch ms. */
    notedAt?: number;
    /** The arch's md5 when noted. Absent: not tried yet. null: tried, cannot be proven. */
    archMd5?: string | null;
}

export interface JournalEntry {
    id: number;
    saved: boolean;
    activated: boolean;
    /** The last change, epoch ms. */
    at: number;
}

export interface ViewNote {
    /** The database's database.uuid when written: a database recreated under the same name has another. */
    dbUuid?: string;
    takenAt?: number;
    updatedAt?: number;
    views: NotedView[];
    journal: JournalEntry[];
}

/** What noting a view needs from its live row. */
export interface NoteRow {
    active: boolean;
    name: string;
    model: string;
    type: string;
    xmlid: string | null;
    archMd5?: string;
}

/** What tells whether a view's arch was edited; see getViewFingerprints. */
export interface Fingerprint {
    archMd5: string | null;
    /** write_date, epoch ms. */
    written: number | null;
    archUpdated: boolean | null;
    /** Module and noupdate of the view's first external id. */
    module: string | null;
    noupdate: boolean | null;
}

export type UnchangedReason = 'noted' | 'not-edited';

export interface BuildSummary {
    listed: number;
    added: number;
    /** Noted views another report now lists too. */
    extended: number;
    alreadyEnabled: number;
    missing: number;
    noted: number;
}

export function emptyNote(): ViewNote {
    return { views: [], journal: [] };
}

function isId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function finite(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The note as read from disk: anything that is not a note becomes an empty one, field by field. */
export function normalizeNote(raw: unknown): ViewNote {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return emptyNote();
    }
    const source = raw as Record<string, unknown>;
    const note = emptyNote();
    if (typeof source.dbUuid === 'string') {
        note.dbUuid = source.dbUuid;
    }
    const takenAt = finite(source.takenAt);
    if (takenAt !== undefined) {
        note.takenAt = takenAt;
    }
    const updatedAt = finite(source.updatedAt);
    if (updatedAt !== undefined) {
        note.updatedAt = updatedAt;
    }
    for (const entry of Array.isArray(source.views) ? source.views : []) {
        const view = (entry ?? {}) as Record<string, unknown>;
        if (!isId(view.id)) {
            continue;
        }
        const noted: NotedView = {
            id: view.id,
            name: typeof view.name === 'string' ? view.name : '',
            model: typeof view.model === 'string' ? view.model : '',
            type: typeof view.type === 'string' ? view.type : '',
            xmlid: typeof view.xmlid === 'string' ? view.xmlid : null,
            listedIn: Array.isArray(view.listedIn) ? view.listedIn.filter((v): v is string => typeof v === 'string') : []
        };
        const notedAt = finite(view.notedAt);
        if (notedAt !== undefined) {
            noted.notedAt = notedAt;
        }
        if (typeof view.archMd5 === 'string' || view.archMd5 === null) {
            noted.archMd5 = view.archMd5;
        }
        note.views.push(noted);
    }
    for (const entry of Array.isArray(source.journal) ? source.journal : []) {
        const change = (entry ?? {}) as Record<string, unknown>;
        if (isId(change.id)) {
            note.journal.push({ id: change.id, saved: change.saved === true, activated: change.activated === true, at: finite(change.at) ?? 0 });
        }
    }
    return note;
}

/**
 * The note after reading the report again: `listed` maps each listed view id
 * to the versions whose report listed it, `rows` the live rows (an id with no
 * view is absent). Merged into `existing`: a noted view that has been fixed
 * since no longer shows as disabled, and must not be forgotten. A view already
 * noted is never dropped or re-counted. `existing` is not modified.
 */
export function buildNote(existing: ViewNote, listed: Map<number, string[]>, rows: Map<number, NoteRow>, now: number): { note: ViewNote; summary: BuildSummary } {
    const views = new Map(existing.views.map(view => [view.id, { ...view, listedIn: [...view.listedIn] }]));
    let added = 0;
    let extended = 0;
    let alreadyEnabled = 0;
    let missing = 0;
    for (const [id, versions] of listed) {
        const known = views.get(id);
        if (known) {
            const more = versions.filter(version => !known.listedIn.includes(version));
            if (more.length > 0) {
                known.listedIn.push(...more);
                extended++;
            }
            continue;
        }
        const row = rows.get(id);
        if (!row) {
            missing++;
        } else if (row.active) {
            alreadyEnabled++;
        } else {
            const view: NotedView = { id, name: row.name, model: row.model, type: row.type, xmlid: row.xmlid, listedIn: [...versions], notedAt: now };
            // Left out, not null, when it could not be read: baseline() may still supply it.
            if (row.archMd5 !== undefined) {
                view.archMd5 = row.archMd5;
            }
            views.set(id, view);
            added++;
        }
    }
    return {
        note: { ...existing, takenAt: existing.takenAt ?? now, views: [...views.values()], journal: [...existing.journal] },
        summary: { listed: listed.size, added, extended, alreadyEnabled, missing, noted: views.size }
    };
}

/**
 * Gives every noted view without a baseline one, where its current arch is
 * provably the one it had when noted: its row has not been written since
 * (any ORM write, an edit or turning it on, moves write_date). One written
 * since cannot be proven later, so it is marked tried (null) and not asked
 * about again; unchangedReason then falls back to Odoo's arch_updated flag.
 * `fingerprints` undefined (unreadable) touches nothing; a view with no
 * fingerprint (deleted) is left alone. `note` is not modified.
 */
export function baseline(note: ViewNote, fingerprints: Map<number, Fingerprint> | undefined): { note: ViewNote; baselined: number; tried: number } {
    if (!fingerprints) {
        return { note, baselined: 0, tried: 0 };
    }
    let baselined = 0;
    let tried = 0;
    const views = note.views.map(view => {
        const fp = fingerprints.get(view.id);
        if (view.archMd5 !== undefined || !fp) {
            return view;
        }
        tried++;
        const noted = view.notedAt ?? note.takenAt;
        if (noted !== undefined && fp.written !== null && fp.written < noted) {
            baselined++;
            return { ...view, archMd5: fp.archMd5 };
        }
        return { ...view, archMd5: null };
    });
    return { note: { ...note, views }, baselined, tried };
}

/** Whether the view's arch comes from its module's files, which every upgrade loads again. */
export function isShipped(fp: Fingerprint): boolean {
    return fp.noupdate === false && !!fp.module && !NOT_SHIPPED_MODULES.includes(fp.module);
}

/**
 * Why a re-enabled view's arch need not be written into the script, or null
 * when it must. Leaving an arch out is the risky direction (a wrong
 * "unchanged" drops a fix without a word), so it takes proof:
 * - 'noted': the arch hashes exactly as when the view was noted;
 * - 'not-edited': nobody edited the arch through the ORM. arch_updated flips
 *   when the arch is written, not when `active` is, and a module resets it
 *   when it loads the view; null counts as never edited. Used without a
 *   baseline, or when a shipped view differs from its baseline but was not
 *   edited (a module update rewrote it, and the upgrade loads it again).
 * Every doubt keeps the arch.
 */
export function unchangedReason(entry: { archMd5?: string | null } | undefined, fp: Fingerprint | undefined): UnchangedReason | null {
    if (!fp) {
        return null;
    }
    const edited = fp.archUpdated === true;
    const noted = entry?.archMd5;
    if (noted) {
        if (noted === fp.archMd5) {
            return 'noted';
        }
        return isShipped(fp) && !edited ? 'not-edited' : null;
    }
    return edited ? null : 'not-edited';
}

/** The note with this view's save or Turn On recorded. `note` is not modified. */
export function recordJournal(note: ViewNote, viewId: number, kinds: Array<'saved' | 'activated'>, now: number): ViewNote {
    const journal = note.journal.map(entry => ({ ...entry }));
    let entry = journal.find(change => change.id === viewId);
    if (!entry) {
        entry = { id: viewId, saved: false, activated: false, at: now };
        journal.push(entry);
    }
    entry.saved ||= kinds.includes('saved');
    entry.activated ||= kinds.includes('activated');
    entry.at = now;
    return { ...note, journal };
}

/** The note's file name: every byte outside [A-Za-z0-9_-] percent-encoded, so no name reaches outside the folder. */
export function noteFileName(dbName: string): string {
    if (!dbName) {
        throw new Error('No database name.');
    }
    let name = '';
    for (const byte of Buffer.from(dbName, 'utf-8')) {
        const char = String.fromCharCode(byte);
        name += /[A-Za-z0-9_-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    return `${name}.json`;
}

export class ViewNoteStore {
    private readonly queue = new Map<string, Promise<unknown>>();

    constructor(private readonly dir: string) {}

    /** The database's note; empty when there is none or it cannot be read. */
    async load(dbName: string): Promise<ViewNote> {
        try {
            return normalizeNote(JSON.parse(await fs.readFile(path.join(this.dir, noteFileName(dbName)), 'utf-8')));
        } catch {
            return emptyNote();
        }
    }

    /** Written beside the target and renamed into place: a reader never sees half a note. */
    async save(dbName: string, note: ViewNote): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });
        const file = path.join(this.dir, noteFileName(dbName));
        const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
        try {
            await fs.writeFile(temp, JSON.stringify(note, null, 2));
            await fs.rename(temp, file);
        } catch (error) {
            await fs.rm(temp, { force: true });
            throw error;
        }
    }

    /** Read, change and maybe write one database's note, one change at a time. */
    update(dbName: string, change: (note: ViewNote) => Promise<{ note: ViewNote; write: boolean }>): Promise<ViewNote> {
        const previous = this.queue.get(dbName) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(async () => {
            const result = await change(await this.load(dbName));
            if (result.write) {
                await this.save(dbName, result.note);
            }
            return result.note;
        });
        this.queue.set(dbName, next);
        return next;
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (outside the sandbox): `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View note"` — Expected: both suites pass.

- [ ] **Step 5: Type check, lint, commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist
git add src/services/views/viewNotes.ts src/test/viewNotes.test.ts
git commit -m "[ADD] View Doctor note: what the upgrade disabled, and what was changed here

Port of odoo-manager's view_note.py: the views upgrade-util's report lists
and that are still off when first listed, each with an arch hash baseline,
plus a journal of the views this extension saved or turned on.
unchangedReason decides when an arch can be left out of a script; every
doubt keeps it. One JSON file per database, written atomically, and any
file that is not a note reads as an empty one.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Fingerprint and uuid queries

**Files:**
- Modify: `src/services/views/viewQueries.ts`
- Test: `src/test/viewQueries.test.ts` (add a suite)

**Interfaces:**
- Consumes: `Fingerprint` from Task 1.
- Produces:
  ```ts
  export function firstXmlidSql(column: string): string; // column over ir_model_data aliased d, for view v
  export function fingerprintsSql(ids: number[]): string;
  export function parseFingerprints(output: string): Map<number, Fingerprint>;
  export async function getViewFingerprints(dbName: string, ids: number[]): Promise<Map<number, Fingerprint>>;
  export async function getDatabaseUuid(dbName: string): Promise<string | undefined>;
  ```

- [ ] **Step 1: Write the failing tests** (append to `src/test/viewQueries.test.ts`; keep its existing imports and add the new names)

```ts
suite('View fingerprints', () => {
    test('hash the raw column, read arch_updated, and take module and noupdate from the external id Odoo shows', () => {
        const sql = fingerprintsSql([3, 1, 3]);
        assert.match(sql, /md5\(v\.arch_db::text\)/);
        assert.match(sql, /v\.arch_updated/);
        assert.match(sql, /extract\(epoch FROM v\.write_date\) \* 1000/);
        assert.match(sql, /WHERE v\.id IN \(1,3\)/);
        assert.ok(sql.includes(firstXmlidSql('d.module')));
        assert.ok(sql.includes(firstXmlidSql('d.noupdate')));
    });

    test('every external id lookup picks the one Odoo shows', () => {
        const lookup = firstXmlidSql("d.module || '.' || d.name");
        assert.match(lookup, /ORDER BY d\.module, d\.name LIMIT 1/);
        assert.ok(viewRowsSql('v.active = false').includes(lookup));
    });

    test('refuse anything that is not a view id', () => {
        assert.throws(() => fingerprintsSql([1, 0]));
        assert.throws(() => fingerprintsSql([Number.NaN]));
    });

    test('parse into typed fingerprints, keyed by id', () => {
        const parsed = parseFingerprints('{"7": {"arch_md5": "abc", "written": 1700000000000, "arch_updated": true, "module": "acme", "noupdate": false},'
            + ' "9": {"arch_md5": null, "written": null, "arch_updated": null, "module": null, "noupdate": null}}');
        assert.deepStrictEqual(parsed.get(7), { archMd5: 'abc', written: 1700000000000, archUpdated: true, module: 'acme', noupdate: false });
        assert.deepStrictEqual(parsed.get(9), { archMd5: null, written: null, archUpdated: null, module: null, noupdate: null });
        assert.strictEqual(parseFingerprints('').size, 0);
        assert.throws(() => parseFingerprints('[]'));
    });
});
```

Make sure `fingerprintsSql`, `firstXmlidSql`, `parseFingerprints` and `viewRowsSql` are imported at the top of the test file.

- [ ] **Step 2: Run to verify they fail**

Run: `npm run compile-tests` — Expected: compile errors for the missing exports.

- [ ] **Step 3: Implement** — in `viewQueries.ts`, add `import type { Fingerprint } from './viewNotes';`, then:

```ts
/**
 * A column of the view `v`'s first external id. ir.ui.view.xml_id is
 * computed, with no column: Odoo takes the first ir_model_data row in that
 * model's order (module, name). Every query that names or classifies a view
 * by its external id goes through this, so a view with several is the same
 * view everywhere.
 */
export function firstXmlidSql(column: string): string {
    return `(SELECT ${column} FROM ir_model_data d WHERE d.model = 'ir.ui.view' AND d.res_id = v.id ORDER BY d.module, d.name LIMIT 1)`;
}
```

In `viewRowsSql`, replace the inline `'xmlid', (SELECT d.module || '.' || d.name FROM ir_model_data d ... LIMIT 1),` with `'xmlid', ${firstXmlidSql("d.module || '.' || d.name")},` (keep the output identical otherwise).

```ts
/**
 * What tells whether views' arches were edited, for many at once (port of
 * odoo-manager's get_view_fingerprints). arch_md5 hashes the raw arch_db as
 * text, so one query covers the text column of 15 and the per-language jsonb
 * of 16+. written is write_date: any ORM write moves it, turning a view on
 * included, so it only ever proves a view untouched. arch_updated flips only
 * when the arch itself is written. module/noupdate tell a module's own view
 * from one that lives only in the database.
 */
export function fingerprintsSql(ids: number[]): string {
    const unique = [...new Set(ids)].sort((a, b) => a - b);
    return `SELECT coalesce(json_object_agg(v.id, json_build_object(
    'arch_md5', md5(v.arch_db::text),
    'written', floor(extract(epoch FROM v.write_date) * 1000),
    'arch_updated', v.arch_updated,
    'module', ${firstXmlidSql('d.module')},
    'noupdate', ${firstXmlidSql('d.noupdate')}
)), '{}'::json)
FROM ir_ui_view v WHERE v.id IN (${sqlIdList(unique)});`;
}

export function parseFingerprints(output: string): Map<number, Fingerprint> {
    const raw = parseJson(output, '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Unexpected output from the fingerprint query.');
    }
    return new Map(Object.entries(raw as Record<string, Record<string, unknown>>).map(([id, fp]) => [Number(id), {
        archMd5: typeof fp?.arch_md5 === 'string' ? fp.arch_md5 : null,
        written: typeof fp?.written === 'number' ? fp.written : null,
        archUpdated: typeof fp?.arch_updated === 'boolean' ? fp.arch_updated : null,
        module: typeof fp?.module === 'string' ? fp.module : null,
        noupdate: typeof fp?.noupdate === 'boolean' ? fp.noupdate : null
    }]));
}

/** Fingerprints of these views; an id with no view is absent. Throws when they cannot be read. */
export async function getViewFingerprints(dbName: string, ids: number[]): Promise<Map<number, Fingerprint>> {
    if (ids.length === 0) {
        return new Map();
    }
    return parseFingerprints(await runSql(dbName, fingerprintsSql(ids)));
}

/** The database's database.uuid, which a database recreated under the same name does not share. */
export async function getDatabaseUuid(dbName: string): Promise<string | undefined> {
    const raw = parseJson(await runSql(dbName,
        "SELECT coalesce(json_agg(value), '[]'::json) FROM ir_config_parameter WHERE key = 'database.uuid';"), '[]');
    return Array.isArray(raw) && typeof raw[0] === 'string' && raw[0] ? raw[0] : undefined;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View (fingerprints|queries)"` — Expected: pass, and the existing viewQueries tests still pass.

- [ ] **Step 5: Commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist
git add src/services/views/viewQueries.ts src/test/viewQueries.test.ts
git commit -m "[ADD] View fingerprints and the database uuid over psql

The fingerprint query ported from odoo-manager (docker_manager.py:2764):
the arch hash, write_date, arch_updated, and the module and noupdate of the
view's first external id. That external id lookup is now one helper, shared
with the tree's rows, so a view is named the same way everywhere.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The script generator (`upgradeScript.ts`) — render, parse, merge

**Files:**
- Create: `src/services/views/upgradeScript.ts`
- Create: `src/test/helpers/pythonScript.ts`
- Test: `src/test/upgradeScript.test.ts`

**Interfaces:**
- Consumes: `UnchangedReason` from Task 1.
- Produces:
  ```ts
  export interface ScriptView { id: number; xmlid: string | null; model: string; type: string; name: string; listedIn: string[]; dbName: string; arch: string | null; why: UnchangedReason | null; }
  export interface ScriptEntry { key: string; list: 'activate' | 'views'; text: string; }
  export interface ScriptFile { header: string; activate: ScriptEntry[]; views: ScriptEntry[]; }
  export const DEFAULT_HEADER: string;
  export function oneLine(text: string, limit?: number): string;
  export function pyTripleQuoted(text: string): string;
  export function entryKey(view: { id: number; xmlid: string | null }): string;
  export function scriptEntry(view: ScriptView): ScriptEntry; // arch null -> ACTIVATE, else VIEWS; throws on a blank arch
  export function newScriptFile(): ScriptFile;
  export function mergeEntries(file: ScriptFile, entries: ScriptEntry[]): ScriptFile;
  export function renderScript(file: ScriptFile): string; // throws when both lists are empty
  export function newScript(views: ScriptView[]): string;
  export function parseScript(source: string): ScriptFile | undefined;
  ```

- [ ] **Step 1: Write the Python test helper** (`src/test/helpers/pythonScript.ts`)

```ts
/**
 * Runs a generated upgrade script under python3 with stand-ins for
 * odoo.upgrade.util and lxml, and reports what it would do. Tests skip when
 * python3 is not installed.
 */
import { spawnSync } from 'node:child_process';

export interface ScriptRun {
    ACTIVATE: Array<string | number> | null;
    VIEWS: Array<Record<string, unknown>> | null;
    /** util.edit_view calls: [xmlid, view_id, kwargs, the arch it was given]. */
    edits: Array<[string | null, number | null, Record<string, unknown>, string | null]>;
    /** cr.execute calls: [sql, params]. */
    executed: Array<[string, unknown[]]>;
}

const HARNESS = String.raw`
import contextlib, json, sys, types
source = sys.stdin.read()
refs = json.loads(sys.argv[1])
missing = set(json.loads(sys.argv[2]))
edits, executed = [], []

class El:
    def __init__(self, text=None):
        self.tag, self.text, self.attrib, self.children = 'x', text, {}, []
    def __getitem__(self, key):
        return self.children[key]
    def __setitem__(self, key, value):
        self.children[key] = value

class Cr:
    def execute(self, sql, params=None):
        executed.append([sql, list(params or [])])

@contextlib.contextmanager
def edit_view(cr, xmlid=None, view_id=None, skip_if_not_noupdate=True, active='auto'):
    assert bool(xmlid) ^ bool(view_id), 'You Must specify either xmlid or view_id'
    if (xmlid or view_id) in missing:
        return
    el = El()
    yield el
    edits.append([xmlid, view_id, {'skip_if_not_noupdate': skip_if_not_noupdate, 'active': active}, el.text])

@contextlib.contextmanager
def skippable_cm():
    try:
        yield
    except RuntimeError as error:
        if "didn't yield" not in str(error):
            raise

util = types.ModuleType('odoo.upgrade.util')
util.edit_view, util.skippable_cm = edit_view, skippable_cm
util.ref = lambda cr, xmlid: refs.get(xmlid)
upgrade = types.ModuleType('odoo.upgrade'); upgrade.util = util
odoo = types.ModuleType('odoo'); odoo.upgrade = upgrade
etree = types.ModuleType('lxml.etree'); etree.fromstring = lambda text: El(text)
lxml = types.ModuleType('lxml'); lxml.etree = etree
sys.modules.update({'odoo': odoo, 'odoo.upgrade': upgrade, 'odoo.upgrade.util': util, 'lxml': lxml, 'lxml.etree': etree})
namespace = {}
exec(compile(source, 'end-update_views.py', 'exec'), namespace)
namespace['migrate'](Cr(), '1.0')
print(json.dumps({'ACTIVATE': namespace.get('ACTIVATE'), 'VIEWS': namespace.get('VIEWS'), 'edits': edits, 'executed': executed}))
`;

/** Whether python3 runs here. */
export function hasPython(): boolean {
    const result = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
    return !result.error && result.status === 0;
}

/**
 * Compiles and runs `source`. `refs` is what util.ref answers per external
 * id; `missing` lists external ids or view ids edit_view does not find.
 */
export function runScript(source: string, refs: Record<string, number> = {}, missing: Array<string | number> = []): ScriptRun {
    const result = spawnSync('python3', ['-c', HARNESS, JSON.stringify(refs), JSON.stringify(missing)], { input: source, encoding: 'utf-8' });
    if (result.status !== 0) {
        throw new Error(`python3 failed:\n${result.stderr}`);
    }
    return JSON.parse(result.stdout) as ScriptRun;
}
```

- [ ] **Step 2: Write the failing tests** (`src/test/upgradeScript.test.ts`, ported from odoo-manager `tests/test_upgrade_script.py`; read it alongside)

```ts
import * as assert from 'assert';
import {
    DEFAULT_HEADER, entryKey, mergeEntries, newScript, newScriptFile, parseScript, renderScript, scriptEntry, type ScriptView
} from '../services/views/upgradeScript';
import { hasPython, runScript } from './helpers/pythonScript';

function view(id: number, overrides: Partial<ScriptView> = {}): ScriptView {
    return {
        id, xmlid: `acme.view_${id}`, model: 'res.partner', type: 'form', name: `Partner form ${id}`,
        listedIn: ['18.0'], dbName: 'shop-18', arch: `<data><field name="f${id}"/></data>`, why: null, ...overrides
    };
}

const AWKWARD_ARCH = '<data>\n  <!-- a\\b """quoted""" and "" "-->\n  <field name="x" string="Prénom ✓ \\n"/>\n</data>"';

suite('Upgrade script', function () {
    suiteSetup(function () {
        if (!hasPython()) {
            this.skip();
        }
    });

    test('is valid Python with the expected shape', () => {
        const source = newScript([view(1), view(2, { arch: null, why: 'noted' })]);
        assert.ok(source.startsWith('from lxml import etree\n\nfrom odoo.upgrade import util\n\n'));
        assert.ok(source.includes(`${DEFAULT_HEADER}\n\nACTIVATE = [\n`));
        assert.ok(source.includes(']\n\nVIEWS = [\n'));
        assert.ok(source.includes(']\n\n\ndef migrate(cr, version):\n'));
        const run = runScript(source, { 'acme.view_2': 42 });
        assert.deepStrictEqual(run.ACTIVATE, ['acme.view_2']);
        assert.strictEqual(run.VIEWS?.length, 1);
    });

    test('the header says what it is for and what it needs', () => {
        assert.match(DEFAULT_HEADER, /View Doctor/);
        assert.match(DEFAULT_HEADER, /upgrade-util/);
        assert.match(DEFAULT_HEADER, /end-/);
        assert.ok(DEFAULT_HEADER.split('\n').every(line => line.startsWith('#')));
    });

    test('each view is labelled for the reviewer, with its database and the upgrades that disabled it', () => {
        const source = newScript([view(1, { listedIn: ['17.0', '18.0'] })]);
        assert.ok(source.includes('# res.partner form — id 1 in shop-18 (disabled by the 17.0 and 18.0 upgrades)\n'));
        assert.ok(source.includes('# Partner form 1\n'));
        const three = newScript([view(1, { listedIn: ['16.0', '17.0', '18.0'] })]);
        assert.ok(three.includes('(disabled by the 16.0, 17.0 and 18.0 upgrades)'));
        assert.ok(!newScript([view(1, { listedIn: [] })]).includes('disabled by'));
    });

    test('replaces the whole arch of every view, by external id or by id, and always activates', () => {
        const run = runScript(newScript([view(1), view(2, { xmlid: null })]));
        assert.deepStrictEqual(run.edits, [
            // The literal ends with the newline before its closing quotes; etree ignores it.
            ['acme.view_1', null, { skip_if_not_noupdate: false, active: true }, '<data><field name="f1"/></data>\n'],
            [null, 2, { skip_if_not_noupdate: false, active: true }, '<data><field name="f2"/></data>\n']
        ]);
    });

    test('a view that cannot be found is skipped and the rest still apply', () => {
        const run = runScript(newScript([view(1), view(2)]), {}, ['acme.view_1']);
        assert.deepStrictEqual(run.edits.map(edit => edit[0]), ['acme.view_2']);
    });

    test('views without an external id say so, and name their database', () => {
        const source = newScript([view(5, { xmlid: null }), view(6, { xmlid: null, arch: null, why: 'not-edited' })]);
        assert.strictEqual(source.split('# NOTE: no xml_id, so this view is addressed by database id — valid in shop-18 only.').length, 3);
        assert.ok(source.includes('"view_id": 5,'));
        assert.ok(source.includes('    6,\n'));
    });

    test('an awkward arch survives the round trip exactly', () => {
        const run = runScript(newScript([view(1, { arch: AWKWARD_ARCH })]));
        assert.strictEqual(run.VIEWS?.[0].arch, `${AWKWARD_ARCH.trim()}\n`);
        assert.strictEqual(run.edits[0][3], `${AWKWARD_ARCH.trim()}\n`);
    });

    test('carriage returns in an arch become plain line ends', () => {
        const run = runScript(newScript([view(1, { arch: '<data>\r\n<a/>\r<b/></data>' })]));
        assert.strictEqual(run.VIEWS?.[0].arch, '<data>\n<a/>\n<b/></data>\n');
    });

    test('an awkward external id survives the round trip exactly', () => {
        const xmlid = 'studio_customization.odoo_studio_"quote"\\é';
        const run = runScript(newScript([view(1, { xmlid }), view(2, { xmlid: `${xmlid}2`, arch: null, why: 'noted' })]), { [`${xmlid}2`]: 2 });
        assert.strictEqual(run.VIEWS?.[0].xmlid, xmlid);
        assert.deepStrictEqual(run.ACTIVATE, [`${xmlid}2`]);
    });

    test('a hostile view name cannot inject code, in either list', () => {
        const name = 'x\nimport os; os.system("boom")\r\u2028y\u0085z';
        const source = newScript([view(1, { name, model: 'a\nb', listedIn: ['18.0\nimport os'] }), view(2, { name, arch: null, why: 'noted' })]);
        const run = runScript(source, { 'acme.view_2': 2 });
        assert.strictEqual(run.edits.length, 1);
        assert.ok(!/^import os/m.test(source));
    });

    test('long names are truncated in the comment', () => {
        const source = newScript([view(1, { name: 'é'.repeat(300) })]);
        assert.ok(source.includes(`# ${'é'.repeat(99)}…\n`));
    });

    test('the output is deterministic', () => {
        const views = [view(1), view(2, { arch: null, why: 'not-edited' })];
        assert.strictEqual(newScript(views), newScript(views));
    });

    test('nothing to write is an error, not an empty script', () => {
        assert.throws(() => newScript([]));
    });

    test('a view with a blank arch is refused', () => {
        assert.throws(() => scriptEntry(view(1, { arch: '  \n ' })), /view 1 has no arch/);
    });

    test('an unedited view is only re-enabled and carries no arch, by external id or by id', () => {
        const source = newScript([view(1, { arch: null, why: 'noted' }), view(2, { xmlid: null, arch: null, why: 'not-edited' })]);
        assert.ok(!source.includes('lxml'));
        assert.ok(!source.includes('VIEWS = ['));
        assert.ok(!source.includes('edit_view'));
        const run = runScript(source, { 'acme.view_1': 11 });
        assert.deepStrictEqual(run.executed, [
            ['UPDATE ir_ui_view SET active = true WHERE id = %s', [11]],
            ['UPDATE ir_ui_view SET active = true WHERE id = %s', [2]]
        ]);
    });

    test('an unedited view missing from the target is skipped quietly', () => {
        const run = runScript(newScript([view(1, { arch: null, why: 'noted' })]), {});
        assert.deepStrictEqual(run.executed, []);
    });

    test('each unedited view says why it needs no arch', () => {
        const source = newScript([view(1, { arch: null, why: 'noted' }), view(2, { arch: null, why: 'not-edited' })]);
        assert.ok(source.includes('# arch unchanged since it was noted — only re-enabled\n'));
        assert.ok(source.includes('# arch never edited in the database — only re-enabled\n'));
    });

    test('a file the extension wrote parses back into the same file', () => {
        const file = mergeEntries(newScriptFile(), [view(1), view(2, { xmlid: null, arch: AWKWARD_ARCH }), view(3, { arch: null, why: 'noted' })].map(scriptEntry));
        const source = renderScript(file);
        assert.deepStrictEqual(parseScript(source), file);
        assert.deepStrictEqual(parseScript(source.replace(/\n/g, '\r\n')), file);
        const viewsOnly = newScript([view(1)]);
        assert.strictEqual(renderScript(parseScript(viewsOnly)!), viewsOnly);
        const activateOnly = newScript([view(1, { arch: null, why: 'noted' })]);
        assert.strictEqual(renderScript(parseScript(activateOnly)!), activateOnly);
    });

    test('a comment edited inside an entry, or in the header, survives a merge', () => {
        const source = newScript([view(1), view(2, { arch: null, why: 'noted' })])
            .replace('# Partner form 1\n', '# Partner form 1\n        # reviewed by Ahmad\n')
            .replace(DEFAULT_HEADER, `${DEFAULT_HEADER}\n# Ticket 1234567`);
        const parsed = parseScript(source);
        assert.ok(parsed);
        const merged = renderScript(mergeEntries(parsed, [scriptEntry(view(3))]));
        assert.ok(merged.includes('# reviewed by Ahmad'));
        assert.ok(merged.includes('# Ticket 1234567'));
    });

    test('anything changed outside the entries makes the file not ours', () => {
        const source = newScript([view(1), view(2, { arch: null, why: 'noted' })]);
        const edits = [
            source.replace('def migrate(cr, version):\n', 'def migrate(cr, version):\n    util.remove_view(cr, "x")\n'),
            source.replace('"xmlid": "acme.view_1",', '"xmlid": \'acme.view_1\','),
            source.replace('    "acme.view_2",\n', '    "acme.view_2",\n    # trailing\n'),
            source.replace('from odoo.upgrade import util\n', 'from odoo.upgrade import util\nimport os\n'),
            `${source}\nprint(1)\n`,
            'def migrate(cr, version):\n    pass\n',
            ''
        ];
        for (const edited of edits) {
            assert.strictEqual(parseScript(edited), undefined, edited);
        }
    });

    test('an arch hiding a fake closing quote is read to its real end', () => {
        const arch = '<data>"""""\n    },\n]\n</data>';
        const source = newScript([view(1, { arch }), view(2)]);
        const parsed = parseScript(source);
        assert.deepStrictEqual(parsed?.views.map(entry => entry.key), ['acme.view_1', 'acme.view_2']);
    });

    test('merging replaces a view already listed instead of duplicating it, and moves it between lists', () => {
        const file = mergeEntries(newScriptFile(), [view(1), view(2, { arch: null, why: 'noted' }), view(3)].map(scriptEntry));
        const merged = mergeEntries(file, [
            scriptEntry(view(1, { arch: '<data>new</data>' })),
            scriptEntry(view(2, { arch: '<data>edited</data>' })),
            scriptEntry(view(3, { arch: null, why: 'not-edited' })),
            scriptEntry(view(4))
        ]);
        assert.deepStrictEqual(merged.views.map(entry => entry.key), ['acme.view_1', 'acme.view_2', 'acme.view_4']);
        assert.deepStrictEqual(merged.activate.map(entry => entry.key), ['acme.view_3']);
        assert.ok(merged.views[0].text.includes('<data>new</data>'));
        const run = runScript(renderScript(merged), { 'acme.view_3': 3 });
        assert.strictEqual(run.edits.length, 3);
        assert.strictEqual(run.executed.length, 1);
    });

    test('entries are keyed by external id, or by id without one', () => {
        assert.strictEqual(entryKey({ id: 4, xmlid: 'a.b' }), 'a.b');
        assert.strictEqual(entryKey({ id: 4, xmlid: null }), 'id:4');
        assert.strictEqual(scriptEntry(view(4, { xmlid: null })).key, 'id:4');
    });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npm run compile-tests` — Expected: compile errors, `upgradeScript` does not exist.

- [ ] **Step 4: Implement** (`src/services/views/upgradeScript.ts`; port of odoo-manager `upgrade_script.py` — `_instance_entry`, `_activate_entry`, `render_instance_script` — keep its docstrings' reasoning as comments)

```ts
/**
 * Upgrade scripts that put fixed views back during an upgrade. Port of
 * odoo-manager's upgrade_script.py (render_instance_script).
 *
 * Wholesale on purpose: a view's whole arch is written back as it is in the
 * database now, rather than the edits that got it there - a common idiom in
 * upgrade-specific, and what the editor showed is exactly what the script
 * writes. A view whose arch was never edited (unchangedReason) goes in
 * ACTIVATE instead and is only re-enabled.
 *
 * Invariants (odoo-manager CLAUDE.md:135-203):
 * - edit_view always gets skip_if_not_noupdate=False: by default it does
 *   nothing at all for a view whose ir_model_data is noupdate=False, which is
 *   every view a custom module ships.
 * - edit_view always gets active=True: its "auto" activates an xmlid target
 *   but leaves a view_id target alone, and re-enabling is the point.
 * - Re-enabling only is a plain UPDATE: edit_view would re-serialize the arch
 *   it is meant to leave alone.
 * - A view with no external id is addressed by its id, which only means
 *   something in the database it came from; the entry says so.
 *
 * The file the extension writes can be parsed back (parseScript), so a later
 * Add to Upgrade Script merges into it. Pure string work.
 */
import type { UnchangedReason } from './viewNotes';

export interface ScriptView {
    id: number;
    xmlid: string | null;
    model: string;
    type: string;
    name: string;
    /** The Odoo versions whose upgrade disabled it. */
    listedIn: string[];
    /** The database the view and its arch come from. */
    dbName: string;
    /** null: only re-enabled, the arch is left out (see `why`). */
    arch: string | null;
    why: UnchangedReason | null;
}

/** One element of ACTIVATE or VIEWS, as its exact text in the file. */
export interface ScriptEntry {
    /** The external id, or `id:<view id>` without one. */
    key: string;
    list: 'activate' | 'views';
    text: string;
}

export interface ScriptFile {
    /** Comment lines, no trailing newline. */
    header: string;
    activate: ScriptEntry[];
    views: ScriptEntry[];
}

export const DEFAULT_HEADER = [
    "# Views fixed with Odoo DevTools' View Doctor, written back during the upgrade.",
    '# Needs upgrade-util on the upgrade path (--upgrade-path=<upgrade-util>/src) for `from odoo.upgrade import util`.',
    "# An end- script runs after every module has loaded, so no module's data file overwrites these views.",
    '# Every view listed is made active. VIEWS also get their arch back; ACTIVATE are only re-enabled.'
].join('\n');

const LXML_IMPORT = 'from lxml import etree\n\n';
const UTIL_IMPORT = 'from odoo.upgrade import util\n\n';
const ACTIVATE_OPEN = 'ACTIVATE = [\n';
const VIEWS_OPEN = 'VIEWS = [\n';
const ARCH_OPEN = '        "arch": """\\\n';
const ARCH_CLOSE = '""",\n    },\n';

const ACTIVATE_SQL = 'cr.execute("UPDATE ir_ui_view SET active = true WHERE id = %s", [view_id])';

const ACTIVATE_STEP = [
    '    for target in ACTIVATE:',
    '        view_id = target if isinstance(target, int) else util.ref(cr, target)',
    '        if view_id:',
    `            ${ACTIVATE_SQL}`
].join('\n') + '\n';

const VIEWS_STEP = [
    '    for view in VIEWS:',
    '        xmlid = view.get("xmlid")',
    '        view_id = view.get("view_id")',
    '        with util.skippable_cm(), util.edit_view(cr, xmlid, view_id, skip_if_not_noupdate=False, active=True) as arch:',
    '            new_arch = etree.fromstring(view["arch"])',
    '            arch.tag = new_arch.tag',
    '            arch.text = new_arch.text',
    '            arch.attrib.clear()',
    '            arch.attrib.update(new_arch.attrib)',
    '            arch[:] = new_arch[:]'
].join('\n') + '\n';

const WHY: Record<UnchangedReason, string> = {
    noted: 'arch unchanged since it was noted',
    'not-edited': 'arch never edited in the database'
};

/**
 * `text` on one line, for a comment. View names come from the database and
 * Studio lets anyone type a newline into one, which would end the comment and
 * turn the rest into code. Python's own line ends are \n and \r; the other
 * separators are collapsed too, to be safe.
 */
export function oneLine(text: string, limit?: number): string {
    const line = String(text).split(/[\s\x1c-\x1f\x85]+/).filter(Boolean).join(' ');
    const chars = Array.from(line);
    return limit && chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : line;
}

/**
 * The body of a Python triple-quoted string. Left literal in the usual case
 * (a human reads and edits this XML); escaped only when a backslash or an
 * embedded """ would break the literal. The caller always puts a newline
 * before the closing quotes, so a trailing " is harmless.
 */
export function pyTripleQuoted(text: string): string {
    return text.includes('\\') || text.includes('"""')
        ? text.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')
        : text;
}

export function entryKey(view: { id: number; xmlid: string | null }): string {
    return view.xmlid ?? `id:${view.id}`;
}

function head(view: ScriptView): string {
    const label = [view.model, view.type].filter(Boolean).join(' ') || 'view';
    let line = `# ${oneLine(label)} — id ${view.id} in ${oneLine(view.dbName)}`;
    const steps = view.listedIn.map(step => oneLine(step));
    if (steps.length === 1) {
        line += ` (disabled by the ${steps[0]} upgrade)`;
    } else if (steps.length > 1) {
        line += ` (disabled by the ${steps.slice(0, -1).join(', ')} and ${steps[steps.length - 1]} upgrades)`;
    }
    return line;
}

function noXmlidNote(view: ScriptView): string {
    return `# NOTE: no xml_id, so this view is addressed by database id — valid in ${oneLine(view.dbName)} only.`;
}

function activateEntry(view: ScriptView): ScriptEntry {
    const lines = [head(view)];
    if (view.name) {
        lines.push(`# ${oneLine(view.name, 100)}`);
    }
    const why = `# ${view.why ? WHY[view.why] : 'arch unchanged'} — only re-enabled`;
    if (view.xmlid) {
        lines.push(why, `${JSON.stringify(view.xmlid)},`);
    } else {
        lines.push(noXmlidNote(view), why, `${view.id},`);
    }
    return { key: entryKey(view), list: 'activate', text: lines.map(line => `    ${line}\n`).join('') };
}

function viewsEntry(view: ScriptView): ScriptEntry {
    const arch = (view.arch ?? '').replace(/\r\n?/g, '\n').trim();
    if (!arch) {
        throw new Error(`view ${view.id} has no arch to write`);
    }
    const lines = [head(view)];
    if (view.name) {
        lines.push(`# ${oneLine(view.name, 100)}`);
    }
    if (view.xmlid) {
        lines.push(`"xmlid": ${JSON.stringify(view.xmlid)},`);
    } else {
        lines.splice(1, 0, noXmlidNote(view));
        lines.push(`"view_id": ${view.id},`);
    }
    const body = lines.map(line => `        ${line}\n`).join('');
    return { key: entryKey(view), list: 'views', text: `    {\n${body}${ARCH_OPEN}${pyTripleQuoted(arch)}\n${ARCH_CLOSE}` };
}

/** The view's entry: ACTIVATE when its arch is left out, VIEWS otherwise. */
export function scriptEntry(view: ScriptView): ScriptEntry {
    return view.arch === null ? activateEntry(view) : viewsEntry(view);
}

export function newScriptFile(): ScriptFile {
    return { header: DEFAULT_HEADER, activate: [], views: [] };
}

/** `file` with `entries` added; a view already listed is replaced where it stands, or moved to the other list. */
export function mergeEntries(file: ScriptFile, entries: ScriptEntry[]): ScriptFile {
    const activate = [...file.activate];
    const views = [...file.views];
    for (const entry of entries) {
        const [target, other] = entry.list === 'activate' ? [activate, views] : [views, activate];
        const elsewhere = other.findIndex(existing => existing.key === entry.key);
        if (elsewhere >= 0) {
            other.splice(elsewhere, 1);
        }
        const here = target.findIndex(existing => existing.key === entry.key);
        if (here >= 0) {
            target[here] = entry;
        } else {
            target.push(entry);
        }
    }
    return { header: file.header, activate, views };
}

/** The file's full text. Only what is needed: no lxml without VIEWS, no ACTIVATE list when nothing is only re-enabled. */
export function renderScript(file: ScriptFile): string {
    if (file.activate.length === 0 && file.views.length === 0) {
        throw new Error('no views to write');
    }
    const sections: string[] = [];
    const steps: string[] = [];
    if (file.activate.length > 0) {
        sections.push(`${ACTIVATE_OPEN}${file.activate.map(entry => entry.text).join('')}]\n`);
        steps.push(ACTIVATE_STEP);
    }
    if (file.views.length > 0) {
        sections.push(`${VIEWS_OPEN}${file.views.map(entry => entry.text).join('')}]\n`);
        steps.push(VIEWS_STEP);
    }
    const imports = file.views.length > 0 ? LXML_IMPORT : '';
    return `${imports}${UTIL_IMPORT}${file.header}\n\n${sections.join('\n')}\n\ndef migrate(cr, version):\n${steps.join('\n')}`;
}

export function newScript(views: ScriptView[]): string {
    return renderScript(mergeEntries(newScriptFile(), views.map(scriptEntry)));
}

/** The key of a literal as this file writes it: a JSON-style "string", or digits for an id. */
function keyOfLiteral(literal: string, allowId: boolean): string | undefined {
    if (/^\d+$/.test(literal)) {
        return allowId ? `id:${Number(literal)}` : undefined;
    }
    try {
        const value: unknown = JSON.parse(literal);
        return typeof value === 'string' && value ? value : undefined;
    } catch {
        return undefined;
    }
}

/** Where the """ closing an arch starts, honouring backslash escapes; -1 when it never closes. */
function closingQuotes(text: string, from: number): number {
    for (let i = from; i < text.length; i++) {
        if (text[i] === '\\') {
            i++;
        } else if (text.startsWith('"""', i)) {
            return i;
        }
    }
    return -1;
}

function parseActivate(text: string, start: number): { entries: ScriptEntry[]; end: number } | undefined {
    const entries: ScriptEntry[] = [];
    let at = start;
    let entryStart = start;
    for (;;) {
        const eol = text.indexOf('\n', at);
        if (eol < 0) {
            return undefined;
        }
        const line = text.slice(at, eol);
        if (line === ']') {
            return at === entryStart ? { entries, end: eol + 1 } : undefined;
        }
        if (!line.startsWith('    #')) {
            const value = /^ {4}("(?:[^"\\]|\\.)*"|\d+),$/.exec(line);
            const key = value ? keyOfLiteral(value[1], true) : undefined;
            if (!key) {
                return undefined;
            }
            entries.push({ key, list: 'activate', text: text.slice(entryStart, eol + 1) });
            entryStart = eol + 1;
        }
        at = eol + 1;
    }
}

function parseViews(text: string, start: number): { entries: ScriptEntry[]; end: number } | undefined {
    const entries: ScriptEntry[] = [];
    let at = start;
    for (;;) {
        if (text.startsWith(']\n', at)) {
            return { entries, end: at + 2 };
        }
        if (!text.startsWith('    {\n', at)) {
            return undefined;
        }
        const entryStart = at;
        at += '    {\n'.length;
        let key: string | undefined;
        while (!text.startsWith(ARCH_OPEN, at)) {
            const eol = text.indexOf('\n', at);
            if (eol < 0) {
                return undefined;
            }
            const line = text.slice(at, eol);
            const keyed = /^ {8}"(xmlid|view_id)": ("(?:[^"\\]|\\.)*"|\d+),$/.exec(line);
            if (keyed && key === undefined) {
                key = keyed[1] === 'view_id'
                    ? (/^\d+$/.test(keyed[2]) ? `id:${Number(keyed[2])}` : undefined)
                    : keyOfLiteral(keyed[2], false);
                if (!key) {
                    return undefined;
                }
            } else if (!line.startsWith('        #')) {
                return undefined;
            }
            at = eol + 1;
        }
        if (!key) {
            return undefined;
        }
        const close = closingQuotes(text, at + ARCH_OPEN.length);
        if (close < 0 || !text.startsWith(ARCH_CLOSE, close)) {
            return undefined;
        }
        at = close + ARCH_CLOSE.length;
        entries.push({ key, list: 'views', text: text.slice(entryStart, at) });
    }
}

/**
 * A script this extension wrote, read back so new entries can be merged in;
 * undefined for anything else. The test is exact: the file must re-render byte
 * for byte from what was read (CRLF read as LF). Entries are kept verbatim, so
 * a comment edited inside one survives; code added anywhere does not parse,
 * and the caller writes a new file rather than lose it.
 */
export function parseScript(source: string): ScriptFile | undefined {
    const text = source.replace(/\r\n/g, '\n');
    let at = text.startsWith(LXML_IMPORT) ? LXML_IMPORT.length : 0;
    if (!text.startsWith(UTIL_IMPORT, at)) {
        return undefined;
    }
    at += UTIL_IMPORT.length;
    const headerEnd = text.indexOf('\n\n', at);
    if (headerEnd < 0) {
        return undefined;
    }
    const header = text.slice(at, headerEnd);
    if (!header || !header.split('\n').every(line => line.startsWith('#'))) {
        return undefined;
    }
    at = headerEnd + 2;
    const file: ScriptFile = { header, activate: [], views: [] };
    if (text.startsWith(ACTIVATE_OPEN, at)) {
        const parsed = parseActivate(text, at + ACTIVATE_OPEN.length);
        if (!parsed) {
            return undefined;
        }
        file.activate = parsed.entries;
        at = parsed.end;
        if (text.startsWith(`\n${VIEWS_OPEN}`, at)) {
            at += 1;
        }
    }
    if (text.startsWith(VIEWS_OPEN, at)) {
        const parsed = parseViews(text, at + VIEWS_OPEN.length);
        if (!parsed) {
            return undefined;
        }
        file.views = parsed.entries;
    }
    if (file.activate.length === 0 && file.views.length === 0) {
        return undefined;
    }
    return renderScript(file) === text ? file : undefined;
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Upgrade script"` — Expected: all pass (python3 is installed on this machine; the suite must not be skipped here — check the output says passing, not pending).

- [ ] **Step 6: Commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist
git add src/services/views/upgradeScript.ts src/test/upgradeScript.test.ts src/test/helpers/pythonScript.ts
git commit -m "[ADD] Upgrade script generator, ported from odoo-manager

ACTIVATE and VIEWS lists and one edit_view loop, always with
skip_if_not_noupdate=False and active=True; views with no external id go
by id, with a note that the id only holds in their database. The file can
be parsed back exactly, so later additions merge into it: a view already
listed is replaced, and anything not written by the extension is refused.
Tests run the generated Python under python3 with stand-ins for
upgrade-util and lxml.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Keeping the note — service, tree "Edited here", save and Turn On hooks

**Files:**
- Create: `src/services/views/viewNoteService.ts`
- Modify: `src/services/views/viewService.ts` (constructor, `doctorGroups`)
- Modify: `src/services/views/viewGroups.ts` (`edited`)
- Modify: `src/views/viewDoctorView.ts` (`ViewItem` section `'edited'`, the "Edited here" group)
- Modify: `src/extension.ts` (create the note service; record saves)
- Modify: `src/commands/index.ts` (`CommandDeps.viewNotes`), `src/commands/viewDoctorCommands.ts` (record Turn On)
- Test: `src/test/viewNoteService.test.ts`; add cases to `src/test/viewGroups.test.ts` and `src/test/viewDoctorView.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ViewNoteStore`, `buildNote`, `baseline`, `recordJournal`, `emptyNote`, `Fingerprint`, `NoteRow`, `ViewNote`), Task 2 (`getViewFingerprints`, `getDatabaseUuid`).
- Produces:
  ```ts
  export interface NoteQueries { fingerprints(dbName: string, ids: number[]): Promise<Map<number, Fingerprint> | undefined>; databaseUuid(dbName: string): Promise<string | undefined>; }
  export const psqlNoteQueries: NoteQueries;
  export class ViewNoteService {
      constructor(store: ViewNoteStore, queries?: NoteQueries, now?: () => number);
      read(dbName: string): Promise<ViewNote>;
      observe(dbName: string, listed: Map<number, string[]>, rows: Map<number, NoteRow>): Promise<ViewNote>;
      recordSave(dbName: string, viewId: number, activated: boolean): Promise<void>; // never rejects
      recordActivate(dbName: string, viewId: number): Promise<void>;                 // never rejects
  }
  // viewGroups.ts
  export function groupViews(inactive: ViewRow[], reported: Map<number, string[]>, reportedRows: ViewRow[], edited?: ViewRow[]): ViewGroups; // ViewGroups gains `edited: ViewRow[]`
  // viewService.ts
  constructor(pool: ViewWorkerPool, notes?: ViewNoteService)
  // CommandDeps gains `viewNotes: ViewNoteService`
  ```

- [ ] **Step 1: Write the failing service tests** (`src/test/viewNoteService.test.ts`; ported from the note half of odoo-manager `tests/test_view_note_flow.py`)

```ts
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ViewNoteService, type NoteQueries } from '../services/views/viewNoteService';
import { ViewNoteStore, type Fingerprint, type NoteRow } from '../services/views/viewNotes';

function row(active: boolean): NoteRow {
    return { active, name: 'v', model: 'res.partner', type: 'form', xmlid: null };
}

function fp(archMd5: string, written = 1): Fingerprint {
    return { archMd5, written, archUpdated: false, module: null, noupdate: null };
}

suite('View note service', () => {
    let dir: string;
    let store: ViewNoteStore;
    let calls: number[][];
    let uuid: string | undefined;
    let fingerprints: Map<number, Fingerprint> | undefined;
    const queries: NoteQueries = {
        fingerprints: async (_db, ids) => { calls.push([...ids]); return fingerprints; },
        databaseUuid: async () => uuid
    };
    const file = () => path.join(dir, 'shop.json');

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-note-service-'));
        store = new ViewNoteStore(dir);
        calls = [];
        uuid = 'uuid-1';
        fingerprints = new Map([[1, fp('h1')], [2, fp('h2')]]);
    });
    teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('keeps only what is reported and still disabled, with each new view\'s baseline', async () => {
        const service = new ViewNoteService(store, queries, () => 5000);
        const note = await service.observe('shop', new Map([[1, ['18.0']], [2, ['18.0']]]), new Map([[1, row(false)], [2, row(true)]]));
        assert.deepStrictEqual(note.views.map(view => [view.id, view.archMd5]), [[1, 'h1']]);
        assert.deepStrictEqual(calls, [[1]]);
        assert.strictEqual(JSON.parse(fs.readFileSync(file(), 'utf-8')).dbUuid, 'uuid-1');
    });

    test('no report notes nothing and writes nothing', async () => {
        const service = new ViewNoteService(store, queries, () => 5000);
        await service.observe('shop', new Map(), new Map());
        assert.ok(!fs.existsSync(file()));
        assert.deepStrictEqual(calls, []);
    });

    test('when nothing changed, nothing is queried or written', async () => {
        const service = new ViewNoteService(store, queries, () => 5000);
        const listed = new Map([[1, ['18.0']]]);
        await service.observe('shop', listed, new Map([[1, row(false)]]));
        const written = fs.statSync(file()).mtimeMs;
        calls = [];
        await service.observe('shop', listed, new Map([[1, row(true)]]));
        assert.deepStrictEqual(calls, []);
        assert.strictEqual(fs.statSync(file()).mtimeMs, written);
    });

    test('a note is still taken when the arch cannot be fingerprinted, and baselined once it can', async () => {
        fingerprints = undefined;
        const service = new ViewNoteService(store, queries, () => 5000);
        const first = await service.observe('shop', new Map([[1, ['18.0']]]), new Map([[1, row(false)]]));
        assert.ok(!('archMd5' in first.views[0]));
        fingerprints = new Map([[1, fp('h1', 4000)]]);
        const second = await service.observe('shop', new Map([[1, ['18.0']]]), new Map([[1, row(false)]]));
        assert.strictEqual(second.views[0].archMd5, 'h1');
        calls = [];
        await service.observe('shop', new Map([[1, ['18.0']]]), new Map([[1, row(false)]]));
        assert.deepStrictEqual(calls, []);
    });

    test('a note from a database since replaced under the same name is ignored, then replaced', async () => {
        const service = new ViewNoteService(store, queries, () => 5000);
        await service.recordSave('shop', 9, false);
        uuid = 'uuid-2';
        assert.deepStrictEqual((await service.read('shop')).journal, []);
        await service.recordActivate('shop', 3);
        const stored = JSON.parse(fs.readFileSync(file(), 'utf-8'));
        assert.deepStrictEqual(stored.journal.map((entry: { id: number }) => entry.id), [3]);
        assert.strictEqual(stored.dbUuid, 'uuid-2');
    });

    test('an unreadable uuid keeps the note as it is', async () => {
        const service = new ViewNoteService(store, queries, () => 5000);
        await service.recordSave('shop', 9, true);
        uuid = undefined;
        assert.deepStrictEqual((await service.read('shop')).journal, [{ id: 9, saved: true, activated: true, at: 5000 }]);
    });

    test('recording never fails the save or Turn On it follows', async () => {
        fs.writeFileSync(path.join(dir, 'blocker'), '');
        const service = new ViewNoteService(new ViewNoteStore(path.join(dir, 'blocker', 'notes')), queries);
        await service.recordSave('shop', 1, false);
        await service.recordActivate('shop', 1);
    });
});
```

- [ ] **Step 2: Write the failing grouping and tree tests**

Add to `src/test/viewGroups.test.ts`:

```ts
    test('lists the views changed here, by model then id, whatever their state', () => {
        const groups = groupViews([], new Map(), [], [row(9, { model: 'b' }), row(3, { model: 'b', active: true }), row(5, { model: 'a' })]);
        assert.deepStrictEqual(groups.edited.map(view => view.id), [5, 3, 9]);
        assert.deepStrictEqual(groupViews([], new Map(), []).edited, []);
    });
```

Add to `src/test/viewDoctorView.test.ts` (reuse that file's existing row helper and imports; if it has none, build a `ViewRow` literal as in `viewGroups.test.ts`):

```ts
    test('shows the views changed here between the upgrade group and the other inactive views', () => {
        const edited = { id: 4, name: 'Edited form', model: 'res.partner', type: 'form', active: true, inheritId: null, xmlid: 'acme.f', rootId: 4, isReport: false, writeDate: 0 };
        const rows = buildDoctorRows('shop', { upgradeDisabled: [], upgradeVersions: [], otherInactive: [{ ...edited, id: 5, active: false }], missingIds: [], edited: [edited] });
        assert.deepStrictEqual(rows.map(item => item.label), ['Edited here', 'Other inactive views']);
        const group = rows[0] as ViewGroupItem;
        assert.strictEqual(group.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
        assert.strictEqual(group.description, '1');
        assert.strictEqual(group.children[0].id, 'shop:edited:4:on');
    });
```

- [ ] **Step 3: Run to verify they fail**

Run: `npm run compile-tests` — Expected: compile errors (`viewNoteService` missing, `edited` not on `ViewGroups`).

- [ ] **Step 4: Implement the service** (`src/services/views/viewNoteService.ts`)

```ts
/**
 * Keeps each database's view note (viewNotes.ts) up to date: the views the
 * upgrade report lists and that are still off are noted, with a baseline,
 * whenever the tree reads the report; every save and Turn On through the
 * extension goes in the journal. A note belongs to one database: one written
 * for another database under the same name (dropped and recreated, or a
 * different restore) has another database.uuid and reads as empty.
 * Bookkeeping never fails what triggered it.
 */
import { logger } from '../logger';
import { getDatabaseUuid, getViewFingerprints } from './viewQueries';
import { baseline, buildNote, emptyNote, recordJournal, type Fingerprint, type NoteRow, type ViewNote, type ViewNoteStore } from './viewNotes';

export interface NoteQueries {
    /** undefined when they cannot be read: then nothing can be proven, and every arch is kept. */
    fingerprints(dbName: string, ids: number[]): Promise<Map<number, Fingerprint> | undefined>;
    databaseUuid(dbName: string): Promise<string | undefined>;
}

export const psqlNoteQueries: NoteQueries = {
    fingerprints: async (dbName, ids) => {
        try {
            return await getViewFingerprints(dbName, ids);
        } catch (error) {
            logger.warn(`Could not fingerprint the views of ${dbName}:`, error);
            return undefined;
        }
    },
    databaseUuid: async dbName => {
        try {
            return await getDatabaseUuid(dbName);
        } catch {
            return undefined;
        }
    }
};

/** The note when it is this database's, an empty one when it belongs to another under the same name. */
function ownNote(note: ViewNote, uuid: string | undefined): ViewNote {
    return note.dbUuid && uuid && note.dbUuid !== uuid ? emptyNote() : note;
}

export class ViewNoteService {
    constructor(
        private readonly store: ViewNoteStore,
        private readonly queries: NoteQueries = psqlNoteQueries,
        private readonly now: () => number = Date.now
    ) {}

    async read(dbName: string): Promise<ViewNote> {
        const uuid = await this.queries.databaseUuid(dbName);
        return ownNote(await this.store.load(dbName), uuid);
    }

    /**
     * Notes what `listed` (view id -> versions whose report listed it) has
     * that is still off in `rows`, and baselines older entries where that is
     * provable. Fingerprints are read only when there is something to note or
     * baseline, and the file is written only when the note changed.
     */
    async observe(dbName: string, listed: Map<number, string[]>, rows: Map<number, NoteRow>): Promise<ViewNote> {
        const uuid = await this.queries.databaseUuid(dbName);
        return this.store.update(dbName, async stored => {
            const note = ownNote(stored, uuid);
            const known = new Set(note.views.map(view => view.id));
            const fresh = [...listed.keys()].filter(id => !known.has(id) && rows.get(id)?.active === false);
            const unbaselined = note.views.filter(view => view.archMd5 === undefined).map(view => view.id);
            const ids = [...fresh, ...unbaselined];
            const fingerprints = ids.length > 0 ? await this.queries.fingerprints(dbName, ids) : new Map<number, Fingerprint>();
            const withHashes = new Map(rows);
            for (const id of fresh) {
                const hash = fingerprints?.get(id)?.archMd5;
                const row = rows.get(id);
                if (row && typeof hash === 'string') {
                    withHashes.set(id, { ...row, archMd5: hash });
                }
            }
            const now = this.now();
            const built = buildNote(note, listed, withHashes, now);
            const based = baseline(built.note, fingerprints);
            const write = built.summary.added > 0 || built.summary.extended > 0 || based.tried > 0;
            return { note: write ? { ...based.note, dbUuid: uuid ?? note.dbUuid, updatedAt: now } : note, write };
        });
    }

    async recordSave(dbName: string, viewId: number, activated: boolean): Promise<void> {
        await this.journal(dbName, viewId, activated ? ['saved', 'activated'] : ['saved']);
    }

    async recordActivate(dbName: string, viewId: number): Promise<void> {
        await this.journal(dbName, viewId, ['activated']);
    }

    private async journal(dbName: string, viewId: number, kinds: Array<'saved' | 'activated'>): Promise<void> {
        try {
            const uuid = await this.queries.databaseUuid(dbName);
            await this.store.update(dbName, async stored => {
                const note = ownNote(stored, uuid);
                return { note: { ...recordJournal(note, viewId, kinds, this.now()), dbUuid: uuid ?? note.dbUuid }, write: true };
            });
        } catch (error) {
            logger.warn(`Could not note the change to view ${viewId} in ${dbName}:`, error);
        }
    }
}
```

- [ ] **Step 5: Wire it into grouping, the service, the tree and the hooks**

`viewGroups.ts`: add to `ViewGroups`:

```ts
    /** Views this extension saved or turned on (the note's journal), whatever their state now. */
    edited: ViewRow[];
```

and give `groupViews` a fourth parameter `edited: ViewRow[] = []`, returning `edited: [...edited].sort((a, b) => a.model.localeCompare(b.model) || a.id - b.id)`.

`viewService.ts`: import `ViewNoteService` (type) and `logger` (`import { logger } from '../logger';`). Constructor becomes `constructor(private readonly pool: ViewWorkerPool, private readonly notes?: ViewNoteService) {}`. `doctorGroups` becomes:

```ts
    /** The tree's content: psql only, so it shows without waiting for a shell. Keeps the note up to date on the way. */
    async doctorGroups(dbName: string): Promise<ViewGroups> {
        const [inactive, messages] = await Promise.all([listInactiveViews(dbName), getReportMessages(dbName)]);
        const reported = mergeReports(messages.map(message => parseDisabledViews(message.body)));
        const inactiveIds = new Set(inactive.map(view => view.id));
        const reEnabled = await getViewRows(dbName, [...reported.keys()].filter(id => !inactiveIds.has(id)));
        let edited: ViewRow[] = [];
        if (this.notes) {
            try {
                const rows = new Map([...inactive, ...reEnabled].map(view => [view.id, view]));
                const note = await this.notes.observe(dbName, reported, rows);
                edited = await getViewRows(dbName, note.journal.map(entry => entry.id));
            } catch (error) {
                logger.warn(`Could not update the view note of ${dbName}:`, error);
            }
        }
        return groupViews(inactive, reported, reEnabled, edited);
    }
```

`viewDoctorView.ts`: widen `ViewItem`'s `section` type to `'upgrade' | 'edited' | 'other'`, and in `buildDoctorRows`, between the upgrade group and the other-inactive group:

```ts
    if (groups.edited.length > 0) {
        rows.push(new ViewGroupItem(
            'Edited here',
            `${dbName}:group:edited`,
            groups.edited.map(view => new ViewItem(dbName, view, 'edited')),
            true,
            String(groups.edited.length)
        ));
    }
```

Fix every other construction of a `ViewGroups` literal that `tsc` now flags (tests included) by adding `edited: []`.

`src/commands/index.ts`: add to `CommandDeps`:

```ts
    /** Each database's note of disabled views and the journal of changes made here. */
    viewNotes: ViewNoteService;
```

(`import type { ViewNoteService } from '../services/views/viewNoteService';`)

`src/extension.ts`, where `viewService` is created:

```ts
    // What the upgrade disabled and what was changed here, per database, for upgrade scripts.
    const viewNotes = new ViewNoteService(new ViewNoteStore(path.join(context.globalStorageUri.fsPath, 'view-notes')));
    const viewService = new ViewService(viewWorkers, viewNotes);
```

In the `onSaved` hook, replace the trailing `providers.views.refresh();` with:

```ts
            // The tree shows the journal, so refresh once the save is in it.
            void viewNotes.recordSave(ref.dbName, ref.viewId, result.activated).then(() => providers.views.refresh());
```

and pass `viewNotes` in the `registerAllCommands({ ... })` call.

`src/commands/viewDoctorCommands.ts`: destructure `viewNotes` from `deps`, and in `viewDoctor.activate`, right after `await viewService.activate(item.dbName, item.view.id);`:

```ts
            await viewNotes.recordActivate(item.dbName, item.view.id);
```

Any test that builds a `CommandDeps` must now pass `viewNotes` (search `src/test` for `registerAllCommands` / `viewRender:`; give it `new ViewNoteService(new ViewNoteStore(<tmp dir>), { fingerprints: async () => new Map(), databaseUuid: async () => undefined })`).

- [ ] **Step 6: Run to verify they pass**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View (note service|Doctor)"` — Expected: pass. Then the full suite: `env -u ELECTRON_RUN_AS_NODE npm test` — Expected: all pass (count grows from 678).

- [ ] **Step 7: Commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist
git add src/services/views/viewNoteService.ts src/services/views/viewService.ts src/services/views/viewGroups.ts src/views/viewDoctorView.ts src/extension.ts src/commands/index.ts src/commands/viewDoctorCommands.ts src/test/viewNoteService.test.ts src/test/viewGroups.test.ts src/test/viewDoctorView.test.ts
git commit -m "[ADD] Views keep a note per database, and show what was edited here

Each time the Views tree reads the upgrade report, the views it lists that
are still off are noted with their arch hash; every save and Turn On goes in
the note's journal, which the tree shows as Edited here. A note written for
another database under the same name (a different database.uuid) reads as
empty. Bookkeeping never fails the tree, a save or Turn On.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

(Adjust the `git add` list to the test files you actually touched.)

---

### Task 5: Choosing what goes in the script (`scriptBuilder.ts`)

**Files:**
- Create: `src/services/views/scriptBuilder.ts`
- Test: `src/test/scriptBuilder.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ViewNote`, `Fingerprint`, `UnchangedReason`, `unchangedReason`), Task 3 (`ScriptView`), `ViewRow` (`viewQueries.ts`).
- Produces:
  ```ts
  export interface ScriptCandidate { row: ViewRow; listedIn: string[]; why: UnchangedReason | null; }
  export interface ScriptSelection { include: ScriptCandidate[]; stillDisabled: ViewRow[]; deleted: number[]; }
  export function scriptIds(note: ViewNote): number[];
  export function selectForScript(note: ViewNote, ids: number[], rows: Map<number, ViewRow>, fingerprints: Map<number, Fingerprint> | undefined): ScriptSelection;
  export interface ScriptSources {
      prepare(dbName: string): Promise<{ note: ViewNote; reEnabled: ViewRow[] }>;
      rows(dbName: string, ids: number[]): Promise<ViewRow[]>;
      fingerprints(dbName: string, ids: number[]): Promise<Map<number, Fingerprint> | undefined>;
      arch(dbName: string, viewId: number): Promise<string>;
  }
  export interface ScriptBuild { views: ScriptView[]; stillDisabled: ViewRow[]; deleted: number[]; noArch: ViewRow[]; notNoted: ViewRow[]; }
  export function buildScriptViews(sources: ScriptSources, dbName: string, viewId?: number): Promise<ScriptBuild>;
  export function leftOutText(build: ScriptBuild): string;
  export function scriptSummary(build: ScriptBuild, where: string): string;
  export function nothingToScript(build: ScriptBuild, dbName: string): string;
  ```

- [ ] **Step 1: Write the failing tests** (ported from the script half of odoo-manager `tests/test_view_note_flow.py`)

```ts
import * as assert from 'assert';
import { buildScriptViews, leftOutText, nothingToScript, scriptIds, scriptSummary, type ScriptSources } from '../services/views/scriptBuilder';
import { emptyNote, type Fingerprint, type ViewNote } from '../services/views/viewNotes';
import type { ViewRow } from '../services/views/viewQueries';

function row(id: number, overrides: Partial<ViewRow> = {}): ViewRow {
    return { id, name: `view ${id}`, model: 'res.partner', type: 'form', active: true, inheritId: 1, xmlid: `acme.v${id}`, rootId: 1, isReport: false, writeDate: 0, ...overrides };
}

function fp(overrides: Partial<Fingerprint> = {}): Fingerprint {
    return { archMd5: 'h', written: 1, archUpdated: true, module: 'acme', noupdate: false, ...overrides };
}

function note(views: Array<[number, string | null | undefined]>, journal: number[] = []): ViewNote {
    return {
        ...emptyNote(),
        takenAt: 1,
        views: views.map(([id, archMd5]) => ({ id, name: `noted ${id}`, model: 'res.partner', type: 'form', xmlid: `acme.old${id}`, listedIn: ['18.0'], notedAt: 1, ...(archMd5 === undefined ? {} : { archMd5 }) })),
        journal: journal.map(id => ({ id, saved: true, activated: false, at: 1 }))
    };
}

function sources(state: { note: ViewNote; rows: ViewRow[]; fps?: Map<number, Fingerprint>; arches?: Record<number, string>; reEnabled?: ViewRow[] }, archReads: number[] = [], fpReads: number[][] = []): ScriptSources {
    return {
        prepare: async () => ({ note: state.note, reEnabled: state.reEnabled ?? [] }),
        rows: async (_db, ids) => state.rows.filter(view => ids.includes(view.id)),
        fingerprints: async (_db, ids) => { fpReads.push([...ids]); return state.fps; },
        arch: async (_db, id) => { archReads.push(id); return state.arches?.[id] ?? `<data id="${id}"/>`; }
    };
}

suite('Upgrade script selection', () => {
    test('covers exactly the noted and journaled views that are on now, and says what it left out', async () => {
        const state = {
            note: note([[1, 'x'], [2, 'x'], [3, 'x']], [4, 1]),
            rows: [row(1), row(2, { active: false }), row(4)],
            fps: new Map([[1, fp()], [4, fp()]])
        };
        const build = await buildScriptViews(sources(state), 'shop');
        assert.deepStrictEqual(build.views.map(view => view.id), [1, 4]);
        assert.deepStrictEqual(build.stillDisabled.map(view => view.id), [2]);
        assert.deepStrictEqual(build.deleted, [3]);
        assert.deepStrictEqual(scriptIds(state.note), [1, 2, 3, 4]);
    });

    test('reads fingerprints only for views that are on, and arches only for views that need them', async () => {
        const archReads: number[] = [];
        const fpReads: number[][] = [];
        const state = { note: note([[1, 'same'], [2, 'old'], [3, 'x']]), rows: [row(1), row(2), row(3, { active: false })], fps: new Map([[1, fp({ archMd5: 'same' })], [2, fp({ archMd5: 'new' })]]) };
        const build = await buildScriptViews(sources(state, archReads, fpReads), 'shop');
        assert.deepStrictEqual(fpReads, [[1, 2]]);
        assert.deepStrictEqual(archReads, [2]);
        assert.deepStrictEqual(build.views.map(view => [view.id, view.arch === null, view.why]), [[1, true, 'noted'], [2, false, null]]);
    });

    test('when nothing is on, no fingerprint or arch is read at all', async () => {
        const archReads: number[] = [];
        const fpReads: number[][] = [];
        const build = await buildScriptViews(sources({ note: note([[1, 'x']]), rows: [row(1, { active: false })] }, archReads, fpReads), 'shop');
        assert.deepStrictEqual([build.views, archReads, fpReads], [[], [], []]);
    });

    test('a view edited after it was noted keeps its arch; without a baseline Odoo\'s flag decides', async () => {
        const state = {
            note: note([[1, 'old'], [2, null], [3, undefined]]),
            rows: [row(1), row(2), row(3)],
            fps: new Map([[1, fp({ archMd5: 'new' })], [2, fp({ archUpdated: false })], [3, fp({ archUpdated: true })]])
        };
        const build = await buildScriptViews(sources(state), 'shop');
        assert.deepStrictEqual(build.views.map(view => [view.id, view.why]), [[1, null], [2, 'not-edited'], [3, null]]);
    });

    test('unreadable fingerprints mean every view keeps its arch', async () => {
        const build = await buildScriptViews(sources({ note: note([[1, 'h']]), rows: [row(1)], fps: undefined }), 'shop');
        assert.deepStrictEqual(build.views.map(view => [view.why, typeof view.arch]), [[null, 'string']]);
    });

    test('a view that needs its arch but has none is reported, not written', async () => {
        const build = await buildScriptViews(sources({ note: note([[1, 'h']]), rows: [row(1)], fps: new Map([[1, fp({ archMd5: 'x' })]]), arches: { 1: '  ' } }), 'shop');
        assert.deepStrictEqual([build.views, build.noArch.map(view => view.id)], [[], [1]]);
    });

    test('uses the live external id and name, and the noted versions', async () => {
        const build = await buildScriptViews(sources({ note: note([[1, 'h']]), rows: [row(1, { xmlid: 'acme.renamed', name: 'Live' })], fps: new Map([[1, fp({ archMd5: 'x' })]]) }), 'shop');
        assert.deepStrictEqual([build.views[0].xmlid, build.views[0].name, build.views[0].listedIn, build.views[0].dbName], ['acme.renamed', 'Live', ['18.0'], 'shop']);
    });

    test('a view only in the journal can still go in, unedited', async () => {
        const build = await buildScriptViews(sources({ note: note([], [7]), rows: [row(7)], fps: new Map([[7, fp({ archUpdated: false })]]) }), 'shop');
        assert.deepStrictEqual(build.views.map(view => [view.id, view.why, view.listedIn]), [[7, 'not-edited', []]]);
    });

    test('one view: only that view, noted or not, and no hint about the others', async () => {
        const state = { note: note([[1, 'h']]), rows: [row(1), row(9)], fps: new Map([[9, fp()]]), reEnabled: [row(5)] };
        const build = await buildScriptViews(sources(state), 'shop', 9);
        assert.deepStrictEqual([build.views.map(view => view.id), build.notNoted], [[9], []]);
    });

    test('counts the re-enabled views the note never saw', async () => {
        const state = { note: note([[1, 'h']]), rows: [row(1)], fps: new Map([[1, fp()]]), reEnabled: [row(1), row(5), row(6)] };
        const build = await buildScriptViews(sources(state), 'shop');
        assert.deepStrictEqual(build.notNoted.map(view => view.id), [5, 6]);
    });

    test('says what was written and what was left out, in plain words', () => {
        const base = { views: [], stillDisabled: [], deleted: [], noArch: [], notNoted: [] };
        assert.strictEqual(leftOutText(base), '');
        assert.strictEqual(
            leftOutText({ ...base, stillDisabled: [row(1), row(2)], deleted: [3], noArch: [row(4)], notNoted: [row(5)] }),
            'Left out: 2 still off, 1 deleted, 1 with no arch, 1 re-enabled view fixed before the note was taken (use Add to Upgrade Script on it).'
        );
        const views = [{ arch: null }, { arch: '<a/>' }] as never;
        assert.strictEqual(scriptSummary({ ...base, views }, 'Wrote x'), 'Wrote x: 2 views, 1 only re-enabled.');
        assert.strictEqual(nothingToScript({ ...base, stillDisabled: [row(1)] }, 'shop'), 'Nothing to script in shop yet: no fixed or edited view is on. Left out: 1 still off.');
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run compile-tests` — Expected: compile errors, `scriptBuilder` does not exist.

- [ ] **Step 3: Implement** (`src/services/views/scriptBuilder.ts`)

```ts
/**
 * Which views an upgrade script covers, and with or without their arch.
 * Create Upgrade Script covers every view in the note or its journal that is
 * on now; Add to Upgrade Script one view. Still-off and deleted views are
 * left out and counted. Whether an arch is needed is unchangedReason's call,
 * on live fingerprints; arches are read only for the views that need one.
 */
import type { ScriptView } from './upgradeScript';
import type { ViewRow } from './viewQueries';
import { unchangedReason, type Fingerprint, type UnchangedReason, type ViewNote } from './viewNotes';

export interface ScriptCandidate {
    row: ViewRow;
    listedIn: string[];
    why: UnchangedReason | null;
}

export interface ScriptSelection {
    include: ScriptCandidate[];
    stillDisabled: ViewRow[];
    deleted: number[];
}

export interface ScriptSources {
    /** The database's note, up to date, and the views its upgrade report lists that are on now. */
    prepare(dbName: string): Promise<{ note: ViewNote; reEnabled: ViewRow[] }>;
    rows(dbName: string, ids: number[]): Promise<ViewRow[]>;
    fingerprints(dbName: string, ids: number[]): Promise<Map<number, Fingerprint> | undefined>;
    arch(dbName: string, viewId: number): Promise<string>;
}

export interface ScriptBuild {
    views: ScriptView[];
    stillDisabled: ViewRow[];
    deleted: number[];
    noArch: ViewRow[];
    /** Re-enabled views the report lists that the note never saw off. */
    notNoted: ViewRow[];
}

/** Every view the note knows: noted first, then the journal's. */
export function scriptIds(note: ViewNote): number[] {
    return [...new Set([...note.views.map(view => view.id), ...note.journal.map(entry => entry.id)])];
}

export function selectForScript(note: ViewNote, ids: number[], rows: Map<number, ViewRow>, fingerprints: Map<number, Fingerprint> | undefined): ScriptSelection {
    const noted = new Map(note.views.map(view => [view.id, view]));
    const selection: ScriptSelection = { include: [], stillDisabled: [], deleted: [] };
    for (const id of ids) {
        const row = rows.get(id);
        if (!row) {
            selection.deleted.push(id);
        } else if (!row.active) {
            selection.stillDisabled.push(row);
        } else {
            const entry = noted.get(id);
            selection.include.push({ row, listedIn: entry?.listedIn ?? [], why: unchangedReason(entry, fingerprints?.get(id)) });
        }
    }
    selection.include.sort((a, b) => a.row.model.localeCompare(b.row.model) || a.row.id - b.row.id);
    return selection;
}

/** The views for a script of `dbName`: all the note covers, or the one view `viewId`. */
export async function buildScriptViews(sources: ScriptSources, dbName: string, viewId?: number): Promise<ScriptBuild> {
    const { note, reEnabled } = await sources.prepare(dbName);
    const ids = viewId === undefined ? scriptIds(note) : [viewId];
    const rows = new Map((ids.length > 0 ? await sources.rows(dbName, ids) : []).map(view => [view.id, view]));
    const activeIds = ids.filter(id => rows.get(id)?.active);
    const fingerprints = activeIds.length > 0 ? await sources.fingerprints(dbName, activeIds) : new Map<number, Fingerprint>();
    const selection = selectForScript(note, ids, rows, fingerprints);
    const views: ScriptView[] = [];
    const noArch: ViewRow[] = [];
    for (const { row, listedIn, why } of selection.include) {
        let arch: string | null = null;
        if (why === null) {
            arch = await sources.arch(dbName, row.id);
            if (!arch.trim()) {
                noArch.push(row);
                continue;
            }
        }
        views.push({ id: row.id, xmlid: row.xmlid, model: row.model, type: row.type, name: row.name, listedIn, dbName, arch, why });
    }
    const covered = new Set(ids);
    const notNoted = viewId === undefined ? reEnabled.filter(view => !covered.has(view.id)) : [];
    return { views, stillDisabled: selection.stillDisabled, deleted: selection.deleted, noArch, notNoted };
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function leftOutText(build: ScriptBuild): string {
    const parts: string[] = [];
    if (build.stillDisabled.length > 0) {
        parts.push(`${build.stillDisabled.length} still off`);
    }
    if (build.deleted.length > 0) {
        parts.push(`${build.deleted.length} deleted`);
    }
    if (build.noArch.length > 0) {
        parts.push(`${build.noArch.length} with no arch`);
    }
    if (build.notNoted.length > 0) {
        const count = build.notNoted.length;
        parts.push(`${plural(count, 're-enabled view')} fixed before the note was taken (use Add to Upgrade Script on ${count === 1 ? 'it' : 'each'})`);
    }
    return parts.length > 0 ? `Left out: ${parts.join(', ')}.` : '';
}

export function scriptSummary(build: ScriptBuild, where: string): string {
    const only = build.views.filter(view => view.arch === null).length;
    return [`${where}: ${plural(build.views.length, 'view')}${only > 0 ? `, ${only} only re-enabled` : ''}.`, leftOutText(build)].filter(Boolean).join(' ');
}

export function nothingToScript(build: ScriptBuild, dbName: string): string {
    return [`Nothing to script in ${dbName} yet: no fixed or edited view is on.`, leftOutText(build)].filter(Boolean).join(' ');
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Upgrade script selection"` — Expected: pass.

- [ ] **Step 5: Commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist
git add src/services/views/scriptBuilder.ts src/test/scriptBuilder.test.ts
git commit -m "[ADD] Choose which views an upgrade script covers

Every noted or journaled view that is on now, or one view; still-off and
deleted ones are left out and counted, as are re-enabled views the note
never saw off. Fingerprints decide whether each needs its arch, and arches
are read only for those that do.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The migrations folder — manifest versions and writing without overwriting

**Files:**
- Create: `src/services/views/migrationsFolder.ts`
- Test: `src/test/migrationsFolder.test.ts`

**Interfaces:**
- Consumes: Task 3 (`ScriptView`, `scriptEntry`, `parseScript`, `mergeEntries`, `renderScript`, `newScriptFile`).
- Produces:
  ```ts
  export const SCRIPT_NAME: 'end-update_views';
  export function isVersionFolder(version: string): boolean;
  export function manifestVersion(text: string): string | undefined;
  export function bumpVersion(version: string | undefined): string | undefined;
  export function seriesOf(odooVersion: string | undefined): string | undefined;
  export function withSeries(version: string, series: string | undefined): string;
  export function compareVersions(a: string, b: string): number;
  export function needsManifestBump(folder: string, manifest: string | undefined, series: string | undefined): boolean;
  export function setManifestVersion(text: string, version: string): string;
  export interface WrittenScript { path: string; merged: boolean; }
  export function writeScriptToFolder(dir: string, views: ScriptView[]): Promise<WrittenScript>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    bumpVersion, compareVersions, isVersionFolder, manifestVersion, needsManifestBump, seriesOf, setManifestVersion, withSeries, writeScriptToFolder
} from '../services/views/migrationsFolder';
import { parseScript, type ScriptView } from '../services/views/upgradeScript';

function view(id: number, arch: string | null = `<data id="${id}"/>`): ScriptView {
    return { id, xmlid: `acme.v${id}`, model: 'res.partner', type: 'form', name: `v${id}`, listedIn: [], dbName: 'shop', arch, why: arch === null ? 'noted' : null };
}

suite('Migrations folder', () => {
    let dir: string;
    setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-migrations-')); });
    teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('reads and bumps the manifest version', () => {
        assert.strictEqual(manifestVersion("{\n    'name': 'Acme',\n    'version': '17.0.1.0.3',\n}"), '17.0.1.0.3');
        assert.strictEqual(manifestVersion('{"version": "1.2"}'), '1.2');
        assert.strictEqual(manifestVersion("{'name': 'Acme'}"), undefined);
        assert.strictEqual(bumpVersion('17.0.1.0.3'), '17.0.1.0.4');
        assert.strictEqual(bumpVersion('17.0.1.0.9'), '17.0.1.0.10');
        assert.strictEqual(bumpVersion(undefined), '1.1');
        assert.strictEqual(bumpVersion('1'), '1.1');
        assert.strictEqual(bumpVersion('17.0.1.0.0-beta'), undefined);
    });

    test('accepts only plain version folders', () => {
        for (const ok of ['1.1', '18.0.1.0.1', '1.0.0']) {
            assert.ok(isVersionFolder(ok), ok);
        }
        for (const bad of ['', '1', '../1.0', '1.0/..', '1.0 ', 'saas~17.2.1', '1..0', '1.0.0.0.0.0.0']) {
            assert.ok(!isVersionFolder(bad), bad);
        }
    });

    test('compares versions the way Odoo decides whether a migration runs', () => {
        assert.strictEqual(seriesOf('17.0'), '17.0');
        assert.strictEqual(seriesOf('saas-17.4'), 'saas~17.4');
        assert.strictEqual(seriesOf('master'), undefined);
        assert.strictEqual(withSeries('1.1', '18.0'), '18.0.1.1');
        assert.strictEqual(withSeries('18.0.1.0.1', '18.0'), '18.0.1.0.1');
        assert.strictEqual(compareVersions('18.0.1.0', '18.0.1.0.0'), 0);
        assert.ok(compareVersions('18.0.1.0.10', '18.0.1.0.9') > 0);
        assert.ok(needsManifestBump('18.0.1.0.1', '18.0.1.0.0', '18.0'));
        assert.ok(needsManifestBump('1.1', undefined, '18.0'));
        assert.ok(needsManifestBump('18.0.1.0.1', '1.0', '18.0'));
        assert.ok(!needsManifestBump('18.0.1.0.1', '18.0.1.0.1', '18.0'));
        assert.ok(!needsManifestBump('1.0.1', '1.0.2', undefined));
    });

    test('sets the manifest version, keeping its quotes, or adds one', () => {
        assert.strictEqual(setManifestVersion("{\n    'version': '1.0',\n}", '1.1'), "{\n    'version': '1.1',\n}");
        assert.strictEqual(setManifestVersion('{"version" : "1.0"}', '1.1'), '{"version" : "1.1"}');
        assert.strictEqual(setManifestVersion("# -*- coding -*-\n{\n    'name': 'Acme',\n}", '1.1'), "# -*- coding -*-\n{\n    'version': '1.1',\n    'name': 'Acme',\n}");
        assert.throws(() => setManifestVersion('nothing here', '1.1'));
    });

    test('writes a new end-update_views.py, creating the folder', async () => {
        const folder = path.join(dir, 'migrations', '18.0.1.0.1');
        const written = await writeScriptToFolder(folder, [view(1)]);
        assert.deepStrictEqual(written, { path: path.join(folder, 'end-update_views.py'), merged: false });
        assert.ok(parseScript(fs.readFileSync(written.path, 'utf-8')));
    });

    test('merges into the script already there, replacing a view it lists', async () => {
        await writeScriptToFolder(dir, [view(1), view(2, null)]);
        const written = await writeScriptToFolder(dir, [view(1, '<data>new</data>'), view(3)]);
        assert.deepStrictEqual(written, { path: path.join(dir, 'end-update_views.py'), merged: true });
        const parsed = parseScript(fs.readFileSync(written.path, 'utf-8'))!;
        assert.deepStrictEqual(parsed.views.map(entry => entry.key), ['acme.v1', 'acme.v3']);
        assert.ok(parsed.views[0].text.includes('<data>new</data>'));
        assert.deepStrictEqual(parsed.activate.map(entry => entry.key), ['acme.v2']);
    });

    test('never overwrites a file it cannot parse back: the first parseable or free sibling is used', async () => {
        const own = path.join(dir, 'end-update_views.py');
        fs.writeFileSync(own, 'def migrate(cr, version):\n    pass\n');
        const second = await writeScriptToFolder(dir, [view(1)]);
        assert.deepStrictEqual(second, { path: path.join(dir, 'end-update_views_2.py'), merged: false });
        assert.strictEqual(fs.readFileSync(own, 'utf-8'), 'def migrate(cr, version):\n    pass\n');
        const third = await writeScriptToFolder(dir, [view(2)]);
        assert.deepStrictEqual(third, { path: path.join(dir, 'end-update_views_2.py'), merged: true });
    });

    test('a file saved with Windows line ends is still merged', async () => {
        const first = await writeScriptToFolder(dir, [view(1)]);
        fs.writeFileSync(first.path, fs.readFileSync(first.path, 'utf-8').replace(/\n/g, '\r\n'));
        const again = await writeScriptToFolder(dir, [view(2)]);
        assert.deepStrictEqual(again, { path: first.path, merged: true });
    });

    test('refuses to write nothing', async () => {
        await assert.rejects(writeScriptToFolder(dir, []));
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run compile-tests` — Expected: compile errors, `migrationsFolder` does not exist.

- [ ] **Step 3: Implement** (`src/services/views/migrationsFolder.ts`)

```ts
/**
 * Where an upgrade script lands in a module: migrations/<version>/
 * end-update_views.py. Odoo runs migrations/<v>/ for a module being updated
 * when installed < v <= the manifest's version, versions with fewer than two
 * dots being prefixed with the series first (odoo/modules/migration.py,
 * convert_version). end- scripts run after every module has loaded.
 *
 * A script already there is merged into when this extension wrote it
 * (parseScript); anything else is never overwritten: the next numbered
 * sibling is used instead.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mergeEntries, newScriptFile, parseScript, renderScript, scriptEntry, type ScriptView } from './upgradeScript';

export const SCRIPT_NAME = 'end-update_views';
const MAX_SIBLINGS = 100;

export function isVersionFolder(version: string): boolean {
    return /^\d+(\.\d+){1,5}$/.test(version);
}

export function manifestVersion(text: string): string | undefined {
    const match = /(['"])version\1\s*:\s*(['"])([^'"\n]*)\2/.exec(text);
    return match?.[3].trim() || undefined;
}

/** The version one patch up; Odoo's default 1.0 bumped when there is none; undefined when it is not plain numbers. */
export function bumpVersion(version: string | undefined): string | undefined {
    const base = version ?? '1.0';
    if (!/^\d+(\.\d+)*$/.test(base)) {
        return undefined;
    }
    const parts = base.split('.');
    if (parts.length === 1) {
        parts.push('0');
    }
    parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
    return parts.join('.');
}

/** Odoo's release.major_version for a version's branch: 17.0, saas~17.4; undefined for master and the like. */
export function seriesOf(odooVersion: string | undefined): string | undefined {
    if (!odooVersion) {
        return undefined;
    }
    if (/^\d+\.\d+$/.test(odooVersion)) {
        return odooVersion;
    }
    const saas = /^saas-(\d+\.\d+)$/.exec(odooVersion);
    return saas ? `saas~${saas[1]}` : undefined;
}

/** convert_version: a version with fewer than two dots gets the series in front. */
export function withSeries(version: string, series: string | undefined): string {
    return version.split('.').length >= 3 || !series ? version : `${series}.${version}`;
}

export function compareVersions(a: string, b: string): number {
    const left = a.split('.');
    const right = b.split('.');
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const x = left[i] ?? '0';
        const y = right[i] ?? '0';
        const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
        const diff = numeric ? Number(x) - Number(y) : x.localeCompare(y);
        if (diff !== 0) {
            return Math.sign(diff);
        }
    }
    return 0;
}

/** Whether Odoo would skip migrations/<folder>/ until the manifest version goes up to it. */
export function needsManifestBump(folder: string, manifest: string | undefined, series: string | undefined): boolean {
    return compareVersions(withSeries(folder, series), withSeries(manifest ?? '1.0', series)) > 0;
}

/** The manifest with its version set, quotes kept; a manifest with none gets one first in its dict. */
export function setManifestVersion(text: string, version: string): string {
    const existing = /((['"])version\2\s*:\s*)(['"])[^'"\n]*\3/;
    if (existing.test(text)) {
        return text.replace(existing, (_match, key: string, _keyQuote: string, quote: string) => `${key}${quote}${version}${quote}`);
    }
    const open = text.indexOf('{');
    if (open < 0) {
        throw new Error('The manifest has no dictionary to add the version to.');
    }
    return `${text.slice(0, open + 1)}\n    'version': '${version}',${text.slice(open + 1)}`;
}

export interface WrittenScript {
    path: string;
    merged: boolean;
}

async function writeAtomic(file: string, text: string): Promise<void> {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
        await fs.writeFile(temp, text);
        await fs.rename(temp, file);
    } catch (error) {
        await fs.rm(temp, { force: true });
        throw error;
    }
}

/**
 * Writes `views` into `dir`/end-update_views.py, merging into it when this
 * extension wrote it, else into the first end-update_views_<n>.py that it
 * wrote or that does not exist yet.
 */
export async function writeScriptToFolder(dir: string, views: ScriptView[]): Promise<WrittenScript> {
    if (views.length === 0) {
        throw new Error('No views to write.');
    }
    const entries = views.map(scriptEntry);
    await fs.mkdir(dir, { recursive: true });
    for (let n = 1; n <= MAX_SIBLINGS; n++) {
        const file = path.join(dir, `${SCRIPT_NAME}${n === 1 ? '' : `_${n}`}.py`);
        let existing: string;
        try {
            existing = await fs.readFile(file, 'utf-8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
            // 'wx': if something appeared since the read, fail rather than overwrite it.
            await fs.writeFile(file, renderScript(mergeEntries(newScriptFile(), entries)), { flag: 'wx' });
            return { path: file, merged: false };
        }
        const parsed = parseScript(existing);
        if (parsed) {
            await writeAtomic(file, renderScript(mergeEntries(parsed, entries)));
            return { path: file, merged: true };
        }
    }
    throw new Error(`${dir} has no ${SCRIPT_NAME} file this extension can add to.`);
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Migrations folder"` — Expected: pass.

- [ ] **Step 5: Commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist
git add src/services/views/migrationsFolder.ts src/test/migrationsFolder.test.ts
git commit -m "[ADD] Write upgrade scripts into a module's migrations folder

migrations/<version>/end-update_views.py, merged into when the extension
wrote it, else the next numbered sibling: a file the extension cannot read
back is never overwritten. Manifest versions are read, bumped one patch and
compared the way Odoo decides whether a migration runs.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The commands — destination picker, Create / Add to Upgrade Script, menus

**Files:**
- Create: `src/views/scriptDestination.ts`
- Create: `src/views/upgradeScriptFlow.ts`
- Modify: `src/commands/viewDoctorCommands.ts`
- Modify: `package.json` (commands, `view/title`, `view/item/context`, `commandPalette`)
- Test: `src/test/scriptDestination.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6; `collectModuleDiscovery` (`src/services/psaeInternal.ts`), `resolveReposForDatabase` / `versionOfDatabase` (`src/services/versionRepos.ts`), `resolveViewDoctorTarget` (`src/views/viewDoctorView.ts`), `SettingsStore.peekSelectedProject`, `showInfo` / `showError` / `showBriefStatus` (`src/services/notifications.ts`).
- Produces:
  ```ts
  // scriptDestination.ts
  export interface ModuleChoice { name: string; path: string; repoName: string; }
  export type RememberedDestination = { kind: 'untitled' } | { kind: 'module'; module: string; version: string };
  export type ScriptDestination = { kind: 'untitled' } | { kind: 'module'; module: ModuleChoice; version: string };
  export interface DestinationItem extends vscode.QuickPickItem { destination?: { kind: 'untitled' } | { kind: 'module'; module: ModuleChoice }; }
  export function destinationKey(projectKey: string): string;
  export function normalizeDestination(raw: unknown): RememberedDestination | undefined;
  export function ownerCounts(views: Array<{ xmlid: string | null }>): Map<string, number>;
  export function withoutCoreModules(modules: ModuleChoice[], coreRoots: string[]): ModuleChoice[];
  export function destinationItems(modules: ModuleChoice[], owners: Map<string, number>, total: number, remembered: RememberedDestination | undefined): DestinationItem[];
  export function versionPrefill(module: ModuleChoice, remembered: RememberedDestination | undefined, manifestText: string | undefined, folderExists: (dir: string) => boolean): string;
  export function pickDestination(options: { modules: ModuleChoice[]; owners: Map<string, number>; total: number; memento: vscode.Memento; projectKey: string; title: string }): Promise<ScriptDestination | undefined>;
  // upgradeScriptFlow.ts
  export interface ScriptFlowDeps { context: vscode.ExtensionContext; viewService: ViewService; viewNotes: ViewNoteService; }
  export function createUpgradeScript(deps: ScriptFlowDeps, dbName: string, viewId?: number): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests** (`src/test/scriptDestination.test.ts`)

```ts
import * as assert from 'assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    destinationItems, destinationKey, normalizeDestination, ownerCounts, versionPrefill, withoutCoreModules, type ModuleChoice
} from '../views/scriptDestination';

function mod(name: string, repoName = 'acme-repo', root = '/repos/acme'): ModuleChoice {
    return { name, path: path.join(root, name), repoName };
}

suite('Upgrade script destination', () => {
    test('remembers per project, and reads back only a well-formed destination', () => {
        assert.strictEqual(destinationKey('uid-1'), 'viewDoctor.scriptDestination:uid-1');
        assert.deepStrictEqual(normalizeDestination({ kind: 'module', module: 'acme', version: '1.1' }), { kind: 'module', module: 'acme', version: '1.1' });
        assert.deepStrictEqual(normalizeDestination({ kind: 'untitled', extra: 1 }), { kind: 'untitled' });
        for (const bad of [undefined, null, 'x', { kind: 'module', module: 'acme' }, { kind: 'module', module: 'acme', version: '../x' }, { kind: 'other' }]) {
            assert.strictEqual(normalizeDestination(bad), undefined);
        }
    });

    test('counts the views each module owns, never Studio or exports', () => {
        const owners = ownerCounts([{ xmlid: 'acme.a' }, { xmlid: 'acme.b' }, { xmlid: 'sale.c' }, { xmlid: 'studio_customization.d' }, { xmlid: '__export__.e' }, { xmlid: null }]);
        assert.deepStrictEqual([...owners], [['acme', 2], ['sale', 1]]);
    });

    test('never offers a module under the core or enterprise checkout', () => {
        const modules = [mod('acme'), mod('sale', 'odoo', '/src/odoo/addons'), mod('web_studio', 'enterprise', '/src/enterprise')];
        assert.deepStrictEqual(withoutCoreModules(modules, ['/src/odoo', '/src/enterprise']).map(m => m.name), ['acme']);
    });

    test('orders the picker: last used, then owning modules, then the rest by name, then an untitled editor', () => {
        const modules = [mod('zeta'), mod('acme'), mod('beta'), mod('owner2'), mod('owner1')];
        const owners = new Map([['owner1', 1], ['owner2', 3], ['sale', 5]]);
        const items = destinationItems(modules, owners, 4, { kind: 'module', module: 'zeta', version: '1.2' });
        assert.deepStrictEqual(items.map(item => item.kind === vscode.QuickPickItemKind.Separator ? '--' : item.label), [
            'zeta', 'owner2', 'owner1', '--', 'acme', 'beta', '--', '$(new-file) Untitled Python Editor'
        ]);
        assert.match(items[0].description ?? '', /last used · migrations\/1\.2/);
        assert.strictEqual(items[1].description, 'owns 3 of the 4 views');
        const single = destinationItems([mod('owner1')], new Map([['owner1', 1]]), 1, undefined);
        assert.strictEqual(single[0].description, 'owns the view');
        const untitled = destinationItems([mod('acme')], new Map(), 1, { kind: 'untitled' });
        assert.deepStrictEqual(untitled.map(item => item.label), ['$(new-file) Untitled Python Editor', 'Modules', 'acme']);
    });

    test('a remembered module that is gone is not offered as last used', () => {
        const items = destinationItems([mod('acme')], new Map(), 1, { kind: 'module', module: 'gone', version: '1.1' });
        assert.ok(!items.some(item => (item.description ?? '').includes('last used')));
    });

    test('prefills the version folder: the remembered one while it exists, else the manifest bumped', () => {
        const acme = mod('acme');
        const remembered = { kind: 'module' as const, module: 'acme', version: '17.0.1.0.4' };
        const manifest = "{'version': '17.0.1.0.4'}";
        assert.strictEqual(versionPrefill(acme, remembered, manifest, () => true), '17.0.1.0.4');
        assert.strictEqual(versionPrefill(acme, remembered, manifest, () => false), '17.0.1.0.5');
        assert.strictEqual(versionPrefill(mod('other'), remembered, manifest, () => true), '17.0.1.0.5');
        assert.strictEqual(versionPrefill(acme, undefined, undefined, () => false), '1.1');
        assert.strictEqual(versionPrefill(acme, undefined, "{'version': 'x'}", () => false), '');
    });
});

suite('Upgrade script commands', () => {
    test('are contributed: on the Views title, and on active rows only, in a safe group', () => {
        const manifest = vscode.extensions.all.find(extension => extension.packageJSON?.contributes?.commands?.some((c: { command: string }) => c.command === 'viewDoctor.createScript'))?.packageJSON;
        assert.ok(manifest, 'the extension contributes viewDoctor.createScript');
        const title = manifest.contributes.menus['view/title'].find((m: { command: string }) => m.command === 'viewDoctor.createScript');
        assert.strictEqual(title.when, 'view == viewDoctor');
        const row = manifest.contributes.menus['view/item/context'].find((m: { command: string }) => m.command === 'viewDoctor.addToScript');
        assert.strictEqual(row.when, 'view == viewDoctor && viewItem =~ /^odooView\\.active/');
        assert.ok(!row.group.startsWith('inline') && !row.group.startsWith('9_danger'));
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run compile-tests` — Expected: compile errors, `scriptDestination` does not exist.

- [ ] **Step 3: Implement the picker** (`src/views/scriptDestination.ts`)

```ts
/**
 * Where Create / Add to Upgrade Script puts the script: a module's
 * migrations/<version>/ folder, or an untitled editor. The last choice is
 * remembered per project in workspaceState and offered first. Only the
 * project's own modules are offered, never core or enterprise ones.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { NOT_SHIPPED_MODULES } from '../services/views/viewNotes';
import { bumpVersion, isVersionFolder, manifestVersion } from '../services/views/migrationsFolder';

export interface ModuleChoice {
    name: string;
    path: string;
    repoName: string;
}

export type RememberedDestination = { kind: 'untitled' } | { kind: 'module'; module: string; version: string };
export type ScriptDestination = { kind: 'untitled' } | { kind: 'module'; module: ModuleChoice; version: string };

export interface DestinationItem extends vscode.QuickPickItem {
    destination?: { kind: 'untitled' } | { kind: 'module'; module: ModuleChoice };
}

const UNTITLED_LABEL = '$(new-file) Untitled Python Editor';

export function destinationKey(projectKey: string): string {
    return `viewDoctor.scriptDestination:${projectKey}`;
}

export function normalizeDestination(raw: unknown): RememberedDestination | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const value = raw as Record<string, unknown>;
    if (value.kind === 'untitled') {
        return { kind: 'untitled' };
    }
    if (value.kind === 'module' && typeof value.module === 'string' && value.module
        && typeof value.version === 'string' && isVersionFolder(value.version)) {
        return { kind: 'module', module: value.module, version: value.version };
    }
    return undefined;
}

/** How many of the views each module owns by external id; Studio and export ids own nothing. */
export function ownerCounts(views: Array<{ xmlid: string | null }>): Map<string, number> {
    const owners = new Map<string, number>();
    for (const { xmlid } of views) {
        const dot = xmlid?.indexOf('.') ?? -1;
        const module = xmlid && dot > 0 ? xmlid.slice(0, dot) : undefined;
        if (module && !NOT_SHIPPED_MODULES.includes(module)) {
            owners.set(module, (owners.get(module) ?? 0) + 1);
        }
    }
    return owners;
}

function isInside(child: string, root: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(child));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The modules outside the version's Odoo and enterprise checkouts. */
export function withoutCoreModules(modules: ModuleChoice[], coreRoots: string[]): ModuleChoice[] {
    const roots = coreRoots.filter(Boolean);
    return modules.filter(module => !roots.some(root => isInside(module.path, root)));
}

export function destinationItems(modules: ModuleChoice[], owners: Map<string, number>, total: number, remembered: RememberedDestination | undefined): DestinationItem[] {
    const untitled: DestinationItem = { label: UNTITLED_LABEL, description: 'not saved anywhere', destination: { kind: 'untitled' } };
    const byName = new Map(modules.map(module => [module.name, module]));
    const moduleItem = (module: ModuleChoice, description: string): DestinationItem =>
        ({ label: module.name, description, detail: module.path, destination: { kind: 'module', module } });
    const first: DestinationItem[] = [];
    const used = new Set<string>();
    if (remembered?.kind === 'untitled') {
        first.push({ ...untitled, description: 'last used' });
    } else if (remembered?.kind === 'module' && byName.has(remembered.module)) {
        first.push(moduleItem(byName.get(remembered.module)!, `last used · migrations/${remembered.version}`));
        used.add(remembered.module);
    }
    const owning = [...owners].filter(([name]) => byName.has(name) && !used.has(name))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [name, count] of owning) {
        first.push(moduleItem(byName.get(name)!, total === 1 ? 'owns the view' : `owns ${count} of the ${total} views`));
        used.add(name);
    }
    const rest = modules.filter(module => !used.has(module.name)).sort((a, b) => a.name.localeCompare(b.name))
        .map(module => moduleItem(module, module.repoName));
    const items: DestinationItem[] = [...first];
    if (rest.length > 0) {
        items.push({ label: 'Modules', kind: vscode.QuickPickItemKind.Separator }, ...rest);
    }
    if (remembered?.kind !== 'untitled') {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, untitled);
    }
    return items;
}

export function versionPrefill(module: ModuleChoice, remembered: RememberedDestination | undefined, manifestText: string | undefined, folderExists: (dir: string) => boolean): string {
    if (remembered?.kind === 'module' && remembered.module === module.name && folderExists(path.join(module.path, 'migrations', remembered.version))) {
        return remembered.version;
    }
    return bumpVersion(manifestText === undefined ? undefined : manifestVersion(manifestText)) ?? '';
}

function readManifest(modulePath: string): string | undefined {
    try {
        return fs.readFileSync(path.join(modulePath, '__manifest__.py'), 'utf-8');
    } catch {
        return undefined;
    }
}

export async function pickDestination(options: {
    modules: ModuleChoice[];
    owners: Map<string, number>;
    total: number;
    memento: vscode.Memento;
    projectKey: string;
    title: string;
}): Promise<ScriptDestination | undefined> {
    const key = destinationKey(options.projectKey);
    const remembered = normalizeDestination(options.memento.get(key));
    const picked = await vscode.window.showQuickPick(destinationItems(options.modules, options.owners, options.total, remembered), {
        title: options.title,
        placeHolder: 'Where should the upgrade script go?',
        matchOnDescription: true
    });
    if (!picked?.destination) {
        return undefined;
    }
    if (picked.destination.kind === 'untitled') {
        await options.memento.update(key, { kind: 'untitled' });
        return { kind: 'untitled' };
    }
    const module = picked.destination.module;
    const value = await vscode.window.showInputBox({
        title: options.title,
        prompt: `Version folder under ${module.name}/migrations/. Odoo runs it when the module's version goes up to it.`,
        value: versionPrefill(module, remembered, readManifest(module.path), fs.existsSync),
        validateInput: input => isVersionFolder(input.trim()) ? undefined : 'A version such as 18.0.1.0.1.'
    });
    if (value === undefined) {
        return undefined;
    }
    const version = value.trim();
    await options.memento.update(key, { kind: 'module', module: module.name, version });
    return { kind: 'module', module, version };
}
```

- [ ] **Step 4: Implement the flow** (`src/views/upgradeScriptFlow.ts`)

```ts
/**
 * Create Upgrade Script and Add to Upgrade Script: build the views, ask where
 * the script goes, write or open it, and say what was left out. Offers to
 * bump the module's manifest when the folder would otherwise never run.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SettingsStore } from '../settingsStore';
import type { ProjectModel } from '../models/project';
import { collectModuleDiscovery } from '../services/psaeInternal';
import { resolveReposForDatabase, versionOfDatabase } from '../services/versionRepos';
import { showBriefStatus, showInfo } from '../services/notifications';
import type { ViewService } from '../services/views/viewService';
import type { ViewNoteService } from '../services/views/viewNoteService';
import { psqlNoteQueries } from '../services/views/viewNoteService';
import { buildScriptViews, nothingToScript, scriptSummary, type ScriptSources } from '../services/views/scriptBuilder';
import { newScript } from '../services/views/upgradeScript';
import { manifestVersion, needsManifestBump, seriesOf, setManifestVersion, writeScriptToFolder } from '../services/views/migrationsFolder';
import { ownerCounts, pickDestination, withoutCoreModules, type ModuleChoice } from './scriptDestination';

export interface ScriptFlowDeps {
    context: vscode.ExtensionContext;
    viewService: ViewService;
    viewNotes: ViewNoteService;
}

type ProjectJson = ProjectModel & { uid?: string; name?: string };

async function scriptModules(project: ProjectJson, dbName: string): Promise<ModuleChoice[]> {
    const db = project.dbs?.find(entry => entry.id === dbName);
    const { modules } = collectModuleDiscovery(project, await resolveReposForDatabase(project, db));
    const settings = versionOfDatabase(db)?.settings;
    return withoutCoreModules(
        modules.map(module => ({ name: module.name, path: module.path, repoName: module.repoName })),
        [settings?.odooPath ?? '', settings?.enterprisePath ?? '']
    );
}

export async function createUpgradeScript(deps: ScriptFlowDeps, dbName: string, viewId?: number): Promise<void> {
    const sources: ScriptSources = {
        prepare: async db => {
            const groups = await deps.viewService.doctorGroups(db);
            return { note: await deps.viewNotes.read(db), reEnabled: groups.upgradeDisabled.filter(view => view.active) };
        },
        rows: (db, ids) => deps.viewService.rows(db, ids),
        fingerprints: (db, ids) => psqlNoteQueries.fingerprints(db, ids),
        arch: (db, id) => deps.viewService.getArch(db, id)
    };
    const build = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Building the upgrade script…' },
        () => buildScriptViews(sources, dbName, viewId)
    );
    if (build.views.length === 0) {
        void showInfo(nothingToScript(build, dbName));
        return;
    }

    const project = (await SettingsStore.peekSelectedProject().catch(() => null))?.project as ProjectJson | undefined;
    const modules = project ? await scriptModules(project, dbName) : [];
    const destination = await pickDestination({
        modules,
        owners: ownerCounts(build.views),
        total: build.views.length,
        memento: deps.context.workspaceState,
        projectKey: project?.uid ?? project?.name ?? 'default',
        title: viewId === undefined ? 'Create Upgrade Script' : 'Add to Upgrade Script'
    });
    if (!destination) {
        return;
    }

    if (destination.kind === 'untitled') {
        const document = await vscode.workspace.openTextDocument({ language: 'python', content: newScript(build.views) });
        await vscode.window.showTextDocument(document);
        void showInfo(scriptSummary(build, 'Untitled script'));
        return;
    }

    const { module, version } = destination;
    const written = await writeScriptToFolder(path.join(module.path, 'migrations', version), build.views);
    await vscode.window.showTextDocument(vscode.Uri.file(written.path));
    const where = `${written.merged ? 'Added to' : 'Wrote'} ${module.name}/${path.relative(module.path, written.path).split(path.sep).join('/')}`;
    const manifestPath = path.join(module.path, '__manifest__.py');
    const manifestText = await fs.readFile(manifestPath, 'utf-8').catch(() => undefined);
    const db = project?.dbs?.find(entry => entry.id === dbName);
    if (manifestText === undefined || !needsManifestBump(version, manifestVersion(manifestText), seriesOf(versionOfDatabase(db)?.odooVersion))) {
        void showInfo(scriptSummary(build, where));
        return;
    }
    const choice = await showInfo(`${scriptSummary(build, where)} Odoo runs migrations/${version}/ only once ${module.name}'s version is ${version} or higher.`, 'Set Version');
    if (choice === 'Set Version') {
        // Read again: the manifest may have changed while the message was open.
        const current = await fs.readFile(manifestPath, 'utf-8');
        await fs.writeFile(manifestPath, setManifestVersion(current, version));
        showBriefStatus(`${module.name} is now version ${version}.`);
    }
}
```

If `tsc` rejects passing the plain-JSON project to `collectModuleDiscovery` / `resolveReposForDatabase`, cast at the call the way `src/module.ts` does; do not hydrate models.

- [ ] **Step 5: Register the commands** — in `src/commands/viewDoctorCommands.ts`, import `createUpgradeScript` (`'../views/upgradeScriptFlow'`) and `resolveViewDoctorTarget` (from `'../views/viewDoctorView'`, next to `ViewItem`), then add inside `registerViewDoctorCommands`:

```ts
    context.subscriptions.push(registerCommand('viewDoctor.createScript', async () => {
        const project = (await SettingsStore.peekSelectedProject().catch(() => null))?.project;
        const target = resolveViewDoctorTarget(project as Parameters<typeof resolveViewDoctorTarget>[0]);
        if (!target) {
            void showInfo('Select a database first.');
            return;
        }
        try {
            await createUpgradeScript(deps, target.dbName);
        } catch (error) {
            void showError(`Could not create the upgrade script: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(registerCommand('viewDoctor.addToScript', async (arg: unknown) => {
        const item = viewItem(arg);
        if (!item) {
            return;
        }
        try {
            await createUpgradeScript(deps, item.dbName, item.view.id);
        } catch (error) {
            void showError(`Could not add ${item.view.name} to an upgrade script: ${errorMessage(error)}`);
        }
    }));
```

- [ ] **Step 6: Contribute them** — in `package.json`:
  - `contributes.commands`, after `viewDoctor.copyXmlid`:
    ```json
    { "command": "viewDoctor.createScript", "title": "Create Upgrade Script…", "category": "Odoo DevTools", "icon": "$(file-code)" },
    { "command": "viewDoctor.addToScript", "title": "Add to Upgrade Script…", "category": "Odoo DevTools" },
    ```
  - `menus["view/title"]`, before the `viewDoctor.refresh` entry:
    ```json
    { "command": "viewDoctor.createScript", "when": "view == viewDoctor", "group": "navigation@0" },
    ```
  - `menus["view/item/context"]`, after the `viewDoctor.copyXmlid` entry:
    ```json
    { "command": "viewDoctor.addToScript", "when": "view == viewDoctor && viewItem =~ /^odooView\\.active/", "group": "4_script@1" },
    ```
  - `menus.commandPalette`, with the other `viewDoctor.*` entries: `{ "command": "viewDoctor.addToScript", "when": "false" },` (Create Upgrade Script stays in the palette; it uses the tree's database.)

- [ ] **Step 7: Run to verify they pass**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Upgrade script (destination|commands)"` — Expected: pass. Then the full suite `env -u ELECTRON_RUN_AS_NODE npm test` — Expected: all pass (the activation smoke test checks every contributed command is registered).

- [ ] **Step 8: Commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist
git add src/views/scriptDestination.ts src/views/upgradeScriptFlow.ts src/commands/viewDoctorCommands.ts package.json src/test/scriptDestination.test.ts
git commit -m "[ADD] Create Upgrade Script and Add to Upgrade Script

Create Upgrade Script, on the Views title, covers every view the note says
was fixed or changed here; Add to Upgrade Script, on an active view's
right-click menu, covers that view. Pick a module (last used first, then
the modules owning the views, never core or enterprise) and a version
folder, or an untitled editor. The script is opened, what was left out is
said, and the manifest version is offered a bump when Odoo would otherwise
never run the folder.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The script against a real Odoo and upgrade-util (gated integration test)

**Files:**
- Create: `src/test/upgradeScript.integration.test.ts`

**Interfaces:**
- Consumes: `ViewWorker`, `ViewWorkerPool`, `ViewService` (as `viewWorker.integration.test.ts` builds them), `ViewNoteService` + `ViewNoteStore` + `psqlNoteQueries` (Task 4), `buildScriptViews` (Task 5), `writeScriptToFolder`, `setManifestVersion` (Task 6), `runSql`, `createDatabase`, `dropDatabaseIfExists`, `runCommand`.
- Produces: nothing.

Skipped unless `ODT_VIEW_TEST_PYTHON`, `ODT_VIEW_TEST_ODOO`, `ODT_VIEW_TEST_DB` **and** `ODT_VIEW_TEST_UPGRADE_UTIL` (path to upgrade-util's `src`) are set. Read `src/test/viewWorker.integration.test.ts` first and reuse its patterns (`archIsJsonb`, the worker construction, `runCommand(python, [odoo-bin, ...])`, `suiteSetup`/`suiteTeardown` with `dropDatabaseIfExists`). Copy the small helpers you need into this file rather than exporting them from the other test.

- [ ] **Step 1: Write the test**

The suite, with `this.timeout(900000)`:

1. **Setup.** `copy = `${sourceDb}_odt_script_test``; drop it if it exists, `createDatabase(copy, sourceDb)`. Make a temp addons folder (`fs.mkdtempSync`) with a module `odt_vd_script`:
   - `__init__.py`: empty.
   - `__manifest__.py`: `{'name': 'ODT View Doctor script test', 'version': '1.0.0', 'depends': ['base'], 'data': ['views.xml'], 'license': 'LGPL-3'}` — three-part versions need no series prefix (ruling 19).
   - `views.xml`: two records inheriting `base.view_partner_form`:
     - `view_partner_form_fixed`: `<xpath expr="//field[@name='name']" position="after"><field name="ref"/></xpath>`
     - `view_partner_form_reenabled`: `<xpath expr="//field[@name='email']" position="after"><field name="website"/></xpath>`
   - `addonsPaths = [`${odoo}/odoo/addons`, `${odoo}/addons`, tempAddons]`.
   - Install: `runCommand(python, [`${odoo}/odoo-bin`, '--addons-path', addonsPaths.join(','), '-d', copy, '-i', 'odt_vd_script', '--stop-after-init', '--no-http'])`.
   - Create the Studio-like view in a shell (as `SETUP` does in the other test): an `ir.ui.view` with no external id, inheriting `base.view_partner_form`, `mode='extension'`, arch `<data><xpath expr="//field[@name='name']" position="after"><field name="comment"/></xpath></data>`; print its id.
   - Read the three ids: the two module views via `ir_model_data` (`module = 'odt_vd_script'`), the Studio one from the shell output.
2. **Break them** (SQL, through `runSql`; the arch column is jsonb on 16+, so write `jsonb_build_object('en_US', <text>)` there and the text otherwise, as the other test does):
   - fixed view: arch → `<data><xpath expr="//field[@name='odt_missing']" position="after"><field name="ref"/></xpath></data>`, `active = false`, `arch_updated = false`;
   - Studio view: arch → the same broken xpath with `comment`, `active = false`;
   - re-enabled view: only `active = false` (its arch is untouched).
3. **Fix them through the extension's own code** (a `ViewWorkerPool` + `ViewService` on `copy`, built like the other test, with `addonsPaths` including the temp addons):
   - `service.save(copy, fixedId, '<data><xpath expr="//field[@name=\'name\']" position="after"><field name="ref" string="ODT fixed"/></xpath></data>')` → assert `activated`;
   - `service.save(copy, studioId, '<data><xpath expr="//field[@name=\'name\']" position="after"><field name="comment" string="ODT studio fixed"/></xpath></data>')` → assert `activated`;
   - `service.activate(copy, reenabledId)`.
   - Record them in a `ViewNoteService` over a temp `ViewNoteStore` with `psqlNoteQueries`: `recordSave(copy, fixedId, true)`, `recordSave(copy, studioId, true)`, `recordActivate(copy, reenabledId)`.
4. **Build and write the script:**
   ```ts
   const build = await buildScriptViews({
       prepare: async db => ({ note: await notes.read(db), reEnabled: [] }),
       rows: (db, ids) => service.rows(db, ids),
       fingerprints: (db, ids) => psqlNoteQueries.fingerprints(db, ids),
       arch: (db, id) => service.getArch(db, id)
   }, copy);
   ```
   Assert: three views; the fixed one has `xmlid === 'odt_vd_script.view_partner_form_fixed'` and an arch containing `ODT fixed`; the Studio one has `xmlid === null` and an arch containing `ODT studio fixed`; the re-enabled one has `arch === null` and `why === 'not-edited'`.
   Then `writeScriptToFolder(path.join(moduleDir, 'migrations', '1.0.1'), build.views)` and set the manifest to `1.0.1` with `setManifestVersion`.
5. **Restore the broken state** in the same database (the installed version is still `1.0.0`, so the folder is pending): stop the shell (`pool.dispose()`), then break the three views again exactly as in step 2 (fixed view: broken arch, off, `arch_updated = false`; Studio: broken arch, off; re-enabled: off).
6. **Run the upgrade of the module:** `runCommand(python, [`${odoo}/odoo-bin`, '--addons-path', addonsPaths.join(','), `--upgrade-path=${upgradeUtil}`, '-d', copy, '-u', 'odt_vd_script', '--stop-after-init', '--no-http'])`. Assert its output mentions `end-update_views` (Odoo logs each migration script it runs; if the wording differs on a version, assert on the database instead and note it).
7. **Assert the fix came back:**
   - fixed view: `active = true` and `arch_db::text LIKE '%ODT fixed%'`;
   - Studio view: `active = true` and `arch_db::text LIKE '%ODT studio fixed%'`;
   - re-enabled view: `active = true`;
   - `SELECT latest_version FROM ir_module_module WHERE name = 'odt_vd_script'` is `1.0.1`.
8. **Teardown:** dispose the pool, `dropDatabaseIfExists(copy)`, remove the temp folders.

- [ ] **Step 2: Verify it is skipped without the variables**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Upgrade script against a real Odoo"` — Expected: pending (skipped), no failure.

- [ ] **Step 3: Run it for real on at least one version**

The `ODT_VIEW_TEST_DB` base databases were dropped at the last handover. Rebuild one per version with the command in `docs/superpowers/notes/2026-10-05-view-doctor-handover.md` §5 (read it), then run, outside the sandbox:

```bash
env -u ELECTRON_RUN_AS_NODE ODT_VIEW_TEST_PYTHON=<venv python> ODT_VIEW_TEST_ODOO=<odoo checkout> ODT_VIEW_TEST_DB=<base db> \
  ODT_VIEW_TEST_UPGRADE_UTIL=/home/odoo/Dev/upgrade-util/src npx vscode-test --grep "Upgrade script against a real Odoo"
```

Expected: pass. If you can only run one version in this task, run 18.0; the controller runs 17 and 19 in Task 10. Do **not** modify `venv-15.0` or `venv-16.0`. Drop any `odt_*` databases you created when done (`psql -l | grep odt_`).

If the real run disagrees with the generator (for example `edit_view` rejecting a call, or the end- script not running), that is a defect in Tasks 3-6: report it with the Odoo log, do not paper over it in the test.

- [ ] **Step 4: Commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist
git add src/test/upgradeScript.integration.test.ts
git commit -m "[ADD] Check generated upgrade scripts against a real Odoo upgrade

A module view, a view with no external id and a view that was only turned
off are fixed through the extension, scripted into the module's
migrations/1.0.1/, broken again, and brought back by -u with upgrade-util on
the upgrade path. Skipped unless the ODT_VIEW_TEST_* variables and
ODT_VIEW_TEST_UPGRADE_UTIL are set.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Docs and the build

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Added`)
- Modify: `README.md` ("Disabled views (View Doctor)" section)
- Modify: `dist/` (rebuilt)

- [ ] **Step 1: CHANGELOG** — add after the "Render a view in Odoo" bullet:

```markdown
- **Upgrade scripts from the views you fixed.** Create Upgrade Script, on the Views title, writes one `upgrade-util` script for every view the upgrade disabled that is on again, and every view you saved or turned on here; Add to Upgrade Script, on a view's right-click menu, adds one view. Pick a module and a version folder — the script goes to `migrations/<version>/end-update_views.py`, and is added to when it is already there — or open it in an untitled editor. A view whose arch was never edited is only turned back on; the others get their arch back. What was left out is listed, and the module's version is offered a bump when Odoo would otherwise skip the folder. The Views tree now also shows the views you changed, under Edited here.
```

- [ ] **Step 2: README** — at the end of the "Disabled views (View Doctor)" section, add:

```markdown
**Create Upgrade Script** (on the Views title) turns your fixes into an `upgrade-util` script, so the next upgrade of the original database does them for you. It covers every view the upgrade disabled that is on again, and every view you saved or turned on from VS Code (listed under **Edited here**). **Add to Upgrade Script** (right-click an active view) adds just that view. Choose one of the project's modules and a version folder — prefilled with the module's version one patch up — or an untitled editor. The script is written to `migrations/<version>/end-update_views.py`; when that file is already there, the new views are added to it, and a file you changed by hand is never overwritten (a numbered file is written next to it instead). Odoo runs the folder only once the module's version reaches it, so the extension offers to set the version in `__manifest__.py`. Nothing is committed for you.

Each view is put back by external id, or by database id when it has none (the script says so: that id only holds in that database). A view whose arch was never edited is only turned back on; the others get their whole arch back, through `util.edit_view`. Views still off, deleted, or fixed before the extension first saw them off are left out, and the message says how many. The script needs [upgrade-util](https://github.com/odoo/upgrade-util) on the upgrade path (`--upgrade-path=<upgrade-util>/src`).

What the upgrade disabled is noted the first time the Views tree lists it, per database, on this machine only.
```

- [ ] **Step 3: Rebuild and verify everything**

```bash
npx tsc -p . --noEmit && npm run lint && npm run compile
```

Then, outside the sandbox: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npm test` — Expected: all passing, the integration suites pending. **Do not** `git checkout -- dist` this time; the commit ships it. Make sure `npm run compile` ran last (after the test run) so `dist/` is the production build.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md dist
git commit -m "[DOC] Describe upgrade scripts from the View Doctor; rebuild

Create Upgrade Script and Add to Upgrade Script in the changelog and in the
README's View Doctor section: what goes in, where it is written, how files
are merged and never overwritten, and that upgrade-util must be on the
upgrade path.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Verification by the controller (no code unless a defect is found)

Run by the controller, not an implementer subagent.

- [ ] **Step 1:** Run Task 8's integration test on 17.0, 18.0 and 19.0 (rebuild each base DB per the stage 1 handover §5; drop every `odt_*` database afterwards). Also run `viewWorker.integration.test.ts` on one version, since `doctorGroups` changed.
- [ ] **Step 2:** Live check in the real window (memory `odoo-debugger-verification.md`, Xvfb recipe; the stage 2 scratch HOME and fixture at `/tmp/claude/odt2` can be reused): the Views title shows the Create Upgrade Script icon; an active row's right-click shows Add to Upgrade Script and an inactive row's does not; saving an arch adds the view under Edited here; Create Upgrade Script → a module → the prefilled version writes `migrations/<v>/end-update_views.py`, opens it, and offers Set Version; a second Add to the same folder merges into the same file.
- [ ] **Step 3:** Final whole-branch review on the most capable model (`git diff f586ca7..HEAD`), against the spec §5, this plan's Global Constraints and Review Focus. Fix what it confirms, each fix with its own commit and, where it ships behaviour, a rebuilt `dist/`.
- [ ] **Step 4:** Update the memory `v1-5-view-doctor.md` (stage 3 done, commits, new traps) and its MEMORY.md line. Do not merge or push.

---

## Execution record (2026-10-05)

Done: commits 56bfcf8..8eea383 on v-1.5. 768 passing, 19 pending; the gated real-Odoo test passed on 17.0, 18.0 and 19.0; a live window check passed 7/7 (Edited here, Create into a module with the 19.0.1.0.1 prefill and Set Version, Add merging into the same file, Untitled, a hand-edited file left alone with a `_2` sibling written).

### Rulings made while executing

- Ruling: the round-1 re-review was a controller check (git diff 8ab975e 56bfcf8 empty, trailer grep) instead of a reviewer dispatch — a message-only amend has no code to review — cost if wrong: none.
- Ruling: reviewer's Minor #1 (lone \r makes parseScript disagree with Python, so a merge can drop a hand-added entry) enters the fix loop — it breaks the Global Constraint "never overwrite a script file the extension cannot parse back exactly" and Task 6 relies on parseScript — cost if wrong: one small fix round.
- Ruling: when the series is known, version folders must be the full form <series>.x.y or <series>.x.y.z (isVersionFolder(v, series)); fullVersion = adapt_version; needsManifestBump compares full forms and is false when the series is unknown; withSeries removed — a ≥3-dot folder is compared in full by every Odoo (verified convert_version 16/17/19 and adapt_version 17/19 in /home/odoo/odoo-dev) and is always a valid manifest version — cost if wrong: users cannot type a short folder like 1.0.1 (it worked on 17+).
- Ruling: Task 7's brief is amended accordingly: versionPrefill takes the series and prefills bumpVersion(fullVersion(manifest ?? '1.0', series)) (bumpVersion(manifest) when no series); the InputBox validates isVersionFolder(input, series); normalizeDestination validates with isVersionFolder(version) (no series) — the plan code predates the rule — cost if wrong: none.
- Ruling: Task 8 keeps manifest 1.0.0 → folder 1.0.1: on 17-19 that folder is majorless and still runs (installed[2:] 1.0.0 < 1.0.1 <= 1.0.1), so it tests the generated script, not the picker — cost if wrong: Task 8 fails on a version where that differs, and we switch it to the full form.
- Ruling: fold review Minors #2 (core/enterprise roots not normalizePath'd, so relative settings disable the filter; designThemesPath not excluded) and #3 (post-write errors reported as "could not create") into fix round 1 — #2 guards the Global Constraint "never offer core or enterprise", both touch the same lines — cost if wrong: a slightly larger fix diff.
- Ruling: Task 9 (docs copied verbatim from the plan + rebuilt dist) reviewed by the controller (diff read, tree clean) instead of a reviewer dispatch; the final whole-branch review covers the text — cost if wrong: a wording issue caught later.
- Ruling: final fix wave takes Important 1 plus Minors 3 (say why a numbered sibling was written), 5 (module discovery failure must not block the Untitled option), 7 (README: after Set Version, -u needs upgrade-util on the upgrade path), 8 (CHANGELOG: Create covers views seen while still off, not every re-enabled view), 9 (no bare separator) — all cheap and user-facing — cost if wrong: none.
- Ruling: Minor 2 (ruff format at 88 columns wraps the 118-column edit_view line, so the file stops parsing back) is not fixed: generated lines stay within upgrade-specific's 120-column limit, which is the corpus odoo-manager targeted; a reformatted file only means later Adds go to a numbered sibling, nothing is lost — cost if wrong: users with an 88-column ruff hook get end-update_views_2.py on the next Add.
- Ruling: Minors 4 (Turn On waits for bookkeeping so the refresh shows the journal), 6 (unknown series accepts 4-5-part folders; master only) stay; all other deferred minors stay per the final review's triage.
- Final: parked — manifest regex can still match a 'version': '<x>' inside an earlier string on the same line, and a '#' inside a string before the key on the same line hides it — Ruling: stays; keys sit one per line in real manifests — cost if wrong: Set Version inserts or edits the wrong spot in an odd manifest.

### Minors left as they are

- Task 1: updatedAt never set by buildNote (Task 4 service sets it)
- Task 1: load() turns EACCES into an empty note, which a later write would overwrite; treat only ENOENT/parse errors as empty
- Task 1: per-process queue only; installed build + F5 sandbox could lose a cross-process read-modify-write; queue map never pruned
- Task 1: temp name pid.Date.now() could collide outside update(); baselined counts null hashes (mirrors Python); no dedupe of hand-edited ids; no test for save temp cleanup / written:null
- Task 2: getDatabaseUuid has no unit test (query literal inline); parseFingerprints type-guard branches untested
- Task 3: id-addressed entry key `id:<n>` has no database, so ids from two databases collide in one module folder; a view keyed by id then by xmlid gets two entries (planning ruling: accepted)
- Task 3: keyOfLiteral uses JSON.parse, which differs from Python for hand-edited escapes like "\/"; no Number.isInteger guard on view.id in scriptEntry; NUL in name/arch makes Python refuse to compile (PostgreSQL text cannot hold NUL)
- Task 4: each tree load adds 1-3 sequential psql calls (uuid always read in observe; journal rows after observe)
- Task 4: a noted view deleted before it got a baseline keeps archMd5 undefined forever, so every tree load re-queries fingerprints (fix: baseline marks a missing fp as null when the map is readable)
- Task 4: a note written while the uuid is unreadable has no stamp; untested: doctorGroups surviving a throwing observe, observe with an unreadable uuid
- Task 5: ScriptSources.fingerprints contract should say "undefined on failure, never throw"; arches read sequentially
- Task 6: setManifestVersion's insert goes after the first `{` even inside a header comment; a non-literal 'version' value is missed; comment lines are skipped since 8eea383, but a 'version': '<x>' inside an earlier string still matches
- Task 6: CRLF manifest gets an LF line; merged CRLF script rewritten as LF; rename replaces a symlinked script and drops its mode; read→rename race window; EEXIST race surfaces as a raw error
- Task 6: needsManifestBump('18.0.1.0.1','18.0.1.0.2','18.0') not asserted; needsManifestBump can't tell "no bump" from "cannot judge" (unknown series)
- Task 7: "last used" label can show a version invalid for this database's series (prefill correctly refuses it); remembered destination saved before the write
- Task 7: a showTextDocument error after the write still reads "Could not create the upgrade script"; the interactive flow is untested until Task 10's live check
- Task 8: re-enabled view's ACTIVATE-only shape asserted on the build object, not on the written script/final arch; teardown not try/finally; latest_version regex could instead compare before/after
