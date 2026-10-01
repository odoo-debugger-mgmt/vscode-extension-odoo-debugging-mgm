/**
 * A window moved to another data store and back gets its selection and its
 * binding back (sixteenth run).
 */
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { restoreForStore, stashForStore } from '../services/storeSwitch';
import { SELECTION_STATE_KEY } from '../services/workspaceSelection';
import { BINDING_STATE_KEY } from '../services/workspaceBinding';

function memento(): vscode.Memento {
    const values = new Map<string, unknown>();
    return {
        keys: () => [...values.keys()],
        get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback),
        update: async (key: string, value: unknown) => {
            if (value === undefined) {
                values.delete(key);
            } else {
                values.set(key, value);
            }
        }
    } as vscode.Memento;
}

suite('Switching data stores', () => {
    test('to the workspace\'s own file and back keeps the selection and the binding', async () => {
        const state = memento();
        const shared = { selectedProjectUid: 'acme', selectedDbByProject: { acme: 'acme-db2' } };
        await state.update(SELECTION_STATE_KEY, shared);
        await state.update(BINDING_STATE_KEY, { versionId: 'ver-17-0001', asked: true });

        await stashForStore(state, '/shared.db');
        await restoreForStore(state, '/ws/.vscode/odoo-debugger-data.json');
        assert.deepStrictEqual(state.get(SELECTION_STATE_KEY), shared, 'a store never used reconciles the current selection');
        assert.strictEqual(state.get(BINDING_STATE_KEY), undefined, 'no binding in a store it was never made in');

        await state.update(SELECTION_STATE_KEY, { selectedDbByProject: {} });
        await stashForStore(state, '/ws/.vscode/odoo-debugger-data.json');
        await restoreForStore(state, '/shared.db');
        assert.deepStrictEqual(state.get(SELECTION_STATE_KEY), shared);
        assert.deepStrictEqual(state.get(BINDING_STATE_KEY), { versionId: 'ver-17-0001', asked: true });
    });
});
