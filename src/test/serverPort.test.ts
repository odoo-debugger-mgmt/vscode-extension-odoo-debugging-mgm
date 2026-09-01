import * as assert from 'assert';
import { pickPortForDatabase, PortCandidateVersion } from '../services/server';
import { RunningInstance } from '../services/runningState';

const VERSIONS: PortCandidateVersion[] = [
    { id: 'v17', name: 'Odoo 17.0', portNumber: 8017 },
    { id: 'v18', name: 'Odoo 18.0', portNumber: 8018 }
];

const ACTIVE_PORT = 8018;

suite('Server port resolution', () => {
    test('prefers the port of the session actually serving the database', () => {
        const running: RunningInstance[] = [
            { versionId: 'v17', debuggerName: 'odoo:17.0', dbName: 'shop-17', port: 8017, origin: 'managed' }
        ];
        // The active version is 18.0, but shop-17 is being served by 17.0.
        assert.deepStrictEqual(pickPortForDatabase('shop-17', running, VERSIONS, 'v17', ACTIVE_PORT), {
            port: 8017,
            source: 'running',
            versionName: 'Odoo 17.0'
        });
    });

    test('falls back to the port of the version the database belongs to', () => {
        assert.deepStrictEqual(pickPortForDatabase('shop-17', [], VERSIONS, 'v17', ACTIVE_PORT), {
            port: 8017,
            source: 'version',
            versionName: 'Odoo 17.0'
        });
    });

    test('falls back to the active version when the database has no version', () => {
        assert.deepStrictEqual(pickPortForDatabase('orphan', [], VERSIONS, undefined, ACTIVE_PORT), {
            port: 8018,
            source: 'active'
        });
    });

    test('ignores an external instance that reports no port', () => {
        const running: RunningInstance[] = [{ dbName: 'shop-17', origin: 'external' }];
        // pg_stat_activity knows the database is live but not which port; the
        // database's own version is the better answer.
        assert.deepStrictEqual(pickPortForDatabase('shop-17', running, VERSIONS, 'v17', ACTIVE_PORT), {
            port: 8017,
            source: 'version',
            versionName: 'Odoo 17.0'
        });
    });

    test('ignores a running instance for a different database', () => {
        const running: RunningInstance[] = [
            { versionId: 'v17', dbName: 'other', port: 8017, origin: 'managed' }
        ];
        assert.deepStrictEqual(pickPortForDatabase('shop-18', running, VERSIONS, 'v18', ACTIVE_PORT), {
            port: 8018,
            source: 'version',
            versionName: 'Odoo 18.0'
        });
    });

    test('falls back to the active port when the owning version has none', () => {
        const versions: PortCandidateVersion[] = [{ id: 'v17', name: 'Odoo 17.0' }];
        assert.deepStrictEqual(pickPortForDatabase('shop-17', [], versions, 'v17', ACTIVE_PORT), {
            port: 8018,
            source: 'active'
        });
    });

    test('resolves without a database name at all', () => {
        assert.deepStrictEqual(pickPortForDatabase(undefined, [], VERSIONS, undefined, ACTIVE_PORT), {
            port: 8018,
            source: 'active'
        });
    });
});
