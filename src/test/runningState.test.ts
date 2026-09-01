import * as assert from 'assert';
import { mergeRunningInstances, RunningInstance } from '../services/runningState';

const managed: RunningInstance = {
    versionId: 'v17',
    debuggerName: 'odoo:17.0',
    dbName: 'shop-17',
    port: 8017,
    origin: 'managed'
};

suite('Running state', () => {
    test('managed instances win over an external report of the same database', () => {
        const merged = mergeRunningInstances(
            [managed],
            [{ dbName: 'shop-17', origin: 'external' }]
        );
        assert.strictEqual(merged.length, 1);
        assert.deepStrictEqual(merged[0], managed);
    });

    test('keeps external instances the extension did not start', () => {
        const merged = mergeRunningInstances(
            [managed],
            [{ dbName: 'shop-17', origin: 'external' }, { dbName: 'shop-18', origin: 'external' }]
        );
        assert.deepStrictEqual(
            merged.map((entry: RunningInstance) => [entry.dbName, entry.origin]).sort(),
            [['shop-17', 'managed'], ['shop-18', 'external']]
        );
    });

    test('deduplicates repeated managed entries for one database', () => {
        const merged = mergeRunningInstances([managed, managed], []);
        assert.strictEqual(merged.length, 1);
    });

    test('returns an empty list when nothing is running', () => {
        assert.deepStrictEqual(mergeRunningInstances([], []), []);
    });
});
