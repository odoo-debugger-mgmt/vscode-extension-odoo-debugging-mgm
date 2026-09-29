/**
 * Testing mode's module stash belongs to the database it was taken from.
 * It used to live on the project, and turning testing off restored it onto
 * whichever database happened to be selected by then.
 */
import * as assert from 'assert';
import { DatabaseModel } from '../models/db';
import { ModuleModel } from '../models/module';
import { restoreStashedModules, stashModules } from '../testing';
import { moveTestingStashToDatabase } from '../services/dataMigration';
import type { DebuggerData } from '../utils';

function db(id: string, marks: Array<[string, 'install' | 'upgrade' | 'none']>): DatabaseModel {
    const model = new DatabaseModel(id, new Date(0), { internalName: id });
    model.modules = marks.map(([name, state]) => new ModuleModel(name, state));
    return model;
}

const marks = (model: DatabaseModel) => model.modules.map(module => `${module.name}:${module.state}`);

suite('Testing stash', () => {
    test('stashing keeps the marks on the database and clears them', () => {
        const target = db('acme-17', [['sale', 'install'], ['stock', 'upgrade']]);
        stashModules(target);

        assert.deepStrictEqual(target.modules, []);
        assert.deepStrictEqual(target.testingModuleStates, [
            { name: 'sale', state: 'install' }, { name: 'stock', state: 'upgrade' }
        ]);
    });

    test('stashing twice keeps the first stash', () => {
        const target = db('acme-17', [['sale', 'install']]);
        stashModules(target);
        stashModules(target);

        assert.deepStrictEqual(target.testingModuleStates, [{ name: 'sale', state: 'install' }]);
    });

    test('restoring gives each database its own marks back, whatever is selected', () => {
        const first = db('acme-17', [['sale', 'install']]);
        const second = db('acme-19', [['crm', 'upgrade']]);
        stashModules(first);
        stashModules(second);
        first.isSelected = false;
        second.isSelected = true;

        restoreStashedModules([first, second]);

        assert.deepStrictEqual(marks(first), ['sale:install']);
        assert.deepStrictEqual(marks(second), ['crm:upgrade']);
        assert.strictEqual(first.testingModuleStates, undefined);
    });

    test('a database that was never stashed is left alone', () => {
        const untouched = db('other', [['mrp', 'install']]);
        restoreStashedModules([untouched]);

        assert.deepStrictEqual(marks(untouched), ['mrp:install']);
    });

    test('the legacy project stash moves onto the selected database', () => {
        const data = {
            projects: [{
                uid: 'p1',
                testingConfig: { isEnabled: true, savedModuleStates: [{ name: 'sale', state: 'install' }] },
                dbs: [{ id: 'a', isSelected: false }, { id: 'b', isSelected: true }]
            }]
        } as unknown as DebuggerData;

        assert.strictEqual(moveTestingStashToDatabase(data), true);
        const project = data.projects[0] as any;
        assert.strictEqual(project.testingConfig.savedModuleStates, undefined);
        assert.deepStrictEqual(project.dbs[1].testingModuleStates, [{ name: 'sale', state: 'install' }]);
        assert.strictEqual(project.dbs[0].testingModuleStates, undefined);
        assert.strictEqual(moveTestingStashToDatabase(data), false);
    });

    test('with no database selected the legacy stash waits', () => {
        const data = {
            projects: [{ uid: 'p1', testingConfig: { savedModuleStates: [] }, dbs: [{ id: 'a', isSelected: false }] }]
        } as unknown as DebuggerData;

        assert.strictEqual(moveTestingStashToDatabase(data), false);
        assert.deepStrictEqual((data.projects[0] as any).testingConfig.savedModuleStates, []);
    });
});
