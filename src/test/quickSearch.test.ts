import * as assert from 'assert';
import { databasesForVersion } from '../commands/quickSearch';

suite('Searching the databases of one version', () => {
    const rows = [
        { label: 'acme-db1', database: { versionId: 'v17' } },
        { label: 'acme-db19', database: { versionId: 'v19' } },
        { label: 'legacy', database: {} }
    ];

    test('only that version\'s databases, and legacy ones that still resolve for it', () => {
        // "No database is selected for 19.0" is not answered by a 17.0 one.
        assert.deepStrictEqual(databasesForVersion(rows, 'v19').map(row => row.label), ['acme-db19', 'legacy']);
    });

    test('without a version, every database', () => {
        assert.strictEqual(databasesForVersion(rows, undefined).length, 3);
    });
});
