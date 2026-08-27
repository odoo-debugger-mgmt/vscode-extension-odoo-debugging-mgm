import * as assert from 'assert';
import { parseWorktreeList, findWorktreeForBranch } from '../services/worktree';

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
});
