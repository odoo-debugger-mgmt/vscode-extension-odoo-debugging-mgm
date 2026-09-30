/**
 * Each version finds its own checkout of a project repository (design §5).
 *
 * The layouts people use differ: one clone every version shares, a folder per
 * version with its own clone, the extension's per-branch copies, or a
 * different repository per version. The decision is pure and tested as data;
 * finding clones by their remote runs against real git.
 */
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RepoModel } from '../models/repo';
import { normalizeRemote, pickRepoCheckout, reposForVersion, resolveProjectRepos } from '../services/repoPaths';
import { locateRepoCheckouts, projectReposForVersion, repoRows } from '../services/repoLocations';
import { resolveProjectRepoCheckouts } from '../services/environment';

suite('Remote URLs compare by what they name', () => {
    test('ssh, scp-like and https forms of one repository are equal', () => {
        const forms = [
            'git@github.com:acme/addons.git',
            'ssh://git@github.com:22/acme/addons',
            'https://github.com/acme/addons.git',
            'https://user@github.com/Acme/addons/'
        ];
        assert.deepStrictEqual(new Set(forms.map(normalizeRemote)), new Set(['github.com/acme/addons']));
    });

    test('no remote is no remote', () => {
        assert.strictEqual(normalizeRemote(undefined), undefined);
        assert.strictEqual(normalizeRemote('  '), undefined);
    });
});

suite('Which checkout serves a repository for a version', () => {
    const repo = { name: 'acme', path: '/work/acme' };
    const candidates = [
        { path: '/v19/acme-addons', name: 'acme-addons', remote: 'github.com/acme/addons' },
        { path: '/v19/acme', name: 'acme', remote: 'github.com/other/fork' }
    ];

    test('a manual override comes first', () => {
        assert.deepStrictEqual(pickRepoCheckout(repo, 'github.com/acme/addons', '/elsewhere/acme', candidates),
            { path: '/elsewhere/acme', source: 'override' });
    });

    test('then a checkout with the same remote, whatever its folder is called', () => {
        assert.deepStrictEqual(pickRepoCheckout(repo, 'github.com/acme/addons', undefined, candidates),
            { path: '/v19/acme-addons', source: 'remote' });
    });

    test('then one with the same folder name', () => {
        assert.deepStrictEqual(pickRepoCheckout(repo, undefined, undefined, candidates),
            { path: '/v19/acme', source: 'name' });
    });

    test('otherwise the repository\'s own path, as before', () => {
        assert.deepStrictEqual(pickRepoCheckout(repo, undefined, undefined, []), { path: '/work/acme', source: 'default' });
    });
});

suite('The project\'s repositories as a version sees them', () => {
    const acme = new RepoModel('acme', '/v17/acme');
    const copies = new RepoModel('lib', '/src/lib', false, undefined, 'worktree');

    test('a repository in checkout mode points at the version\'s checkout', () => {
        const [seen] = reposForVersion([acme], new Map([['acme', '/v19/acme']]));
        assert.strictEqual(seen.path, '/v19/acme');
        assert.strictEqual(seen.name, 'acme');
        assert.strictEqual(acme.path, '/v17/acme', 'the project\'s own model must not change');
    });

    test('one keeping a copy per branch keeps its source', () => {
        const [seen] = reposForVersion([copies], new Map([['lib', '/v19/lib']]));
        assert.strictEqual(seen.path, '/src/lib');
    });

    test('branch assignments recorded against the original path still apply, by name', () => {
        const seen = reposForVersion([acme], new Map([['acme', '/v19/acme']]));
        const assignments = [{ repoName: 'acme', repoPath: '/v17/acme', branch: 'main' }];

        const [resolved] = resolveProjectRepos(seen, assignments, '/root');
        assert.strictEqual(resolved.path, '/v19/acme');
        assert.strictEqual(resolved.branch, 'main');

        // What a database switch checks out, and where.
        const checkouts = resolveProjectRepoCheckouts({ projectRepoBranches: assignments }, seen);
        assert.deepStrictEqual(checkouts, [{ repoName: 'acme', repoPath: '/v19/acme', branch: 'main' }]);
    });
});

suite('The Repos view lists what the version runs', () => {
    const acme = { name: 'acme', remote: 'github.com/org/acme' };

    test('the bound workspace\'s clone is the project repository\'s row; another clone of it is left out', () => {
        // Twelfth run: the view showed v19/acme-19 on 19.0-alt while 19.0 ran W19/acme on main.
        const rows = repoRows(
            [
                { path: '/W19/acme', name: 'acme', remote: 'github.com/org/acme' },
                { path: '/v19/acme-19', name: 'acme-19', remote: 'github.com/org/acme' },
                { path: '/v19/tools', name: 'tools', remote: 'github.com/org/tools' }
            ],
            new Map([['acme', { path: '/W19/acme' }]]),
            [acme]
        );
        assert.deepStrictEqual(rows, [
            { name: 'acme', path: '/W19/acme', inProject: true, folderName: undefined },
            { name: 'tools', path: '/v19/tools', inProject: false }
        ]);
    });

    test('a checkout under another folder name carries the project repository\'s name', () => {
        const rows = repoRows(
            [{ path: '/v19/acme-19', name: 'acme-19', remote: 'github.com/org/acme' }],
            new Map([['acme', { path: '/v19/acme-19' }]]),
            [acme]
        );
        assert.deepStrictEqual(rows, [{ name: 'acme', path: '/v19/acme-19', inProject: true, folderName: 'acme-19' }]);
    });

    test('one clone for every version gives the rows it always did', () => {
        const rows = repoRows(
            [{ path: '/addons/acme', name: 'acme' }, { path: '/addons/beta', name: 'beta' }],
            new Map([['acme', { path: '/addons/acme' }]]),
            [{ name: 'acme' }]
        );
        assert.deepStrictEqual(rows, [
            { name: 'acme', path: '/addons/acme', inProject: true, folderName: undefined },
            { name: 'beta', path: '/addons/beta', inProject: false }
        ]);
    });
});

suite('Finding each version\'s clone against real git', function () {
    this.timeout(30000);
    let root: string;

    function git(cwd: string, ...args: string[]): string {
        return execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
                GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com'
            }
        }).trim();
    }

    /** A clone of `origin` at `dest`, with origin set to a URL like a real one. */
    function cloneAs(origin: string, dest: string, url: string): void {
        git(root, 'clone', '-q', origin, dest);
        git(dest, 'remote', 'set-url', 'origin', url);
    }

    const list = (dir: string) => fs.readdirSync(dir)
        .filter(name => fs.existsSync(path.join(dir, name, '.git')))
        .map(name => ({ name, path: path.join(dir, name) }));

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-locations-'));
        const origin = path.join(root, 'origin');
        fs.mkdirSync(origin);
        git(origin, 'init', '-q', '-b', 'main');
        fs.writeFileSync(path.join(origin, 'README.md'), '# acme\n');
        git(origin, 'add', '.');
        git(origin, 'commit', '-q', '-m', 'initial');
        fs.mkdirSync(path.join(root, 'v17'));
        fs.mkdirSync(path.join(root, 'v19'));
        cloneAs(origin, path.join(root, 'v17', 'acme'), 'git@github.com:acme/addons.git');
        // Another folder name, the same repository by another URL form.
        cloneAs(origin, path.join(root, 'v19', 'acme-19'), 'https://github.com/acme/addons');
    });

    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('each version finds its own clone, by remote even under another name', async () => {
        const repos = [new RepoModel('acme', path.join(root, 'v17', 'acme'))];
        const v17 = { settings: { customAddonsPath: path.join(root, 'v17') } };
        const v19 = { settings: { customAddonsPath: path.join(root, 'v19') } };

        assert.deepStrictEqual(await locateRepoCheckouts(repos, v17, list),
            new Map([['acme', { path: path.join(root, 'v17', 'acme'), source: 'remote' }]]));
        assert.deepStrictEqual(await locateRepoCheckouts(repos, v19, list),
            new Map([['acme', { path: path.join(root, 'v19', 'acme-19'), source: 'remote' }]]));
    });

    test('one shared custom addons folder resolves every version to the one clone', async () => {
        const repos = [new RepoModel('acme', path.join(root, 'v17', 'acme'))];
        const shared = { settings: { customAddonsPath: path.join(root, 'v17') } };

        const [seen] = await projectReposForVersion(repos, shared, list);
        assert.strictEqual(seen, repos[0], 'the single-clone layout must come back unchanged');
    });

    test('a workspace folder that is itself the clone is found for the version it is bound to', async () => {
        // The 19.0 workspace opened ~/work/acme directly: no custom addons
        // folder holds it, but it is that version's code.
        const workspaceClone = path.join(root, 'work', 'acme-main');
        fs.mkdirSync(path.dirname(workspaceClone));
        cloneAs(path.join(root, 'origin'), workspaceClone, 'git@github.com:acme/addons.git');
        const repos = [new RepoModel('acme', path.join(root, 'v17', 'acme'))];
        const v19 = { settings: { customAddonsPath: path.join(root, 'nothing-here') } };

        const bound = await locateRepoCheckouts(repos, v19, list, [workspaceClone]);
        assert.deepStrictEqual(bound.get('acme'), { path: workspaceClone, source: 'remote' });

        // Without the binding, the same version falls back to the repository.
        const unbound = await locateRepoCheckouts(repos, v19, list);
        assert.deepStrictEqual(unbound.get('acme'), { path: path.join(root, 'v17', 'acme'), source: 'default' });
    });

    test('the workspace\'s folders are searched before the custom addons folder', async () => {
        const workspaceClone = path.join(root, 'work', 'acme');
        fs.mkdirSync(path.dirname(workspaceClone));
        cloneAs(path.join(root, 'origin'), workspaceClone, 'https://github.com/acme/addons');
        const repos = [new RepoModel('acme', path.join(root, 'v17', 'acme'))];
        const v19 = { settings: { customAddonsPath: path.join(root, 'v19') } };

        const located = await locateRepoCheckouts(repos, v19, list, [path.dirname(workspaceClone)]);
        assert.strictEqual(located.get('acme')?.path, workspaceClone);
    });

    test('a manual override wins, and a missing custom addons folder falls back to the repository', async () => {
        const repos = [new RepoModel('acme', path.join(root, 'v17', 'acme'))];

        const overridden = await locateRepoCheckouts(repos, {
            settings: { customAddonsPath: path.join(root, 'v19'), repoPaths: { acme: '/somewhere/else' } }
        }, list);
        assert.deepStrictEqual(overridden.get('acme'), { path: '/somewhere/else', source: 'override' });

        const missing = await locateRepoCheckouts(repos, { settings: { customAddonsPath: path.join(root, 'nope') } }, list);
        assert.deepStrictEqual(missing.get('acme'), { path: path.join(root, 'v17', 'acme'), source: 'default' });
    });
});
