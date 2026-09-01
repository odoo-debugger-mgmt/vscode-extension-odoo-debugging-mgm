import * as assert from 'assert';
import { RepoModel, normalizeBranchMode } from '../models/repo';

suite('Repository branch mode', () => {
    test('defaults to checkout, which is the pre-existing behaviour', () => {
        const repo = new RepoModel('psae-internal', '/custom/psae-internal');
        assert.strictEqual(repo.branchMode, 'checkout');
    });

    test('accepts an explicit worktree mode', () => {
        const repo = new RepoModel('psae-internal', '/custom/psae-internal', false, undefined, 'worktree');
        assert.strictEqual(repo.branchMode, 'worktree');
    });

    test('normalizes anything unrecognized back to checkout', () => {
        // Stored data predates this field, so undefined is the common case.
        assert.strictEqual(normalizeBranchMode(undefined), 'checkout');
        assert.strictEqual(normalizeBranchMode(''), 'checkout');
        assert.strictEqual(normalizeBranchMode('nonsense'), 'checkout');
        assert.strictEqual(normalizeBranchMode('worktree'), 'worktree');
        assert.strictEqual(normalizeBranchMode('checkout'), 'checkout');
    });
});
