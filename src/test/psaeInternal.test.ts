import * as assert from 'assert';
import { resolvePsaeDirectories, setPsaeDirectoryIncluded, PSAE_INTERNAL_REGEX, PsaeDirectoryState } from '../services/psaeInternal';
import { ProjectModel } from '../models/project';

function dir(path: string, moduleNames: string[]) {
    return { path, repoName: 'repo', dirName: path.split('/').pop() ?? path, moduleNames };
}

function resolveOne(args: {
    overrides?: string[];
    selected?: string[];
    installed?: string[];
    modules?: string[];
}): PsaeDirectoryState {
    const [state] = resolvePsaeDirectories({
        psaeDirectories: [dir('/repo/psae-internal', args.modules ?? ['mod_a', 'mod_b'])],
        includedPsaeInternalPaths: args.overrides,
        selectedModuleNames: new Set(args.selected ?? []),
        installedModuleNames: new Set(args.installed ?? [])
    });
    return state;
}

suite('psae-internal resolver', () => {
    test('matches ps*-internal directory names', () => {
        assert.ok(PSAE_INTERNAL_REGEX.test('psae-internal'));
        assert.ok(PSAE_INTERNAL_REGEX.test('psbe-internal'));
        assert.ok(PSAE_INTERNAL_REGEX.test('ps-internal'));
        assert.ok(PSAE_INTERNAL_REGEX.test('PS-INTERNAL'));
        assert.ok(!PSAE_INTERNAL_REGEX.test('ps-internal-tools'));
        assert.ok(!PSAE_INTERNAL_REGEX.test('internal'));
    });

    test('excluded by default without selected or installed modules', () => {
        assert.strictEqual(resolveOne({}).isIncluded, false);
    });

    test('auto-included when a member module is selected or installed', () => {
        assert.strictEqual(resolveOne({ selected: ['mod_a'] }).isIncluded, true);
        assert.strictEqual(resolveOne({ installed: ['mod_b'] }).isIncluded, true);
    });

    test('manual exclusion overrides auto-inclusion', () => {
        const state = resolveOne({ overrides: ['!/repo/psae-internal'], selected: ['mod_a'] });
        assert.strictEqual(state.isIncluded, false);
        assert.strictEqual(state.isManuallyExcluded, true);
    });

    test('manual inclusion wins even against a stale exclusion entry', () => {
        const state = resolveOne({ overrides: ['/repo/psae-internal', '!/repo/psae-internal'] });
        assert.strictEqual(state.isIncluded, true);
    });

    test('toggle include pins a manual include only when not auto-included', () => {
        const project = { includedPsaeInternalPaths: [] } as unknown as ProjectModel;
        const state = resolveOne({});
        setPsaeDirectoryIncluded(project, state, true);
        assert.deepStrictEqual(project.includedPsaeInternalPaths, ['/repo/psae-internal']);

        const autoIncluded = resolveOne({ selected: ['mod_a'] });
        const project2 = { includedPsaeInternalPaths: ['!/repo/psae-internal'] } as unknown as ProjectModel;
        setPsaeDirectoryIncluded(project2, autoIncluded, true);
        // Auto-inclusion suffices: the exclusion is dropped, no include pinned.
        assert.deepStrictEqual(project2.includedPsaeInternalPaths, []);
    });

    test('toggle exclude clears selections and pins an exclusion when needed', () => {
        const project = { includedPsaeInternalPaths: ['/repo/psae-internal'] } as unknown as ProjectModel;
        const state = resolveOne({ overrides: ['/repo/psae-internal'], selected: ['mod_a'] });
        const { removedModuleNames } = setPsaeDirectoryIncluded(project, state, false);
        assert.deepStrictEqual(project.includedPsaeInternalPaths, ['!/repo/psae-internal']);
        assert.deepStrictEqual(removedModuleNames, ['mod_a', 'mod_b']);

        // Without selected/installed modules, simply dropping the include is enough.
        const project2 = { includedPsaeInternalPaths: ['/repo/psae-internal'] } as unknown as ProjectModel;
        const idle = resolveOne({ overrides: ['/repo/psae-internal'] });
        const result2 = setPsaeDirectoryIncluded(project2, idle, false);
        assert.deepStrictEqual(project2.includedPsaeInternalPaths, []);
        assert.deepStrictEqual(result2.removedModuleNames, []);
    });
});
