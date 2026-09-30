/**
 * A database switch checks a branch out in a checkout this window may not
 * have open - with a folder per version, the other version's clone never is.
 * Refreshing Source Control with the global `git.refresh` then made VS Code
 * raise "Git: There are no available repositories" on every switch.
 */
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import { checkoutRepoBranch } from '../services/checkout';

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

suite('Checking out in a repository this window does not have open', function () {
    this.timeout(30000);
    let repo: string;

    setup(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-checkout-'));
        git(repo, 'init', '-q', '-b', 'main');
        fs.writeFileSync(path.join(repo, 'README.md'), '# x\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-q', '-m', 'initial');
        git(repo, 'branch', '19.0-dev');
    });

    teardown(() => {
        fs.rmSync(repo, { recursive: true, force: true });
    });

    test('switches the branch without asking VS Code to refresh every repository', async () => {
        const commands = vscode.commands as unknown as { executeCommand: (...args: unknown[]) => Thenable<unknown> };
        const real = commands.executeCommand;
        const called: unknown[] = [];
        commands.executeCommand = (...args: unknown[]) => {
            called.push(args[0]);
            return real.apply(vscode.commands, args as never);
        };
        try {
            const result = await checkoutRepoBranch(repo, '19.0-dev');

            assert.strictEqual(result.ok, true, result.message);
            assert.strictEqual(git(repo, 'branch', '--show-current'), '19.0-dev');
            assert.ok(!called.includes('git.refresh'), 'git.refresh raises a modal in a window without this repository');
        } finally {
            commands.executeCommand = real;
        }
    });
});
