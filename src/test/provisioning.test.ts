import * as assert from 'assert';
import * as path from 'node:path';
import {
    slugifyBranch,
    resolveProvisionPaths,
    buildPlan,
    isFullySatisfied,
    ProvisionSpec,
    ProvisionProbe
} from '../services/provisioning';

const SPEC: ProvisionSpec = {
    branch: '17.0',
    sourceRepoPath: '/dev/odoo',
    enterpriseRepoPath: '/dev/enterprise',
    root: '/dev/versions'
};

const NOTHING_PRESENT: ProvisionProbe = {
    odooWorktree: false,
    enterpriseWorktree: false,
    designThemesWorktree: false,
    venv: false,
    requirements: false
};

const ALL_PRESENT: ProvisionProbe = {
    odooWorktree: true,
    enterpriseWorktree: true,
    designThemesWorktree: true,
    venv: true,
    requirements: true
};

suite('Provisioning plan', () => {
    test('leaves ordinary branch names untouched', () => {
        assert.strictEqual(slugifyBranch('19.0'), '19.0');
        assert.strictEqual(slugifyBranch('saas-19.2'), 'saas-19.2');
        assert.strictEqual(slugifyBranch('master'), 'master');
    });

    test('replaces path separators and unsafe characters', () => {
        assert.strictEqual(slugifyBranch('feature/upgrade-17'), 'feature-upgrade-17');
        assert.strictEqual(slugifyBranch('fix\\weird:name'), 'fix-weird-name');
    });

    test('resolves per-version paths under the root', () => {
        const paths = resolveProvisionPaths(SPEC);
        assert.strictEqual(paths.odooPath, path.join('/dev/versions', 'odoo-17.0'));
        assert.strictEqual(paths.enterprisePath, path.join('/dev/versions', 'enterprise-17.0'));
        assert.strictEqual(paths.venvPath, path.join('/dev/versions', 'venv-17.0'));
        assert.strictEqual(paths.designThemesPath, undefined);
    });

    test('marks every step needed when nothing exists', () => {
        const plan = buildPlan(SPEC, NOTHING_PRESENT);
        assert.ok(plan.every(step => step.status === 'needed'));
        assert.strictEqual(isFullySatisfied(plan), false);
    });

    test('omits steps for repositories that were not requested', () => {
        const plan = buildPlan(SPEC, NOTHING_PRESENT);
        assert.ok(plan.some(step => step.id === 'worktree:enterprise'));
        assert.ok(!plan.some(step => step.id === 'worktree:design-themes'));
    });

    test('marks everything satisfied when it all exists', () => {
        const plan = buildPlan(SPEC, ALL_PRESENT);
        assert.ok(plan.every(step => step.status === 'satisfied'));
        assert.strictEqual(isFullySatisfied(plan), true);
    });

    test('marks only the missing steps needed', () => {
        const plan = buildPlan(SPEC, { ...ALL_PRESENT, requirements: false });
        const needed = plan.filter(step => step.status === 'needed').map(step => step.id);
        assert.deepStrictEqual(needed, ['requirements']);
    });
});
