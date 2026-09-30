/**
 * The per-window selection split: what is taken out of the data on save, and
 * what is put back on read. The data file must end up with no selection in
 * it, and the model callers read must look exactly as it did before.
 */
import * as assert from 'assert';
import type { DebuggerData } from '../utils';
import {
    EMPTY_SELECTION,
    applySelection,
    extractSelection,
    isEmptySelection,
    keepLeftDatabase,
    normalizeSelection,
    projectKey,
    stripSelection
} from '../services/workspaceSelection';

function sample(): DebuggerData {
    return {
        projects: [
            {
                uid: 'p1', name: 'Acme', isSelected: true,
                dbs: [{ id: 'acme-17', isSelected: false }, { id: 'acme-19', isSelected: true }]
            },
            {
                uid: 'p2', name: 'Other', isSelected: false,
                dbs: [{ id: 'other-17', isSelected: true }]
            }
        ] as never,
        versions: {
            v17: { id: 'v17', odooVersion: '17.0', isActive: false },
            v19: { id: 'v19', odooVersion: '19.0', isActive: true }
        },
        activeVersion: 'v19',
        dbTemplates: []
    };
}

type Flags = { isSelected: boolean; dbs: Array<{ isSelected: boolean }> };
const projects = (data: DebuggerData) => data.projects as unknown as Flags[];

suite('Workspace selection', () => {
    test('extract reads the selected project, each project\'s database and the active version', () => {
        assert.deepStrictEqual(extractSelection(sample()), {
            selectedProjectUid: 'p1',
            selectedDbByProject: { p1: 'acme-19', p2: 'other-17' },
            activeVersionId: 'v19',
            testingByProject: {},
            rememberedDbByProject: {}
        });
    });

    test('strip leaves no selection in what is stored', () => {
        const stripped = stripSelection(sample());

        assert.ok(projects(stripped).every(project => !project.isSelected));
        assert.ok(projects(stripped).every(project => project.dbs.every(db => !db.isSelected)));
        assert.strictEqual(stripped.activeVersion, undefined);
        assert.ok(Object.values(stripped.versions ?? {}).every(version => !version.isActive));
    });

    test('strip does not touch the object it was given', () => {
        const data = sample();
        stripSelection(data);

        assert.strictEqual(data.activeVersion, 'v19');
        assert.strictEqual(projects(data)[0].isSelected, true);
    });

    test('extract, strip, apply gives back the same flags', () => {
        const original = sample();
        const restored = applySelection(stripSelection(original), extractSelection(original));

        assert.deepStrictEqual(restored, original);
    });

    test('each project keeps its own selected database', () => {
        const selection = { ...EMPTY_SELECTION, selectedDbByProject: { p1: 'acme-17', p2: 'other-17' } };
        const applied = applySelection(stripSelection(sample()), selection);

        assert.deepStrictEqual(projects(applied)[0].dbs.map(db => db.isSelected), [true, false]);
        assert.deepStrictEqual(projects(applied)[1].dbs.map(db => db.isSelected), [true]);
    });

    test('ids that no longer exist select nothing', () => {
        const applied = applySelection(stripSelection(sample()), {
            selectedProjectUid: 'gone',
            selectedDbByProject: { p1: 'dropped-db' },
            activeVersionId: 'deleted-version'
        });

        assert.ok(projects(applied).every(project => !project.isSelected));
        assert.ok(projects(applied)[0].dbs.every(db => !db.isSelected));
        assert.strictEqual(applied.activeVersion, undefined);
    });

    test('a save that does not carry a field keeps the previous value', () => {
        const previous = extractSelection(sample());
        const partial = { projects: sample().projects } as DebuggerData;

        assert.strictEqual(extractSelection(partial, previous).activeVersionId, 'v19');
    });

    test('a save that deselects everything is recorded as such', () => {
        const data = sample();
        projects(data).forEach(project => (project.isSelected = false));
        data.activeVersion = '';

        const selection = extractSelection(data, extractSelection(sample()));

        assert.strictEqual(selection.selectedProjectUid, undefined);
        assert.strictEqual(selection.activeVersionId, undefined);
    });

    test('a legacy file seeds the selection it recorded', () => {
        // The first run with a separate selection reads the flags that the
        // file still carries, so nobody loses what they had selected.
        const seeded = extractSelection(sample());

        assert.ok(!isEmptySelection(seeded));
        assert.ok(isEmptySelection(extractSelection(stripSelection(sample()))));
    });

    test('projects written before uids are keyed by name', () => {
        assert.strictEqual(projectKey({ name: 'Old' }), 'name:Old');
        const data = { projects: [{ name: 'Old', isSelected: true, dbs: [] }] } as unknown as DebuggerData;
        const applied = applySelection(stripSelection(data), extractSelection(data));

        assert.strictEqual(projects(applied)[0].isSelected, true);
    });

    test('a malformed stored value reads as no selection', () => {
        assert.strictEqual(normalizeSelection(undefined), undefined);
        assert.strictEqual(normalizeSelection('nonsense'), undefined);
        assert.deepStrictEqual(
            normalizeSelection({ selectedProjectUid: 7, selectedDbByProject: { p1: 3, p2: 'db' } }),
            { selectedProjectUid: undefined, selectedDbByProject: { p2: 'db' }, activeVersionId: undefined, testingByProject: undefined, rememberedDbByProject: undefined }
        );
    });

    suite('testing mode', () => {
        function withTesting(): DebuggerData {
            const data = sample();
            (data.projects[0] as any).testingConfig = {
                isEnabled: true, testTags: [{ id: 't', value: 'sale', state: 'include', type: 'module' }],
                testFile: '/a/test_x.py', stopAfterInit: true, logLevel: 'debug',
                savedModuleStates: [{ name: 'sale', state: 'install' }]
            };
            return data;
        }
        const testingOf = (data: DebuggerData, index = 0) => (data.projects[index] as any).testingConfig;

        test('is per window: extracted, stripped from the store, applied back', () => {
            const data = withTesting();
            const selection = extractSelection(data);

            assert.strictEqual(selection.testingByProject?.p1.isEnabled, true);
            const stored = stripSelection(data);
            assert.strictEqual(testingOf(stored).isEnabled, false);
            assert.deepStrictEqual(testingOf(stored).testTags, []);
            assert.strictEqual(testingOf(stored).testFile, undefined);

            const restored = applySelection(stored, selection);
            assert.strictEqual(testingOf(restored).isEnabled, true);
            assert.strictEqual(testingOf(restored).testFile, '/a/test_x.py');
            assert.strictEqual(testingOf(restored).logLevel, 'debug');
        });

        test('a legacy stash survives a save that runs before the migration', () => {
            assert.deepStrictEqual(testingOf(stripSelection(withTesting())).savedModuleStates, [{ name: 'sale', state: 'install' }]);
        });

        test('another window, with no testing recorded, sees testing off', () => {
            const applied = applySelection(stripSelection(withTesting()), { ...EMPTY_SELECTION, testingByProject: {} });

            assert.strictEqual(testingOf(applied).isEnabled, false);
        });

        test('a selection stored before testing moved leaves the data\'s testing alone', () => {
            const applied = applySelection(withTesting(), { ...EMPTY_SELECTION });

            assert.strictEqual(testingOf(applied).isEnabled, true);
            assert.strictEqual(normalizeSelection({ selectedDbByProject: {} })?.testingByProject, undefined);
        });

        test('projects without a testing config do not grow one', () => {
            const applied = applySelection(stripSelection(sample()), extractSelection(sample()));

            assert.strictEqual(testingOf(applied), undefined);
        });
    });

    suite('remembered databases', () => {
        function withMemory(): DebuggerData {
            const data = sample();
            (data.projects[0] as any).selectedDbByVersion = { v17: 'acme-17', v19: 'acme-19' };
            return data;
        }
        const memoryOf = (data: DebuggerData) => (data.projects[0] as any).selectedDbByVersion;

        test('are per window: extracted, cleared in what is shared, applied back', () => {
            const selection = extractSelection(withMemory());

            assert.deepStrictEqual(selection.rememberedDbByProject, { p1: { v17: 'acme-17', v19: 'acme-19' } });
            const stored = stripSelection(withMemory());
            assert.strictEqual(memoryOf(stored), undefined);
            assert.deepStrictEqual(memoryOf(applySelection(stored, selection)), { v17: 'acme-17', v19: 'acme-19' });
        });

        test('another window\'s memory never reaches this one', () => {
            // What another window left in the data is replaced by this
            // window's own - the cause of one window launching another's database.
            const applied = applySelection(withMemory(), { ...EMPTY_SELECTION, rememberedDbByProject: { p1: { v17: 'acme-17b' } } });

            assert.deepStrictEqual(memoryOf(applied), { v17: 'acme-17b' });
        });

        test('a selection stored before this moved leaves the data\'s memory alone', () => {
            assert.deepStrictEqual(memoryOf(applySelection(withMemory(), { ...EMPTY_SELECTION })), { v17: 'acme-17', v19: 'acme-19' });
        });
    });
});

suite('The version the selection leaves keeps its database', () => {
    function moved(memory?: Record<string, string>, dbs = [
        { id: 'acme-db1', versionId: 'v17' },
        { id: 'acme-db19', versionId: 'v19', isSelected: true }
    ]): any {
        return { projects: [{ uid: 'p1', name: 'Acme', dbs, selectedDbByVersion: memory }] };
    }
    const was = (dbId: string) => ({ selectedDbByProject: { p1: dbId } });

    test('a selection never picked is remembered under its own version when it moves', () => {
        // Finding 14: every 1.3 selection is in no memory, so picking a 19.0
        // database left 17.0 with none.
        const data = keepLeftDatabase(moved(), was('acme-db1'));
        assert.deepStrictEqual(data.projects[0].selectedDbByVersion, { v17: 'acme-db1' });
    });

    test('what a version already remembers is not overwritten', () => {
        const data = keepLeftDatabase(moved({ v17: 'acme-db2' }), was('acme-db1'));
        assert.deepStrictEqual(data.projects[0].selectedDbByVersion, { v17: 'acme-db2' });
    });

    test('a selection that did not move changes nothing', () => {
        const data = keepLeftDatabase(moved(), was('acme-db19'));
        assert.strictEqual(data.projects[0].selectedDbByVersion, undefined);
    });

    test('a deleted or versionless database it leaves is ignored', () => {
        assert.strictEqual(keepLeftDatabase(moved(), was('gone')).projects[0].selectedDbByVersion, undefined);
        const legacy = moved(undefined, [{ id: 'old' } as any, { id: 'acme-db19', versionId: 'v19', isSelected: true }]);
        assert.strictEqual(keepLeftDatabase(legacy, was('old')).projects[0].selectedDbByVersion, undefined);
    });
});
