import * as assert from 'assert';
import { argValue, describeSession, ALONGSIDE_MARKER } from '../services/runRecords';
import { instancesFromRuns } from '../services/runningState';

const versions = [
    { id: 'v17', createdAt: '2026-01-01', settings: { debuggerName: 'odoo:17.0', portNumber: 8017 } },
    { id: 'v18', createdAt: '2026-02-01', settings: { debuggerName: 'Odoo', portNumber: 8018 } },
    { id: 'v18b', createdAt: '2026-03-01', settings: { debuggerName: 'Odoo', portNumber: 8028 } }
];

suite('Run records', () => {
    test('argValue reads the token after the first flag', () => {
        assert.strictEqual(argValue(['-p', '8017', '-d', 'shop', '-d', 'later'], '-d'), 'shop');
        assert.strictEqual(argValue(['-p'], '-p'), undefined);
        assert.strictEqual(argValue([], '-d'), undefined);
    });

    test('a primary entry is its version, database and port from its own args', () => {
        const details = describeSession(
            { name: 'odoo:17.0', args: ['-p', '8017', '--addons-path', 'x', '-d', 'shop'] },
            versions, 'v18'
        );
        assert.deepStrictEqual(details, { versionId: 'v17', dbId: 'shop', port: 8017, kind: 'primary' });
    });

    test('a shared name belongs to the active version among those sharing it', () => {
        assert.strictEqual(describeSession({ name: 'Odoo', args: ['-d', 'a'] }, versions, 'v18b')?.versionId, 'v18b');
        assert.strictEqual(describeSession({ name: 'Odoo', args: ['-d', 'a'] }, versions, 'v17')?.versionId, 'v18');
    });

    test('a primary entry without -p falls back to its version port', () => {
        assert.strictEqual(describeSession({ name: 'odoo:17.0', args: ['-d', 'shop'] }, versions, undefined)?.port, 8017);
    });

    test('an alongside run is read from its marker, whatever its name', () => {
        const details = describeSession({
            name: 'odoo:17.0 · demo',
            args: ['-p', '8100', '-d', 'demo'],
            [ALONGSIDE_MARKER]: { versionId: 'v17', dbId: 'demo', port: 8100, kind: 'alongside' }
        }, versions, undefined);
        assert.deepStrictEqual(details, { versionId: 'v17', dbId: 'demo', port: 8100, kind: 'alongside' });
    });

    test('an unknown name or a malformed config is not ours', () => {
        assert.strictEqual(describeSession({ name: 'Python: Current File' }, versions, 'v17'), undefined);
        assert.strictEqual(describeSession(undefined, versions, 'v17'), undefined);
        assert.strictEqual(describeSession({ name: 'x', [ALONGSIDE_MARKER]: { dbId: 'no version' } }, versions, 'v17'), undefined);
    });

    test('running instances come from the records, one per database run', () => {
        const instances = instancesFromRuns([
            { name: 'odoo:17.0', versionId: 'v17', dbId: 'shop', port: 8017, kind: 'primary' },
            { name: 'odoo:17.0 · demo', versionId: 'v17', dbId: 'demo', port: 8100, kind: 'alongside' },
            { name: 'stray', versionId: 'v17', kind: 'primary' }
        ]);
        assert.deepStrictEqual(instances.map(i => [i.dbName, i.port, i.kind, i.origin, i.debuggerName]), [
            ['shop', 8017, 'primary', 'managed', 'odoo:17.0'],
            ['demo', 8100, 'alongside', 'managed', 'odoo:17.0 · demo']
        ]);
    });
});
