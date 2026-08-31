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

    test('drops pre-checkout commands rather than moving them, and reports them', () => {
        const data = buildData({
            v1: {
                id: 'v1',
                name: '17.0',
                settings: { preCheckoutCommands: ['git restore .'], postCheckoutCommands: ['npm install'] }
            }
        });

        const result = applyHookMigration(data);
        // A pre-checkout guard is not equivalent to a post-switch command:
        // running `git restore .` after the switch discards work instead of
        // clearing the way for a checkout.
        assert.deepStrictEqual(data.versions.v1.settings.postSwitchCommands, ['npm install']);
        assert.strictEqual('preCheckoutCommands' in data.versions.v1.settings, false);
        assert.deepStrictEqual(result.droppedCommands, ['git restore .']);
    });

    test('drops empty legacy arrays without reporting anything dropped', () => {
        const data = buildData({
            v1: { id: 'v1', name: '17.0', settings: { preCheckoutCommands: [], postCheckoutCommands: [] } }
        });

        const result = applyHookMigration(data);
        assert.strictEqual(result.changed, true);
        assert.deepStrictEqual(data.versions.v1.settings.postSwitchCommands, []);
        assert.deepStrictEqual(result.droppedCommands, []);
    });

    test('deduplicates dropped commands reported across versions', () => {
        const data = buildData({
            v1: { id: 'v1', name: '17.0', settings: { preCheckoutCommands: ['git restore .'] } },
            v2: { id: 'v2', name: '18.0', settings: { preCheckoutCommands: ['git restore .', 'echo hi'] } }
        });

        assert.deepStrictEqual(applyHookMigration(data).droppedCommands, ['git restore .', 'echo hi']);
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
