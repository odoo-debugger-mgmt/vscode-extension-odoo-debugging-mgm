import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import {
    SOURCE_REPOS,
    cloneShallow,
    folderNameFor,
    isInside,
    isValidBranchName,
    planDownload,
    seriesFromLsRemote
} from '../services/sourceDownload';

suite('Download Odoo sources', () => {
    let tmp: string;

    setup(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'odt-dl-'));
    });

    teardown(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    test('ls-remote output gives the series branches, newest first', () => {
        const stdout = [
            'aaa\trefs/heads/16.0',
            'bbb\trefs/heads/master',
            'ccc\trefs/heads/saas-17.4',
            'ddd\trefs/heads/17.0',
            'eee\trefs/heads/17.0-fix-something-abc',
            'fff\trefs/heads/staging.17.0',
            ''
        ].join('\n');
        assert.deepStrictEqual(seriesFromLsRemote(stdout), ['master', 'saas-17.4', '17.0', '16.0']);
    });

    test('folders are named after the repository and the branch', () => {
        assert.strictEqual(folderNameFor(SOURCE_REPOS.odoo, '17.0'), 'odoo-17.0');
        assert.strictEqual(folderNameFor(SOURCE_REPOS.enterprise, 'saas-17.4'), 'enterprise-saas-17.4');
        assert.strictEqual(folderNameFor(SOURCE_REPOS.designThemes, 'master'), 'design-themes-master');
        assert.strictEqual(folderNameFor(SOURCE_REPOS.odoo, 'dev/17.0-x'), 'odoo-dev-17.0-x');
    });

    test('a typed branch name must be a plain git branch name', () => {
        for (const good of ['17.0', 'master', 'saas-17.4', '17.0-fix-x', 'dev/17.0_x']) {
            assert.ok(isValidBranchName(good), good);
        }
        for (const bad of ['', ' ', '-x', '--upload-pack=x', '17.0 x', 'a..b', 'a/', '/a', 'a.lock', 'a~1', 'a:b']) {
            assert.ok(!isValidBranchName(bad), JSON.stringify(bad));
        }
    });

    test('a folder that exists and is not empty is skipped; a missing or empty one is cloned', async () => {
        await fs.mkdir(path.join(tmp, 'enterprise-17.0'));
        await fs.mkdir(path.join(tmp, 'design-themes-17.0'));
        await fs.writeFile(path.join(tmp, 'design-themes-17.0', 'x'), 'x');
        const plan = await planDownload(tmp, [SOURCE_REPOS.odoo, SOURCE_REPOS.enterprise, SOURCE_REPOS.designThemes], '17.0');
        assert.deepStrictEqual(plan.clone.map(item => item.folder), [path.join(tmp, 'odoo-17.0'), path.join(tmp, 'enterprise-17.0')]);
        assert.deepStrictEqual(plan.skip.map(item => item.folder), [path.join(tmp, 'design-themes-17.0')]);
    });

    test('a file where the folder should be is skipped', async () => {
        await fs.writeFile(path.join(tmp, 'odoo-17.0'), 'x');
        const plan = await planDownload(tmp, [SOURCE_REPOS.odoo], '17.0');
        assert.deepStrictEqual(plan.clone, []);
        assert.strictEqual(plan.skip.length, 1);
    });

    test('isInside: the folder itself and anything below it', () => {
        assert.ok(isInside('/a/b', '/a/b'));
        assert.ok(isInside('/a/b/c', '/a/b'));
        assert.ok(!isInside('/a/bc', '/a/b'));
        assert.ok(!isInside('/a', '/a/b'));
    });

    suite('cloning from a local repository', () => {
        let origin: string;
        const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

        setup(async () => {
            origin = path.join(tmp, 'origin');
            await fs.mkdir(origin);
            git(origin, 'init', '-q', '-b', '17.0');
            git(origin, 'config', 'user.email', 't@example.com');
            git(origin, 'config', 'user.name', 'T');
            await fs.writeFile(path.join(origin, 'odoo-bin'), 'one');
            git(origin, 'add', '.');
            git(origin, 'commit', '-q', '-m', 'one');
            await fs.writeFile(path.join(origin, 'odoo-bin'), 'two');
            git(origin, 'commit', '-q', '-am', 'two');
            git(origin, 'branch', 'master');
        });

        test('a shallow single-branch clone of the branch', async () => {
            const dest = path.join(tmp, 'out', 'odoo-17.0');
            await fs.mkdir(path.dirname(dest));
            await cloneShallow([`file://${origin}`], '17.0', dest);
            assert.strictEqual(await fs.readFile(path.join(dest, 'odoo-bin'), 'utf8'), 'two');
            assert.strictEqual(git(dest, 'rev-parse', '--is-shallow-repository'), 'true');
            assert.strictEqual(git(dest, 'rev-list', '--count', 'HEAD'), '1');
            assert.strictEqual(git(dest, 'branch', '-r'), 'origin/17.0');
        });

        test('the next URL is tried when one fails, and an empty folder is reused', async () => {
            const dest = path.join(tmp, 'odoo-17.0');
            await fs.mkdir(dest);
            await cloneShallow([`file://${path.join(tmp, 'missing')}`, `file://${origin}`], '17.0', dest);
            assert.strictEqual(await fs.readFile(path.join(dest, 'odoo-bin'), 'utf8'), 'two');
        });

        test('a failed clone leaves no folder behind and gives the reason git gave', async () => {
            const dest = path.join(tmp, 'odoo-16.0');
            await assert.rejects(cloneShallow([`file://${origin}`], '16.0', dest), /Remote branch 16\.0 not found/);
            await assert.rejects(fs.stat(dest));
        });

        test('a cancelled clone leaves no folder behind', async () => {
            const dest = path.join(tmp, 'odoo-17.0');
            const source = new vscode.CancellationTokenSource();
            source.cancel();
            await assert.rejects(cloneShallow([`file://${origin}`], '17.0', dest, { token: source.token }));
            await assert.rejects(fs.stat(dest));
        });
    });
});
