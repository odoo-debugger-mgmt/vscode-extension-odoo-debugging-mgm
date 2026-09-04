/**
 * Integration tests for the per-branch copies, against real git.
 *
 * `ensureCustomWorktrees` is where the sync/command split lives, and the split
 * is about *whether the user is asked*. That cannot be asserted over pure data:
 * it needs a real repository whose checkout is really holding the branch a
 * worktree really needs. These run inside the Extension Host, so a call that
 * wrongly decided to prompt would block here rather than pass quietly.
 */
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import { ensureCustomWorktrees } from '../services/customWorktree';
import { RepoModel } from '../models/repo';
import type { ResolvedRepo } from '../services/repoPaths';

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'test',
            GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_COMMITTER_NAME: 'test',
            GIT_COMMITTER_EMAIL: 'test@example.com'
        }
    });
}

/** A repository with `main` and `17.0-client`, checked out on `main`. */
function buildRepo(root: string, name: string): string {
    const repo = path.join(root, name);
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'initial');
    git(repo, 'branch', '17.0-client');
    return repo;
}

function resolved(repoPath: string, name: string, branch: string, dest: string): ResolvedRepo {
    return {
        repo: new RepoModel(name, repoPath, true, undefined, 'worktree'),
        path: dest,
        branch,
        mode: 'worktree',
        isWorktree: true
    };
}

suite('Per-branch copies against real git', function () {
    this.timeout(60000);

    let root: string;

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-worktree-'));
    });

    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('creates the copy when the source is not holding the branch', async () => {
        const repo = buildRepo(root, 'acme');
        const dest = path.join(root, 'acme@17.0-client');

        const result = await ensureCustomWorktrees(
            [resolved(repo, 'acme', '17.0-client', dest)],
            undefined,
            { interactive: false }
        );

        assert.strictEqual(result.problems.length, 0, result.problems.join('; '));
        assert.strictEqual(result.needsResolution.length, 0);
        assert.ok(fs.existsSync(dest), 'worktree directory was not created');
        assert.match(git(dest, 'rev-parse', '--abbrev-ref', 'HEAD'), /17\.0-client/);
        assert.strictEqual(result.ready[0].path, dest);
        assert.strictEqual(result.ready[0].isWorktree, true);
    });

    test('a non-interactive run never prompts, and reports the conflict instead', async () => {
        // The source checkout sits on the branch the copy needs. Before the
        // split this raised a modal from the debugger sync and then ran
        // `git switch` in the user's own checkout.
        const repo = buildRepo(root, 'acme');
        git(repo, 'switch', '17.0-client');
        const dest = path.join(root, 'acme@17.0-client');

        let prompted = false;
        const realModal = vscode.window.showWarningMessage;
        const realPick = vscode.window.showQuickPick;
        (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (...args: unknown[]) => {
            prompted = true;
            return realModal.apply(vscode.window, args as never);
        };
        (vscode.window as { showQuickPick: unknown }).showQuickPick = (...args: unknown[]) => {
            prompted = true;
            return realPick.apply(vscode.window, args as never);
        };

        try {
            const result = await ensureCustomWorktrees(
                [resolved(repo, 'acme', '17.0-client', dest)],
                undefined,
                { interactive: false }
            );

            assert.strictEqual(prompted, false, 'a background sync asked the user a question');
            assert.deepStrictEqual(result.needsResolution, ['acme']);
            assert.strictEqual(result.problems.length, 1);

            // Falls back to the source checkout rather than blocking.
            assert.strictEqual(result.ready[0].path, repo);
            assert.strictEqual(result.ready[0].isWorktree, false);

            // And it left the user's checkout exactly where it was.
            assert.match(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), /17\.0-client/);
            assert.ok(!fs.existsSync(dest), 'a copy was created despite the conflict');
        } finally {
            (vscode.window as { showWarningMessage: unknown }).showWarningMessage = realModal;
            (vscode.window as { showQuickPick: unknown }).showQuickPick = realPick;
        }
    });

    test('a dirty source is refused rather than stashed or forced', async () => {
        const repo = buildRepo(root, 'acme');
        git(repo, 'switch', '17.0-client');
        fs.writeFileSync(path.join(repo, 'README.md'), '# uncommitted\n');
        const dest = path.join(root, 'acme@17.0-client');

        const result = await ensureCustomWorktrees(
            [resolved(repo, 'acme', '17.0-client', dest)],
            undefined,
            { interactive: false }
        );

        assert.strictEqual(result.needsResolution.length, 1);
        assert.strictEqual(
            fs.readFileSync(path.join(repo, 'README.md'), 'utf8'),
            '# uncommitted\n',
            'the working tree was modified'
        );
    });

    test('one blocked repository does not stop the others', async () => {
        const blocked = buildRepo(root, 'blocked');
        git(blocked, 'switch', '17.0-client');
        const fine = buildRepo(root, 'fine');
        const fineDest = path.join(root, 'fine@17.0-client');

        const result = await ensureCustomWorktrees(
            [
                resolved(blocked, 'blocked', '17.0-client', path.join(root, 'blocked@17.0-client')),
                resolved(fine, 'fine', '17.0-client', fineDest)
            ],
            undefined,
            { interactive: false }
        );

        assert.deepStrictEqual(result.needsResolution, ['blocked']);
        assert.ok(fs.existsSync(fineDest), 'the unblocked repository was not built');
    });
});
