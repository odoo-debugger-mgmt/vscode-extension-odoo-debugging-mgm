import * as assert from 'assert';
import { findViewItems, nothingMatches, viewPickItems, viewTree } from '../views/viewPicker';
import type { ViewRow } from '../services/views/viewQueries';

function row(id: number, inheritId: number | null, overrides: Partial<ViewRow> = {}): ViewRow {
    return { id, name: `v${id}`, model: 'res.partner', type: 'form', active: true, inheritId, xmlid: null, rootId: id, isReport: false, writeDate: 0, ...overrides };
}

suite('View pickers', () => {
    test('base views first, each inheriting view under its parent', () => {
        const rows = [row(30, 10), row(10, null, { type: 'form' }), row(20, null, { type: 'list', name: 'a list' }), row(31, 30), row(11, 10), row(50, 999)];
        assert.deepStrictEqual(viewTree(rows).map(entry => [entry.view.id, entry.depth]), [
            [10, 0], [11, 1], [30, 1], [31, 2],
            [20, 0],
            [50, 0]
        ]);
    });

    test('a cycle is listed, not lost or looped', () => {
        assert.deepStrictEqual(viewTree([row(1, 2), row(2, 1)]).map(entry => entry.view.id).sort(), [1, 2]);
    });

    test('labels indent, mark inactive views, and describe model, type and external id', () => {
        const items = viewPickItems(viewTree([row(10, null, { xmlid: 'base.f' }), row(11, 10, { active: false }), row(12, 11)]));
        assert.deepStrictEqual(items.map(item => item.label), ['$(pass) v10', '↳ $(circle-slash) v11', '\u2003↳ $(pass) v12']);
        assert.deepStrictEqual(items.map(item => item.description), ['res.partner · form · base.f', 'res.partner · form · #11', 'res.partner · form · #12']);
        assert.strictEqual(viewPickItems(viewTree([row(5, null, { model: '', type: 'qweb' })]))[0].description, 'qweb · #5');
    });

    test('Find View: a number is an id, module.name an external id, the rest a model', () => {
        const models = [{ model: 'res.partner', count: 40 }, { model: 'sale.order', count: 1 }];
        assert.deepStrictEqual(findViewItems('', models).map(item => item.choice), [{ kind: 'model', model: 'res.partner' }, { kind: 'model', model: 'sale.order' }]);
        assert.deepStrictEqual(findViewItems(' 42 ', models)[0], { label: '$(symbol-number) View 42', alwaysShow: true, choice: { kind: 'id', id: 42 } });
        assert.deepStrictEqual(findViewItems('sale.view_order_form', models)[0].choice, { kind: 'xmlid', xmlid: 'sale.view_order_form' });
        assert.strictEqual(findViewItems('sale.view_order_form', models)[0].alwaysShow, true);
        assert.deepStrictEqual(findViewItems('sale.order', models).map(item => item.choice.kind), ['model', 'model'], 'a model is not offered as an external id');
        assert.deepStrictEqual(findViewItems('0', models).map(item => item.choice.kind), ['model', 'model']);
        assert.strictEqual(findViewItems('', models)[1].description, '1 view');
        assert.strictEqual(nothingMatches('shop-18', ' foo.bar? '), "Nothing matches 'foo.bar?' in shop-18.");
        assert.strictEqual(nothingMatches('shop-18', '  '), undefined, 'Enter on an empty pick closes it silently');
    });
});
