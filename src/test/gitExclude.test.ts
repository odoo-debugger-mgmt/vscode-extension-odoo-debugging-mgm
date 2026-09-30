/**
 * A folder window that is itself a git clone keeps the extension's
 * launch.json out of that repository's git status (twelfth run).
 */
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LAUNCH_EXCLUDE_LINE, excludeDataFileFromGit, excludeFromGit, excludeLaunchFromGit, withExcludeLine } from '../services/gitExclude';

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

suite('Keeping launch.json out of a clone\'s git status', () => {
    test('the line is added once, after whatever is there', () => {
        assert.strictEqual(withExcludeLine('', LAUNCH_EXCLUDE_LINE), `# Odoo DevTools writes its launch entries here\n${LAUNCH_EXCLUDE_LINE}\n`);
        assert.match(withExcludeLine('*.log', LAUNCH_EXCLUDE_LINE)!, /^\*\.log\n# Odoo DevTools/);
        assert.strictEqual(withExcludeLine(`x\n${LAUNCH_EXCLUDE_LINE}\n`, LAUNCH_EXCLUDE_LINE), undefined);
        assert.strictEqual(withExcludeLine('.vscode/launch.json\n', LAUNCH_EXCLUDE_LINE), undefined);
    });

    test('against real git: untracked launch.json no longer shows; a tracked one is left alone', async function () {
        this.timeout(30000);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-exclude-'));
        try {
            const clone = path.join(root, 'acme');
            fs.mkdirSync(clone);
            git(clone, 'init', '-q', '-b', 'main');
            fs.writeFileSync(path.join(clone, 'README.md'), '# acme\n');
            git(clone, 'add', '.');
            git(clone, 'commit', '-q', '-m', 'initial');
            fs.mkdirSync(path.join(clone, '.vscode'));
            fs.writeFileSync(path.join(clone, '.vscode', 'launch.json'), '{}');

            await excludeLaunchFromGit(clone);
            assert.strictEqual(git(clone, 'status', '--porcelain'), '', 'launch.json still shows as untracked');

            const tracked = path.join(root, 'team');
            fs.mkdirSync(path.join(tracked, '.vscode'), { recursive: true });
            git(tracked, 'init', '-q', '-b', 'main');
            fs.writeFileSync(path.join(tracked, '.vscode', 'launch.json'), '{}');
            git(tracked, 'add', '.');
            git(tracked, 'commit', '-q', '-m', 'team launch.json');
            await excludeLaunchFromGit(tracked);
            // A git whose init template holds no info/ has no exclude file at
            // all: missing reads as empty, and either way nothing was added.
            const excludeFile = path.join(tracked, '.git', 'info', 'exclude');
            const exclude = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
            assert.doesNotMatch(exclude, /Odoo DevTools/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('a clone moved to its own data file keeps it, and its settings, out of git status', async function () {
        // Fifteenth run: This workspace only left two untracked files in the clone.
        this.timeout(30000);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-exclude-'));
        try {
            const clone = path.join(root, 'acme');
            fs.mkdirSync(path.join(clone, '.vscode'), { recursive: true });
            git(clone, 'init', '-q', '-b', 'main');
            fs.writeFileSync(path.join(clone, 'README.md'), '# acme\n');
            git(clone, 'add', 'README.md');
            git(clone, 'commit', '-q', '-m', 'initial');
            const dataFile = path.join(clone, '.vscode', 'odoo-debugger-data.json');
            fs.writeFileSync(dataFile, '{}');
            fs.writeFileSync(path.join(clone, '.vscode', 'settings.json'), '{}');

            await excludeDataFileFromGit(dataFile);
            await excludeFromGit(clone, '/.vscode/settings.json', 'settings');
            assert.strictEqual(git(clone, 'status', '--porcelain'), '');
            // A data file anywhere but a .vscode folder is not a clone's business.
            await excludeDataFileFromGit(path.join(root, 'elsewhere.json'));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
