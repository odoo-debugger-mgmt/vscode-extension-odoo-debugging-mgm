import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { findModules, findRepositories, discoverModulesInRepos } from '../utils';
import { RepoModel } from '../models/repo';

suite('Recursive discovery utilities', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-discovery-'));
    const customRoot = path.join(tmpRoot, 'custom');
    const repoAPath = path.join(customRoot, 'repoA');
    const repoBPath = path.join(customRoot, 'packs', 'feature', 'repoB');
    const manualInternalPath = path.join(tmpRoot, 'shared', 'ps-custom-internal');

    function createModule(dir: string) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '__manifest__.py'), '# manifest', 'utf8');
    }

    suiteSetup(() => {
        fs.mkdirSync(customRoot, { recursive: true });

        // Repository A structure
        fs.mkdirSync(path.join(repoAPath, '.git'), { recursive: true });
        createModule(path.join(repoAPath, 'module_root'));
        createModule(path.join(repoAPath, 'nested', 'deeper', 'module_nested'));
        createModule(path.join(repoAPath, 'psae-internal', 'ps_mod'));
        // Noise under node_modules should be skipped by default patterns
        createModule(path.join(repoAPath, 'node_modules', 'should_be_ignored'));

        // Repository B nested deeper
        fs.mkdirSync(path.join(repoBPath, '.git'), { recursive: true });

        // Manual include path outside repositories
        createModule(path.join(manualInternalPath, 'manual_mod'));
    });

    suiteTeardown(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('findRepositories discovers nested git roots once', () => {
        const repositories = findRepositories(customRoot);
        const names = repositories.map(repo => repo.name).sort();
        assert.deepStrictEqual(names, ['repoA', 'repoB'], 'Expected both repositories to be discovered');
    });

    test('findModules walks nested structure and skips excluded paths', () => {
        const modules = findModules(repoAPath);
        const names = modules.map(mod => mod.name).sort();
        assert.deepStrictEqual(names, ['module_nested', 'module_root', 'ps_mod']);
    });

    test('findModules honours maxDepth override', () => {
        const shallowModules = findModules(repoAPath, { maxDepth: 1 });
        const names = shallowModules.map(mod => mod.name);
        assert.ok(names.includes('module_root'), 'Shallow search should include direct modules');
        assert.ok(!names.includes('module_nested'), 'Shallow search should exclude deep modules');
    });

    test('discoverModulesInRepos groups psae-internal directories and manual includes', () => {
        const repoModel = new RepoModel('repoA', repoAPath, true);
        const discovery = discoverModulesInRepos([repoModel], {
            manualIncludePaths: [manualInternalPath]
        });

        const moduleNames = discovery.modules.map(mod => mod.name).sort();
        assert.deepStrictEqual(moduleNames, ['manual_mod', 'module_nested', 'module_root', 'ps_mod']);

        const repoRoots = new Set(discovery.modules.map(mod => path.resolve(mod.repoPath)));
        assert.ok(repoRoots.has(path.resolve(repoAPath)), 'Modules from repoA should report repo root');

        const containerDirs = new Set(discovery.modules.map(mod => path.dirname(mod.path)));
        assert.ok(containerDirs.has(path.join(repoAPath, 'psae-internal')), 'psae-internal directory should be detected as module container');
        assert.ok(containerDirs.has(path.join(repoAPath, 'nested', 'deeper')), 'Nested container path should be reported for deeper modules');

        const psaePaths = discovery.psaeDirectories.map(dir => dir.path).sort();
        assert.deepStrictEqual(psaePaths.sort(), [path.join(repoAPath, 'psae-internal'), manualInternalPath].sort());

        const manualEntry = discovery.psaeDirectories.find(dir => dir.path === manualInternalPath);
        assert.ok(manualEntry, 'Manual include should be represented');
        assert.deepStrictEqual(manualEntry?.moduleNames, ['manual_mod']);
    });
});
