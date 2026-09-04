/**
 * Brief items 4 and 5, driven against real git.
 *
 * Item 4 is the move/detach arbitration: it runs `git switch` and
 * `git checkout --detach` in a directory the user owns, and nothing had ever
 * verified that the checkout lands where the dialog promises. Item 5 is the
 * rule that a *blocking modal* must never come from a sync nobody asked for.
 *
 * Both are asserted on the resulting git state rather than on a screenshot,
 * which is stricter than clicking through it: a dialog that says "moved to
 * main" and leaves the checkout elsewhere passes a visual check and fails here.
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
    }).trim();
}

function head(repo: string): string {
    return git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
}

function buildRepo(root: string, name: string): string {
    const repo = path.join(root, name);
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'initial');
    git(repo, 'branch', '17.0-acme');
    git(repo, 'branch', '19.0-acme');
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

/**
 * Replaces the dialogs for one call and records what was asked.
 *
 * `modals` counts only `{ modal: true }` calls, because that is the distinction
 * item 5 turns on: a dismissible notification from a sync is fine, a blocking
 * dialog is not.
 */
async function withStubbedDialogs<T>(
    answers: { modal?: string; quickPick?: string },
    body: () => Promise<T>
): Promise<{ result: T; modals: string[]; warnings: string[]; picks: unknown[][] }> {
    const realWarn = vscode.window.showWarningMessage;
    const realPick = vscode.window.showQuickPick;
    const modals: string[] = [];
    const warnings: string[] = [];
    const picks: unknown[][] = [];

    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage =
        (message: string, options?: unknown) => {
            if (options && typeof options === 'object' && (options as { modal?: boolean }).modal) {
                modals.push(message);
                return Promise.resolve(answers.modal);
            }
            warnings.push(message);
            return Promise.resolve(undefined);
        };
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = (items: unknown[]) => {
        picks.push(items);
        return Promise.resolve(answers.quickPick);
    };

    try {
        const result = await body();
        return { result, modals, warnings, picks };
    } finally {
        (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = realWarn;
        (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = realPick;
    }
}

suite('Source-conflict arbitration against real git', function () {
    this.timeout(60000);

    let root: string;
    let repo: string;
    let dest: string;

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-conflict-'));
        repo = buildRepo(root, 'acme');
        dest = path.join(root, 'acme@17.0-acme');
        // The conflict: the source checkout holds the branch the copy needs.
        git(repo, 'switch', '17.0-acme');
    });

    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('item 4.1 — Move is offered before Detach, and the consequence is stated', async () => {
        const { modals } = await withStubbedDialogs({}, () =>
            ensureCustomWorktrees([resolved(repo, 'acme', '17.0-acme', dest)], undefined, { interactive: true }));

        assert.strictEqual(modals.length, 1, 'expected exactly one modal');
        const message = modals[0];
        assert.ok(message.includes('17.0-acme'), message);
        // The dialog has to say what detaching costs before it is chosen.
        assert.ok(/detach/i.test(message), `detach consequence missing:\n${message}`);
    });

    test('item 4.2 — Move really moves the checkout, and the copy is created', async () => {
        const { result, picks } = await withStubbedDialogs(
            { modal: 'Move to Another Branch', quickPick: 'main' },
            () => ensureCustomWorktrees([resolved(repo, 'acme', '17.0-acme', dest)], undefined, { interactive: true })
        );

        assert.strictEqual(head(repo), 'main', 'the source checkout did not move where the dialog promised');
        assert.ok(fs.existsSync(dest), 'the copy was not created');
        assert.strictEqual(head(dest), '17.0-acme');
        assert.strictEqual(result.problems.length, 0, result.problems.join('; '));
        assert.strictEqual(result.ready[0].path, dest);

        // The branch being freed must not be offered as somewhere to move to.
        assert.ok(!(picks[0] as string[]).includes('17.0-acme'));
    });

    test('item 4.3 — Detach detaches HEAD and still creates the copy', async () => {
        const { result } = await withStubbedDialogs({ modal: 'Detach It' }, () =>
            ensureCustomWorktrees([resolved(repo, 'acme', '17.0-acme', dest)], undefined, { interactive: true }));

        assert.strictEqual(head(repo), 'HEAD', 'the source checkout is not detached');
        assert.ok(fs.existsSync(dest));
        assert.strictEqual(head(dest), '17.0-acme');
        assert.strictEqual(result.problems.length, 0, result.problems.join('; '));
    });

    test('item 4.4 — dismissing the modal changes nothing', async () => {
        const { result } = await withStubbedDialogs({}, () =>
            ensureCustomWorktrees([resolved(repo, 'acme', '17.0-acme', dest)], undefined, { interactive: true }));

        assert.strictEqual(head(repo), '17.0-acme', 'the checkout moved without an answer');
        assert.ok(!fs.existsSync(dest));
        assert.strictEqual(result.problems.length, 1);
        assert.strictEqual(result.ready[0].isWorktree, false);
    });

    test('item 4.5 — a dirty checkout is refused, never stashed or forced', async () => {
        fs.writeFileSync(path.join(repo, 'README.md'), '# uncommitted work\n');
        fs.writeFileSync(path.join(repo, 'untracked.txt'), 'scratch\n');

        const { modals, warnings } = await withStubbedDialogs({ modal: 'Detach It' }, () =>
            ensureCustomWorktrees([resolved(repo, 'acme', '17.0-acme', dest)], undefined, { interactive: true }));

        assert.strictEqual(modals.length, 0, 'a dirty checkout must be refused, not arbitrated');
        assert.strictEqual(warnings.length, 1);
        assert.ok(warnings[0].includes('README.md'), warnings[0]);

        assert.strictEqual(head(repo), '17.0-acme');
        assert.strictEqual(
            fs.readFileSync(path.join(repo, 'README.md'), 'utf8'),
            '# uncommitted work\n',
            'tracked changes were modified'
        );
        assert.ok(fs.existsSync(path.join(repo, 'untracked.txt')), 'untracked file disappeared');
        assert.strictEqual(git(repo, 'stash', 'list'), '', 'work was stashed behind the user');
    });

    test('item 4.6 — declining the move picker leaves the checkout alone', async () => {
        const { result } = await withStubbedDialogs({ modal: 'Move to Another Branch' }, () =>
            ensureCustomWorktrees([resolved(repo, 'acme', '17.0-acme', dest)], undefined, { interactive: true }));

        assert.strictEqual(head(repo), '17.0-acme');
        assert.ok(!fs.existsSync(dest));
        assert.strictEqual(result.problems.length, 1);
    });
});

suite('A sync never blocks the developer', function () {
    this.timeout(60000);

    let root: string;

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-sync-'));
    });

    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('item 5 — repeated non-interactive passes raise no modal and touch no checkout', async () => {
        // Two repositories, both conflicting, both wanted on two branches - the
        // shape the debugger sync produces when several versions are provisioned
        // and it runs once per version on its 200ms debounce.
        const acme = buildRepo(root, 'acme');
        const other = buildRepo(root, 'other');
        git(acme, 'switch', '17.0-acme');
        git(other, 'switch', '19.0-acme');

        const entries = [
            resolved(acme, 'acme', '17.0-acme', path.join(root, 'acme@17.0-acme')),
            resolved(acme, 'acme', '19.0-acme', path.join(root, 'acme@19.0-acme')),
            resolved(other, 'other', '17.0-acme', path.join(root, 'other@17.0-acme')),
            resolved(other, 'other', '19.0-acme', path.join(root, 'other@19.0-acme'))
        ];

        const { modals, warnings } = await withStubbedDialogs({ modal: 'Detach It' }, async () => {
            // Three passes: one command, one debug session ending, one refresh.
            for (let pass = 0; pass < 3; pass++) {
                await ensureCustomWorktrees(entries, undefined, { interactive: false });
            }
        });

        assert.strictEqual(modals.length, 0, `a background sync raised ${modals.length} modal(s)`);
        assert.strictEqual(warnings.length, 0, 'a background sync warned about the working tree');

        // Neither checkout moved, on any pass.
        assert.strictEqual(head(acme), '17.0-acme');
        assert.strictEqual(head(other), '19.0-acme');

        // The copies that needed no arbitration were still built.
        assert.ok(fs.existsSync(path.join(root, 'acme@19.0-acme')), 'the free branch was not built');
        assert.ok(fs.existsSync(path.join(root, 'other@17.0-acme')), 'the free branch was not built');

        // And the blocked ones are reported so the offer can name them.
        const last = await ensureCustomWorktrees(entries, undefined, { interactive: false });
        assert.deepStrictEqual(last.needsResolution.sort(), ['acme', 'other']);
    });

    test('item 5 — a repeated sync is idempotent once the copies exist', async () => {
        const acme = buildRepo(root, 'acme');
        const dest = path.join(root, 'acme@17.0-acme');
        const entry = [resolved(acme, 'acme', '17.0-acme', dest)];

        await ensureCustomWorktrees(entry, undefined, { interactive: false });
        const { modals, warnings, result } = await withStubbedDialogs({ modal: 'Detach It' }, () =>
            ensureCustomWorktrees(entry, undefined, { interactive: false }));

        assert.strictEqual(modals.length, 0);
        assert.strictEqual(warnings.length, 0);
        assert.strictEqual(result.problems.length, 0, result.problems.join('; '));
        assert.strictEqual(result.ready[0].path, dest);
    });
});
