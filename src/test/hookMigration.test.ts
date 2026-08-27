import * as assert from 'assert';
import { applyHookMigration } from '../services/dataMigration';

function buildData(versions: Record<string, any>) {
    return { projects: [], versions } as any;
}

suite('Hook migration', () => {
    test('renames postCheckoutCommands and preserves the values', () => {
        const data = buildData({
            v1: { id: 'v1', name: '17.0', settings: { postCheckoutCommands: ['npm install'] } }
        });

        const result = applyHookMigration(data);
        assert.strictEqual(result.changed, true);
        const settings = data.versions.v1.settings;
        assert.deepStrictEqual(settings.postSwitchCommands, ['npm install']);
        assert.strictEqual('postCheckoutCommands' in settings, false);
    });

    test('prepends pre-checkout commands and reports the version', () => {
        const data = buildData({
            v1: {
                id: 'v1',
                name: '17.0',
                settings: { preCheckoutCommands: ['git stash'], postCheckoutCommands: ['npm install'] }
            }
        });

        const result = applyHookMigration(data);
        assert.deepStrictEqual(data.versions.v1.settings.postSwitchCommands, ['git stash', 'npm install']);
        assert.strictEqual('preCheckoutCommands' in data.versions.v1.settings, false);
        assert.deepStrictEqual(result.prependedVersionNames, ['17.0']);
    });

    test('drops empty legacy arrays without reporting a prepend', () => {
        const data = buildData({
            v1: { id: 'v1', name: '17.0', settings: { preCheckoutCommands: [], postCheckoutCommands: [] } }
        });

        const result = applyHookMigration(data);
        assert.strictEqual(result.changed, true);
        assert.deepStrictEqual(data.versions.v1.settings.postSwitchCommands, []);
        assert.deepStrictEqual(result.prependedVersionNames, []);
    });

    test('reports no change for already-migrated data', () => {
        const data = buildData({
            v1: { id: 'v1', name: '17.0', settings: { postSwitchCommands: ['npm install'] } }
        });

        assert.strictEqual(applyHookMigration(data).changed, false);
    });

    test('handles a version with no settings object', () => {
        const data = buildData({ v1: { id: 'v1', name: '17.0' } });
        assert.strictEqual(applyHookMigration(data).changed, false);
    });
});
