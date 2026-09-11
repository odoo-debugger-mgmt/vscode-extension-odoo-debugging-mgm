/**
 * Staging the source's module set onto the target, and lifting it again.
 *
 * Turning upgrade mode off and on, and the module toggle off and on, both go
 * through these two functions. A round trip must lose nothing: not the
 * target's own modules, and not the per-module changes made to the staged set
 * during the upgrade - which a naive "rebuild from the source" would.
 */
import * as assert from 'assert';
import { ModuleModel } from '../models/module';
import { UpgradeConfigModel } from '../models/upgrade';
import { stageTargetModules, unstageTargetModules } from '../services/upgradeApply';
import type { ProjectModel } from '../models/project';

function states(modules: ModuleModel[]): Array<[string, string]> {
    return modules.map(module => [module.name, module.state]);
}

function fixture(): { project: ProjectModel; config: UpgradeConfigModel; source: { modules: ModuleModel[] }; target: { modules: ModuleModel[] } } {
    const source = { id: 'crm-17', modules: [new ModuleModel('sale', 'upgrade', true)] };
    const target = { id: 'crm-19', modules: [new ModuleModel('own_module', 'install', false)] };
    const project = { name: 'acme', dbs: [source, target] } as unknown as ProjectModel;
    const config = new UpgradeConfigModel(
        true,
        { versionId: 'v17', dbId: 'crm-17', series: '17.0' },
        { versionId: 'v19', dbId: 'crm-19', series: '19.0' },
        [],
        undefined,
        ['sale', 'crm'],
        ['legacy_module']
    );
    return { project, config, source, target };
}

suite('Staging the source modules onto the target', () => {
    test('staging marks the set and stashes what the target had', () => {
        const { project, config, target } = fixture();
        stageTargetModules(project, config);

        assert.deepStrictEqual(states(target.modules), [
            ['sale', 'install'], ['crm', 'install'], ['legacy_module', 'none']
        ]);
        assert.deepStrictEqual(config.savedTargetModuleStates, [{ name: 'own_module', state: 'install' }]);
        assert.ok(config.isTargetStaged());
    });

    test('unstaging gives the target its own modules back', () => {
        const { project, config, target } = fixture();
        stageTargetModules(project, config);
        unstageTargetModules(project, config);

        assert.deepStrictEqual(states(target.modules), [['own_module', 'install']]);
        assert.strictEqual(config.isTargetStaged(), false);
    });

    test('changes made to the staged set come back after a round trip', () => {
        // The complaint this exists for: marking one module off during the
        // upgrade, turning the mode off and on, and finding it marked again.
        const { project, config, target } = fixture();
        stageTargetModules(project, config);
        target.modules[1].state = 'none';

        unstageTargetModules(project, config);
        stageTargetModules(project, config);

        assert.deepStrictEqual(states(target.modules), [
            ['sale', 'install'], ['crm', 'none'], ['legacy_module', 'none']
        ]);
    });

    test("changes made to the target's own modules while unstaged are what gets restored", () => {
        const { project, config, target } = fixture();
        stageTargetModules(project, config);
        unstageTargetModules(project, config);
        target.modules.push(new ModuleModel('added_meanwhile', 'upgrade', false));

        stageTargetModules(project, config);
        unstageTargetModules(project, config);

        assert.deepStrictEqual(states(target.modules), [
            ['own_module', 'install'], ['added_meanwhile', 'upgrade']
        ]);
    });

    test('staging twice does not stash the staged set as the target\'s own', () => {
        const { project, config, target } = fixture();
        stageTargetModules(project, config);
        stageTargetModules(project, config);
        unstageTargetModules(project, config);
        unstageTargetModules(project, config);

        assert.deepStrictEqual(states(target.modules), [['own_module', 'install']]);
    });

    test('the source database is never touched', () => {
        const { project, config, source } = fixture();
        stageTargetModules(project, config);
        unstageTargetModules(project, config);

        assert.deepStrictEqual(states(source.modules), [['sale', 'upgrade']]);
    });

    test('a target database that no longer exists is not an error', () => {
        const { config } = fixture();
        const project = { name: 'acme', dbs: [] } as unknown as ProjectModel;
        stageTargetModules(project, config);
        assert.strictEqual(config.isTargetStaged(), false);
    });
});
