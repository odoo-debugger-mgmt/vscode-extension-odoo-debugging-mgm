/**
 * Leaving upgrade mode puts the target database's modules back.
 *
 * Staging rewrites the target's module list wholesale, so the states it
 * replaced are stashed first. Without the restore, leaving an upgrade would
 * leave the database configured to install a module set nobody chose.
 */
import * as assert from 'assert';
import { ModuleModel } from '../models/module';
import { UpgradeConfigModel } from '../models/upgrade';
import { revertUpgradeStaging } from '../services/upgradeApply';
import type { ProjectModel } from '../models/project';

function project(config: UpgradeConfigModel, targetModules: ModuleModel[]): ProjectModel {
    return {
        name: 'acme',
        dbs: [
            { id: 'crm-17', modules: [new ModuleModel('sale', 'none', true)] },
            { id: 'crm-19', modules: targetModules }
        ],
        upgradeConfig: config
    } as unknown as ProjectModel;
}

function stagedConfig(saved?: Array<{ name: string; state: 'install' | 'upgrade' | 'none' }>): UpgradeConfigModel {
    return new UpgradeConfigModel(
        true,
        { versionId: 'v17', dbId: 'crm-17', series: '17.0' },
        { versionId: 'v19', dbId: 'crm-19', series: '19.0' },
        [],
        saved,
        ['sale', 'crm'],
        []
    );
}

suite('Leaving upgrade mode', () => {
    test('the target database gets its own module states back', () => {
        const config = stagedConfig([{ name: 'website', state: 'install' }]);
        const proj = project(config, [
            new ModuleModel('sale', 'install', false),
            new ModuleModel('crm', 'install', false)
        ]);

        revertUpgradeStaging(proj);

        assert.deepStrictEqual(
            proj.dbs[1].modules.map(module => [module.name, module.state]),
            [['website', 'install']]
        );
    });

    test('a target that had nothing staged onto it ends up empty, not staged', () => {
        const proj = project(stagedConfig([]), [new ModuleModel('sale', 'install', false)]);

        revertUpgradeStaging(proj);

        assert.deepStrictEqual(proj.dbs[1].modules, []);
    });

    test('the source database is never touched', () => {
        const proj = project(stagedConfig([{ name: 'website', state: 'none' }]), []);

        revertUpgradeStaging(proj);

        assert.deepStrictEqual(
            proj.dbs[0].modules.map(module => module.name),
            ['sale'],
            'the database being upgraded from was modified'
        );
    });

    test('nothing happens when no states were stashed', () => {
        // An upgrade whose staging never ran: there is nothing to put back, and
        // clearing the list anyway would lose whatever the user set by hand.
        const staged = [new ModuleModel('sale', 'install', false)];
        const proj = project(stagedConfig(undefined), staged);

        revertUpgradeStaging(proj);

        assert.strictEqual(proj.dbs[1].modules, staged);
    });

    test('a target database that no longer exists is not an error', () => {
        const config = stagedConfig([{ name: 'website', state: 'install' }]);
        const proj = {
            name: 'acme',
            dbs: [{ id: 'crm-17', modules: [] }],
            upgradeConfig: config
        } as unknown as ProjectModel;

        assert.doesNotThrow(() => revertUpgradeStaging(proj));
    });
});
