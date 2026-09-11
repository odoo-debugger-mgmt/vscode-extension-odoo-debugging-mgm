import * as assert from 'assert';
import { UpgradeInput, buildUpgradePlan, describeUpgradePlan } from '../services/upgradePlan';

const input = (overrides: Partial<UpgradeInput> = {}): UpgradeInput => ({
    repos: [{ name: 'psae-internal', path: '/src/psae-internal', fromBranch: '17.0-bunka', toBranch: '19.0-bunka' }],
    fromSeries: '17.0',
    toSeries: '19.0',
    fromDbId: 'crm-17',
    toDbId: 'crm-19',
    existingVersions: [],
    ...overrides
});

suite('Upgrade plan', () => {
    test('creates both versions when neither exists', () => {
        assert.deepStrictEqual(buildUpgradePlan(input()).versionsToCreate, ['17.0', '19.0']);
    });

    test('does not recreate a version that already exists', () => {
        assert.deepStrictEqual(
            buildUpgradePlan(input({ existingVersions: ['19.0'] })).versionsToCreate,
            ['17.0']
        );
    });

    test('marks every named repository for per-branch copies', () => {
        assert.deepStrictEqual(buildUpgradePlan(input()).reposToWorktree, ['psae-internal']);
    });

    test('a repository already keeping copies is not asked to change again', () => {
        assert.deepStrictEqual(
            buildUpgradePlan(input({ worktreeRepos: ['PSAE-Internal'] })).reposToWorktree,
            []
        );
    });

    test('each database is assigned its own side of the upgrade', () => {
        assert.deepStrictEqual(buildUpgradePlan(input()).assignments, [
            { dbId: 'crm-17', repoName: 'psae-internal', repoPath: '/src/psae-internal', branch: '17.0-bunka' },
            { dbId: 'crm-19', repoName: 'psae-internal', repoPath: '/src/psae-internal', branch: '19.0-bunka' }
        ]);
    });

    test('the mapping is written even when neither version exists yet', () => {
        // The regression this rewrite exists for. Assignments used to be
        // discovered by matching each database's versionId against the two
        // series; on a first upgrade the target series has no version, so
        // nothing matched it and the target side was silently never mapped -
        // which is the common case, not an edge one.
        const plan = buildUpgradePlan(input({ existingVersions: [] }));

        assert.deepStrictEqual(plan.versionsToCreate, ['17.0', '19.0']);
        assert.strictEqual(plan.assignments.length, 2, 'the mapping was dropped for unbuilt versions');
        assert.deepStrictEqual(
            plan.assignments.map(entry => entry.dbId),
            ['crm-17', 'crm-19']
        );
    });

    test('names the copy directories when a root is given', () => {
        const plan = buildUpgradePlan(input({ root: '/home/dev/odoo-dev' }));

        assert.deepStrictEqual(plan.worktreeDirs, [
            '/home/dev/odoo-dev/psae-internal@17.0-bunka',
            '/home/dev/odoo-dev/psae-internal@19.0-bunka'
        ]);
    });

    test('a repository already keeping copies is not listed as about to get them', () => {
        // The confirmation says these directories "will be created"; listing a
        // repository's existing copies there was simply untrue.
        const plan = buildUpgradePlan(input({ root: '/home/dev/odoo-dev', worktreeRepos: ['psae-internal'] }));

        assert.deepStrictEqual(plan.reposToWorktree, []);
        assert.deepStrictEqual(plan.worktreeDirs, []);
    });

    test('an upgrade with no custom repositories still maps its databases', () => {
        const plan = buildUpgradePlan(input({ repos: [] }));

        assert.deepStrictEqual(plan.assignments, []);
        assert.deepStrictEqual(plan.reposToWorktree, []);
        assert.deepStrictEqual(plan.versionsToCreate, ['17.0', '19.0']);
    });

    test('the description names the databases, versions, branches and directories', () => {
        const built = input({ root: '/home/dev/odoo-dev' });
        const text = describeUpgradePlan(buildUpgradePlan(built), built);

        assert.ok(text.includes('crm-17'), text);
        assert.ok(text.includes('crm-19'), text);
        assert.ok(text.includes('17.0'), text);
        assert.ok(text.includes('19.0'), text);
        assert.ok(text.includes('psae-internal'), text);
        assert.ok(text.includes('one copy per branch'), text);
        // The directories that the deleted per-repo modal used to name.
        assert.ok(text.includes('/home/dev/odoo-dev/psae-internal@19.0-bunka'), text);
    });

    test('the description omits the copies section when nothing changes mode', () => {
        const built = input({ root: '/home/dev/odoo-dev', worktreeRepos: ['psae-internal'] });
        const text = describeUpgradePlan(buildUpgradePlan(built), built);

        assert.ok(!text.includes('one copy per branch'), text);
        assert.ok(text.includes('crm-17'), text);
    });
});
