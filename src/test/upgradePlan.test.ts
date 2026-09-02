import * as assert from 'assert';
import { UpgradeInput, buildUpgradePlan, describeUpgradePlan } from '../services/upgradePlan';

const input = (overrides: Partial<UpgradeInput> = {}): UpgradeInput => ({
    repos: [{ name: 'psae-internal', path: '/src/psae-internal', fromBranch: '17.0-bunka', toBranch: '19.0-bunka' }],
    fromSeries: '17.0',
    toSeries: '19.0',
    existingVersions: [],
    dbs: [],
    versionIdBySeries: {},
    ...overrides
});

suite('Upgrade plan', () => {
    test('creates both versions when neither exists', () => {
        const plan = buildUpgradePlan(input());

        assert.deepStrictEqual(plan.versionsToCreate, ['17.0', '19.0']);
    });

    test('does not recreate a version that already exists', () => {
        const plan = buildUpgradePlan(input({ existingVersions: ['19.0'] }));

        assert.deepStrictEqual(plan.versionsToCreate, ['17.0']);
    });

    test('marks every named repository for per-branch copies', () => {
        const plan = buildUpgradePlan(input());

        assert.deepStrictEqual(plan.reposToWorktree, ['psae-internal']);
    });

    test('assigns each database the branch its version upgrades to', () => {
        const plan = buildUpgradePlan(input({
            existingVersions: ['17.0', '19.0'],
            versionIdBySeries: { '17.0': 'v17', '19.0': 'v19' },
            dbs: [{ id: 'crm-17', versionId: 'v17' }, { id: 'crm-19', versionId: 'v19' }]
        }));

        assert.deepStrictEqual(plan.assignments, [
            { dbId: 'crm-17', repoName: 'psae-internal', repoPath: '/src/psae-internal', branch: '17.0-bunka' },
            { dbId: 'crm-19', repoName: 'psae-internal', repoPath: '/src/psae-internal', branch: '19.0-bunka' }
        ]);
    });

    test('leaves databases on unrelated versions alone', () => {
        const plan = buildUpgradePlan(input({
            existingVersions: ['17.0', '19.0'],
            versionIdBySeries: { '17.0': 'v17', '19.0': 'v19' },
            dbs: [{ id: 'other', versionId: 'v18' }, { id: 'unassigned' }]
        }));

        assert.deepStrictEqual(plan.assignments, []);
    });

    test('the description names the versions, the repos and the mapping', () => {
        const built = input();
        const text = describeUpgradePlan(buildUpgradePlan(built), built);

        assert.ok(text.includes('17.0'));
        assert.ok(text.includes('19.0'));
        assert.ok(text.includes('psae-internal'));
        assert.ok(text.includes('one copy per branch'));
    });
});
