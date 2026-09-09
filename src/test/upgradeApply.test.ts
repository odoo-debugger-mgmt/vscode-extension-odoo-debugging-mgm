/**
 * Applying an upgrade to a project that has never had one.
 *
 * A project loaded from settings is a plain object, not a ProjectModel, so its
 * class-field defaults never ran and `upgradeConfig` is undefined. Reading
 * through it threw a TypeError that the staging try/catch swallowed into a
 * bogus "could not read the modules" report - the modules were staged but the
 * stash that lets the mode be left again was silently lost.
 *
 * Caught by driving the real Extension Host, not by these tests, because they
 * had always built a UpgradeConfigModel first. Hence this one.
 */
import * as assert from 'assert';
import { applyUpgradeSetup, UpgradeSetup } from '../services/upgradeApply';
import { buildUpgradePlan } from '../services/upgradePlan';
import type { ProjectModel } from '../models/project';

function setupFor(): UpgradeSetup {
    const input = {
        repos: [],
        fromSeries: '17.0',
        toSeries: '19.0',
        fromDbId: 'from-db',
        toDbId: 'to-db',
        existingVersions: ['17.0', '19.0']
    };
    return {
        fromDbId: 'from-db',
        toDbId: 'to-db',
        fromSeries: '17.0',
        toSeries: '19.0',
        fromVersionId: 'v17',
        toVersionId: 'v19',
        repos: [],
        root: '/tmp/does-not-matter',
        plan: buildUpgradePlan(input)
    };
}

suite('Applying an upgrade to a project with no upgrade config', () => {
    test('never reads the config it is about to write', async () => {
        const project = {
            name: 'acme',
            repos: [],
            dbs: [
                { id: 'from-db', modules: [], projectRepoBranches: [] },
                { id: 'to-db', modules: [], projectRepoBranches: [] }
            ],
            selectedDbByVersion: {}
        } as unknown as ProjectModel;

        let written: unknown;
        Object.defineProperty(project, 'upgradeConfig', {
            get() { throw new TypeError('upgradeConfig was read before it was written'); },
            set(value: unknown) { written = value; },
            configurable: true
        });

        const result = await applyUpgradeSetup(project, setupFor(), () => undefined);

        assert.ok(written, 'the upgrade config was never written');
        assert.strictEqual((written as { isEnabled: boolean }).isEnabled, true);
        // The module read may fail in a test environment with no such database;
        // what must not happen is a failure caused by the config itself.
        for (const problem of result.problems) {
            assert.ok(
                !/upgradeConfig/.test(problem),
                `a config read leaked into the problems: ${problem}`
            );
        }
    });

    test('both sides and their databases are recorded', async () => {
        const project = {
            name: 'acme',
            repos: [],
            dbs: [
                { id: 'from-db', modules: [], projectRepoBranches: [] },
                { id: 'to-db', modules: [], projectRepoBranches: [] }
            ],
            selectedDbByVersion: {}
        } as unknown as ProjectModel;

        await applyUpgradeSetup(project, setupFor(), () => undefined);

        assert.strictEqual(project.upgradeConfig.from?.dbId, 'from-db');
        assert.strictEqual(project.upgradeConfig.to?.dbId, 'to-db');
        assert.strictEqual(project.selectedDbByVersion['v17'], 'from-db');
        assert.strictEqual(project.selectedDbByVersion['v19'], 'to-db');
    });
});
