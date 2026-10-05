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
