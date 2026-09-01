import * as assert from 'assert';
import * as path from 'node:path';
import { RepoModel } from '../models/repo';
import {
    worktreeDirName,
    resolveRepoPath,
    resolveProjectRepos,
    toDiscoveryRepos,
    identifyWorktreeOwner,
    ResolvedRepo
} from '../services/repoPaths';

const ROOT = '/home/dev/odoo-dev';

function repo(name: string, repoPath: string, mode: 'checkout' | 'worktree' = 'checkout'): RepoModel {
    return new RepoModel(name, repoPath, true, undefined, mode);
}

suite('Repository path resolution', () => {
    test('builds a worktree directory name from repo and branch', () => {
        assert.strictEqual(worktreeDirName('psae-internal', '19.0'), 'psae-internal@19.0');
        // Slashes and anything else illegal in a directory name are replaced.
        assert.strictEqual(worktreeDirName('psae-internal', '19.0-bunka-abc'), 'psae-internal@19.0-bunka-abc');
        assert.strictEqual(worktreeDirName('psae internal', 'feature/x'), 'psae-internal@feature-x');
    });

    test('a checkout-mode repo always resolves to its own path', () => {
        const model = repo('psae-internal', '/custom/psae-internal');
        const resolved = resolveRepoPath(model, '19.0', ROOT);
        assert.strictEqual(resolved.path, '/custom/psae-internal');
        assert.strictEqual(resolved.isWorktree, false);
        assert.strictEqual(resolved.mode, 'checkout');
        assert.strictEqual(resolved.branch, '19.0');
    });

    test('a worktree-mode repo resolves to a per-branch directory under the root', () => {
        const model = repo('psae-internal', '/custom/psae-internal', 'worktree');
        const resolved = resolveRepoPath(model, '19.0', ROOT);
        assert.strictEqual(resolved.path, path.join(ROOT, 'psae-internal@19.0'));
        assert.strictEqual(resolved.isWorktree, true);
        assert.strictEqual(resolved.branch, '19.0');
    });

    test('a worktree-mode repo with no branch assigned falls back to its source', () => {
        // Nothing to key a worktree on; the source is read-only in this state
        // and the caller reports it (spec: failure modes table).
        const model = repo('psae-internal', '/custom/psae-internal', 'worktree');
        const resolved = resolveRepoPath(model, undefined, ROOT);
        assert.strictEqual(resolved.path, '/custom/psae-internal');
        assert.strictEqual(resolved.isWorktree, false);
        assert.strictEqual(resolved.branch, undefined);
    });

    test('resolves a whole project against its branch assignments', () => {
        const repos = [
            repo('psae-internal', '/custom/psae-internal', 'worktree'),
            repo('shared-lib', '/custom/shared-lib')
        ];
        const assignments = [
            { repoName: 'psae-internal', repoPath: '/custom/psae-internal', branch: '19.0' },
            { repoName: 'shared-lib', repoPath: '/custom/shared-lib', branch: 'main' }
        ];

        const resolved = resolveProjectRepos(repos, assignments, ROOT);
        assert.deepStrictEqual(resolved.map((entry: ResolvedRepo) => entry.path), [
            path.join(ROOT, 'psae-internal@19.0'),
            '/custom/shared-lib'
        ]);
    });

    test('matches assignments by path first, then by name', () => {
        const repos = [repo('psae-internal', '/custom/psae-internal', 'worktree')];
        // A renamed repo still matches on path.
        const byPath = resolveProjectRepos(
            repos,
            [{ repoName: 'renamed', repoPath: '/custom/psae-internal', branch: '17.0' }],
            ROOT
        );
        assert.strictEqual(byPath[0].branch, '17.0');

        // A moved repo still matches on name.
        const byName = resolveProjectRepos(
            repos,
            [{ repoName: 'psae-internal', repoPath: '/somewhere/else', branch: '18.0' }],
            ROOT
        );
        assert.strictEqual(byName[0].branch, '18.0');
    });

    test('adapts resolved repos for module discovery', () => {
        const repos = [repo('psae-internal', '/custom/psae-internal', 'worktree')];
        const resolved = resolveProjectRepos(
            repos,
            [{ repoName: 'psae-internal', repoPath: '/custom/psae-internal', branch: '19.0' }],
            ROOT
        );

        const discovery = toDiscoveryRepos(resolved);
        // Discovery must see the worktree, not the source checkout.
        assert.strictEqual(discovery[0].path, path.join(ROOT, 'psae-internal@19.0'));
        assert.strictEqual(discovery[0].name, 'psae-internal');
    });

    test('identifies which repo and branch a file belongs to', () => {
        const repos = [repo('psae-internal', '/custom/psae-internal', 'worktree')];
        const resolved = resolveProjectRepos(
            repos,
            [{ repoName: 'psae-internal', repoPath: '/custom/psae-internal', branch: '19.0' }],
            ROOT
        );

        const owner = identifyWorktreeOwner(
            path.join(ROOT, 'psae-internal@19.0', 'my_module', 'models.py'),
            resolved
        );
        assert.strictEqual(owner?.repo.name, 'psae-internal');
        assert.strictEqual(owner?.branch, '19.0');

        // A file outside every worktree belongs to nobody.
        assert.strictEqual(identifyWorktreeOwner('/etc/passwd', resolved), undefined);
        // A sibling directory whose name merely starts the same must not match.
        assert.strictEqual(
            identifyWorktreeOwner(path.join(ROOT, 'psae-internal@19.0-other', 'x.py'), resolved),
            undefined
        );
    });

    test('two versions on different branches resolve to different directories', () => {
        // The whole point of the feature: v17 and v19 must not share a copy.
        const repos = [repo('psae-internal', '/custom/psae-internal', 'worktree')];
        const v17 = resolveProjectRepos(
            repos,
            [{ repoName: 'psae-internal', repoPath: '/custom/psae-internal', branch: '17.0' }],
            ROOT
        );
        const v19 = resolveProjectRepos(
            repos,
            [{ repoName: 'psae-internal', repoPath: '/custom/psae-internal', branch: '19.0' }],
            ROOT
        );

        assert.notStrictEqual(v17[0].path, v19[0].path);
        assert.strictEqual(v17[0].path, path.join(ROOT, 'psae-internal@17.0'));
        assert.strictEqual(v19[0].path, path.join(ROOT, 'psae-internal@19.0'));
    });

    test('two versions on the same branch share one worktree', () => {
        // Keyed by branch, not by version: no duplicate trees.
        const repos = [repo('shared', '/custom/shared', 'worktree')];
        const a = resolveProjectRepos(repos, [{ repoName: 'shared', repoPath: '/custom/shared', branch: 'main' }], ROOT);
        const b = resolveProjectRepos(repos, [{ repoName: 'shared', repoPath: '/custom/shared', branch: 'main' }], ROOT);
        assert.strictEqual(a[0].path, b[0].path);
    });

    test('identifies a file in another version worktree of the same repo', () => {
        const repos = [repo('psae-internal', '/custom/psae-internal', 'worktree')];
        const active = resolveProjectRepos(
            repos,
            [{ repoName: 'psae-internal', repoPath: '/custom/psae-internal', branch: '19.0' }],
            ROOT
        );

        // Active version is 19.0; the file opened belongs to the 17.0 worktree,
        // which is not in `active`, so it must not be claimed as owned.
        assert.strictEqual(
            identifyWorktreeOwner(path.join(ROOT, 'psae-internal@17.0', 'models.py'), active),
            undefined
        );
        // The same file under the active worktree is owned.
        assert.strictEqual(
            identifyWorktreeOwner(path.join(ROOT, 'psae-internal@19.0', 'models.py'), active)?.branch,
            '19.0'
        );
    });
});
