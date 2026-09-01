import * as assert from 'assert';
import { applyBranchNameMigration } from '../services/dataMigration';

function buildData(dbs: any[]) {
    return { projects: [{ name: 'p', dbs }], versions: {} } as any;
}

suite('branchName migration', () => {
    test('drops branchName when the database has a version', () => {
        // The version is authoritative; the copy is what drifted.
        const data = buildData([{ id: 'shop-19', versionId: 'v19', branchName: '17.0' }]);
        const result = applyBranchNameMigration(data);
        assert.strictEqual(result.changed, true);
        assert.strictEqual('branchName' in data.projects[0].dbs[0], false);
        assert.strictEqual(result.preserved, 0);
    });

    test('folds branchName into odooVersion when there is no version', () => {
        // Unmigrated data still needs a series from somewhere.
        const data = buildData([{ id: 'legacy', branchName: '16.0' }]);
        const result = applyBranchNameMigration(data);
        assert.strictEqual(data.projects[0].dbs[0].odooVersion, '16.0');
        assert.strictEqual('branchName' in data.projects[0].dbs[0], false);
        assert.strictEqual(result.preserved, 1);
    });

    test('does not overwrite an existing odooVersion', () => {
        const data = buildData([{ id: 'legacy', branchName: '16.0', odooVersion: '15.0' }]);
        applyBranchNameMigration(data);
        assert.strictEqual(data.projects[0].dbs[0].odooVersion, '15.0');
    });

    test('reports no change for already-migrated data', () => {
        const data = buildData([{ id: 'shop-19', versionId: 'v19' }]);
        assert.strictEqual(applyBranchNameMigration(data).changed, false);
    });

    test('handles a project with no databases', () => {
        assert.strictEqual(applyBranchNameMigration({ projects: [{ name: 'p' }] } as any).changed, false);
    });
});
