import * as assert from 'assert';
import { parseWorktreeList, findWorktreeForBranch, managedBranchName, branchSatisfiesTarget ,
    classifyBranchConflict,
    WorktreeEntry
} from '../services/worktree';

const PORCELAIN = `worktree /home/dev/odoo
HEAD bbe85efc259f1f2c9c3f0f5f9c1d2e3f4a5b6c7d
branch refs/heads/19.0

worktree /home/dev/versions/odoo-17.0
HEAD 1122334455667788990011223344556677889900
branch refs/heads/17.0

worktree /home/dev/versions/odoo-detached
HEAD aabbccddeeff00112233445566778899aabbccdd
detached

`;

suite('Worktree listing', () => {
    test('parses paths and branches from porcelain output', () => {
        assert.deepStrictEqual(parseWorktreeList(PORCELAIN), [
            { path: '/home/dev/odoo', branch: '19.0' },
            { path: '/home/dev/versions/odoo-17.0', branch: '17.0' },
            { path: '/home/dev/versions/odoo-detached', branch: undefined }
        ]);
    });

    test('returns an empty list for empty output', () => {
        assert.deepStrictEqual(parseWorktreeList(''), []);
    });

    test('finds the worktree holding a branch', () => {
        const entries = parseWorktreeList(PORCELAIN);
        assert.strictEqual(findWorktreeForBranch(entries, '17.0')?.path, '/home/dev/versions/odoo-17.0');
        assert.strictEqual(findWorktreeForBranch(entries, '19.0')?.path, '/home/dev/odoo');
    });

    test('returns undefined when no worktree holds the branch', () => {
        assert.strictEqual(findWorktreeForBranch(parseWorktreeList(PORCELAIN), '18.0'), undefined);
    });

    test('namespaces the managed branch for a worktree', () => {
        assert.strictEqual(managedBranchName('19.0'), 'odt/19.0');
        assert.strictEqual(managedBranchName('saas-19.2'), 'odt/saas-19.2');
    });

    test('accepts the managed branch as satisfying its target series', () => {
        assert.strictEqual(branchSatisfiesTarget('odt/19.0', '19.0'), true);
        assert.strictEqual(branchSatisfiesTarget('19.0', '19.0'), true);
    });

    test('rejects a different branch, and a detached or missing head', () => {
        assert.strictEqual(branchSatisfiesTarget('17.0', '19.0'), false);
        assert.strictEqual(branchSatisfiesTarget('odt/17.0', '19.0'), false);
        assert.strictEqual(branchSatisfiesTarget(undefined, '19.0'), false);
        assert.strictEqual(branchSatisfiesTarget(null, '19.0'), false);
    });

    test('detects when the managed branch is held by another worktree', () => {
        const entries: WorktreeEntry[] = [
            { path: '/src/odoo', branch: '17.0' },
            { path: '/old/root/odoo-19.0', branch: 'odt/19.0' }
        ];
        const present = (candidate: string) => candidate === '/old/root/odoo-19.0';

        // The other worktree is real: adopt it rather than duplicating.
        assert.deepStrictEqual(
            classifyBranchConflict(entries, 'odt/19.0', '/new/root/odoo-19.0', present),
            { kind: 'live', path: '/old/root/odoo-19.0' }
        );

        // Directory deleted by hand: git still reserves the branch, so the
        // record has to be pruned before the branch can be checked out again.
        assert.deepStrictEqual(
            classifyBranchConflict(entries, 'odt/19.0', '/new/root/odoo-19.0', () => false),
            { kind: 'stale', path: '/old/root/odoo-19.0' }
        );
    });

    test('reports no conflict for the destination itself or an unheld branch', () => {
        const entries: WorktreeEntry[] = [{ path: '/root/odoo-19.0', branch: 'odt/19.0' }];
        // Same path: that is the ordinary "already provisioned" reuse.
        assert.deepStrictEqual(
            classifyBranchConflict(entries, 'odt/19.0', '/root/odoo-19.0', () => true),
            { kind: 'none' }
        );
        assert.deepStrictEqual(
            classifyBranchConflict(entries, 'odt/18.0', '/root/odoo-18.0', () => true),
            { kind: 'none' }
        );
        assert.deepStrictEqual(classifyBranchConflict([], 'odt/19.0', '/root/x', () => true), { kind: 'none' });
    });
});
