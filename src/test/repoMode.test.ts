import * as assert from 'assert';
import { RepoModel, normalizeBranchMode } from '../models/repo';
import { describeModeChange } from '../services/repoPaths';

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

    test('names the exact directories before creating them', () => {
        const message = describeModeChange('psae-internal', 'worktree', '/home/dev/odoo-dev', ['17.0', '19.0']);
        // The user chose the provisioning root without picking it per repo, so
        // the confirmation has to say where their code will now live.
        assert.ok(message.includes('/home/dev/odoo-dev/psae-internal@17.0'));
        assert.ok(message.includes('/home/dev/odoo-dev/psae-internal@19.0'));
        assert.ok(message.toLowerCase().includes('edit'));
    });

    test('describes turning the mode back off', () => {
        const message = describeModeChange('psae-internal', 'checkout', '/home/dev/odoo-dev', ['19.0']);
        assert.ok(message.toLowerCase().includes('remove'));
        assert.ok(message.includes('psae-internal'));
    });
});
