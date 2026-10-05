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
