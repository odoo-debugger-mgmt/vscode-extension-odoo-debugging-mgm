import * as assert from 'assert';
import { matchView } from '../services/views/viewMatch';
import type { ViewRow } from '../services/views/viewQueries';

function row(id: number, overrides: Partial<ViewRow> = {}): ViewRow {
    return {
        id, name: `view ${id}`, model: 'res.partner', type: 'form', active: true,
        inheritId: 1, xmlid: null, rootId: 1, isReport: false, writeDate: 0, ...overrides
    };
}

suite('Matching a view across databases', () => {
    const source = row(40, { name: 'partner.custom', xmlid: 'acme.partner_custom' });

    test('the same external id wins over everything', () => {
        const byXmlid = row(77, { name: 'renamed', model: 'res.partner' });
        assert.deepStrictEqual(matchView(source, { byXmlid, rows: [row(40), byXmlid] }), { kind: 'xmlid', view: byXmlid });
    });

    test('then the same id, when its model and type agree', () => {
        const same = row(40, { name: 'whatever' });
        assert.deepStrictEqual(matchView(source, { rows: [row(41, { name: 'partner.custom' }), same] }), { kind: 'id', view: same });
        // Id 40 is another model's view in that database: not the same view.
        const other = row(40, { model: 'res.users' });
        assert.strictEqual(matchView(source, { rows: [other] }).kind, 'none');
    });

    test('a list view and its tree original are one type (18.0 renamed it)', () => {
        const list = row(40, { type: 'list', name: 'partner.list' });
        const sameId = row(40, { type: 'tree', name: 'old name' });
        assert.deepStrictEqual(matchView(list, { rows: [sameId] }), { kind: 'id', view: sameId });
        const named = row(52, { type: 'tree', name: 'partner.list' });
        assert.deepStrictEqual(matchView(list, { rows: [row(51, { type: 'tree' }), named] }), { kind: 'name', view: named });
        const back = row(40, { type: 'list' });
        assert.deepStrictEqual(matchView(sameId, { rows: [back] }), { kind: 'id', view: back });
        assert.strictEqual(matchView(row(40, { type: 'form' }), { rows: [sameId] }).kind, 'none');
    });

    test('then the one view with the same model, type and name', () => {
        const named = row(52, { name: 'partner.custom' });
        assert.deepStrictEqual(matchView(source, { rows: [row(51), named] }), { kind: 'name', view: named });
    });

    test('several namesakes, or none, go to a pick, namesakes and the same kind of view first', () => {
        const a = row(60, { name: 'partner.custom' });
        const b = row(61, { name: 'partner.custom' });
        const other = row(59);
        assert.deepStrictEqual(matchView(source, { rows: [b, other, a] }), { kind: 'pick', candidates: [a, b, other] });

        const base = row(70, { inheritId: null, rootId: 70 });
        const extension = row(71);
        const listView = row(72, { type: 'list' });
        assert.deepStrictEqual(matchView(source, { rows: [base, listView, extension] }), { kind: 'pick', candidates: [extension, base] });
    });

    test('nothing of that model and type means no match', () => {
        assert.deepStrictEqual(matchView(source, { rows: [row(80, { type: 'kanban' })] }), { kind: 'none' });
        assert.deepStrictEqual(matchView(source, { rows: [] }), { kind: 'none' });
    });
});
