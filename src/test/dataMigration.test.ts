import * as assert from 'assert';
import { applyDatabaseFieldMigration, collectLegacyBranchesNeedingVersions } from '../services/dataMigration';

function buildData(dbs: any[], versions: Record<string, any> = {}) {
    return {
        projects: [{ name: 'p', dbs }] as any,
        versions
    };
}

suite('Debugger data migration', () => {
    test('links legacy odooVersion to a matching version profile', () => {
        const data = buildData(
            [{ id: 'db1', odooVersion: '17.0', branchName: '' }],
            { v1: { id: 'v1', odooVersion: '17.0' } }
        );

        assert.strictEqual(applyDatabaseFieldMigration(data), true);
        const db = (data.projects[0] as any).dbs[0];
        assert.strictEqual(db.versionId, 'v1');
        assert.strictEqual('odooVersion' in db, false);
    });

    test('falls back to branchName when no version matches', () => {
        const data = buildData([{ id: 'db1', odooVersion: 'saas-17.4', branchName: '' }]);

        assert.strictEqual(applyDatabaseFieldMigration(data), true);
        const db = (data.projects[0] as any).dbs[0];
        assert.strictEqual(db.versionId, undefined);
        assert.strictEqual(db.branchName, 'saas-17.4');
        assert.strictEqual('odooVersion' in db, false);
    });

    test('keeps an existing versionId and branchName untouched', () => {
        const data = buildData(
            [{ id: 'db1', odooVersion: '16.0', branchName: 'custom-label', versionId: 'v9' }],
            { v1: { id: 'v1', odooVersion: '16.0' } }
        );

        assert.strictEqual(applyDatabaseFieldMigration(data), true);
        const db = (data.projects[0] as any).dbs[0];
        assert.strictEqual(db.versionId, 'v9');
        assert.strictEqual(db.branchName, 'custom-label');
        assert.strictEqual('odooVersion' in db, false);
    });

    test('reports no change for already-migrated data', () => {
        const data = buildData([{ id: 'db1', branchName: '17.0', versionId: 'v1' }]);
        assert.strictEqual(applyDatabaseFieldMigration(data), false);
    });

    test('drops empty legacy fields', () => {
        const data = buildData([{ id: 'db1', odooVersion: '', branchName: '' }]);
        assert.strictEqual(applyDatabaseFieldMigration(data), true);
        assert.strictEqual('odooVersion' in (data.projects[0] as any).dbs[0], false);
    });

    test('collects series-like legacy branches that need version profiles', () => {
        const data = buildData(
            [
                { id: 'db1', odooVersion: '16.0' },
                { id: 'db2', odooVersion: 'saas-17.4' },
                { id: 'db3', odooVersion: 'master' },
                { id: 'db4', odooVersion: 'random-label' },
                { id: 'db5', odooVersion: '17.0' },
                { id: 'db6', odooVersion: '16.0', versionId: 'v9' }
            ],
            { v1: { id: 'v1', odooVersion: '17.0' } }
        );

        const branches = collectLegacyBranchesNeedingVersions(data).sort();
        assert.deepStrictEqual(branches, ['16.0', 'master', 'saas-17.4']);
    });
});
