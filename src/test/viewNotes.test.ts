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
