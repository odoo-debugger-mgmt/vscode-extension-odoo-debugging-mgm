import * as assert from 'assert';
import * as vscode from 'vscode';
import { ViewItem } from '../views/viewDoctorView';
import { viewTarget } from '../views/viewTarget';
import { viewUri } from '../views/viewFileSystem';
import type { ViewRow } from '../services/views/viewQueries';

const row: ViewRow = { id: 12, name: 'Partner patch', model: 'res.partner', type: 'form', active: false, inheritId: 7, xmlid: 'acme.patch', rootId: 3, isReport: false, writeDate: 0 };

suite('View target', () => {
    test('a tree row is used as is', async () => {
        const reads: number[] = [];
        const target = await viewTarget(new ViewItem('shop', row, 'other'), async (_db, ids) => { reads.push(...ids); return []; });
        assert.deepStrictEqual(target, { dbName: 'shop', view: row });
        assert.deepStrictEqual(reads, [], 'a row needs no query');
    });

    test('an odoo-view URI, as an editor title passes it, is read from its database', async () => {
        const target = await viewTarget(viewUri('shop 18', 12, 'acme.patch'), async (db, ids) => db === 'shop 18' && ids[0] === 12 ? [row] : []);
        assert.deepStrictEqual(target, { dbName: 'shop 18', view: row });
    });

    test('with nothing passed, the active editor\'s view', async () => {
        const target = await viewTarget(undefined, async () => [row], () => viewUri('shop', 12, 'x'));
        assert.strictEqual(target?.view.id, 12);
        assert.strictEqual(await viewTarget(undefined, async () => [row], () => vscode.Uri.file('/tmp/a.xml')), undefined);
        assert.strictEqual(await viewTarget(undefined, async () => [row], () => undefined), undefined);
    });

    test('a view that is gone says so', async () => {
        await assert.rejects(viewTarget(viewUri('shop', 99, 'x'), async () => []), /View 99 no longer exists in shop\./);
    });
});
