import * as assert from 'assert';
import * as vscode from 'vscode';
import { DbsTreeProvider, extractCheckpointFromEvent } from '../views/dbsView';
import { SortPreferences } from '../sortPreferences';
import type { DatabaseModel } from '../models/db';

function provider(): DbsTreeProvider {
    const memento = { get: () => undefined, update: async () => undefined, keys: () => [] } as unknown as vscode.Memento;
    return new DbsTreeProvider(new SortPreferences(memento));
}

const db = {
    id: 'shop', name: 'shop', isSelected: true, createdAt: new Date('2026-10-01T00:00:00Z'), modules: [],
    checkpoints: [
        { id: 'shop__cp_1', label: 'before fix', createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), filestore: true },
        { id: 'shop__cp_2', label: 'newer', createdAt: new Date(Date.now() - 60 * 1000).toISOString(), filestore: false }
    ]
} as unknown as DatabaseModel;

suite('Databases tree checkpoints', () => {
    test('a database row lists its checkpoints, newest first; a checkpoint row lists nothing', async () => {
        const tree = provider();
        tree.setCheckpointSizes(new Map([['shop__cp_1', 15 * 1024 * 1024]]));
        const rows = tree.checkpointRows(db);
        assert.deepStrictEqual(rows.map(row => row.label), ['newer', 'before fix']);
        assert.strictEqual(rows[1].contextValue, 'checkpoint');
        assert.strictEqual(rows[1].id, 'shop::checkpoint::shop__cp_1');
        assert.strictEqual(rows[1].description, '2 h ago • 15 MB');
        assert.strictEqual(rows[1].collapsibleState, vscode.TreeItemCollapsibleState.None);
        assert.ok((rows[1].iconPath as vscode.ThemeIcon).id === 'history');
        assert.deepStrictEqual(await tree.getChildren(rows[1]), [], 'no recursion into a checkpoint');
        const parsed = extractCheckpointFromEvent(rows[1]);
        assert.strictEqual(parsed?.checkpoint.id, 'shop__cp_1');
        assert.strictEqual(parsed?.database.id, 'shop');
    });

    test('a database with no checkpoints field (plain JSON from the store) has no rows', () => {
        const plain = { id: 'old', name: 'old', createdAt: new Date(), modules: [] } as unknown as DatabaseModel;
        assert.deepStrictEqual(provider().checkpointRows(plain), []);
    });

    test('getParent of a checkpoint row is its database row', async () => {
        const tree = provider();
        const parentRow = { id: 'shop', contextValue: 'database', database: db, label: 'shop', collapsibleState: 1 } as unknown as vscode.TreeItem;
        (tree as unknown as { rows: Map<string, vscode.TreeItem> }).rows.set('shop', parentRow);
        const [row] = tree.checkpointRows(db);
        assert.strictEqual(tree.getParent(row), parentRow);
        assert.strictEqual(tree.getParent(parentRow), undefined);
    });
});
