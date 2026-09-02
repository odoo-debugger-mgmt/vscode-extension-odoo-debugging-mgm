import * as assert from 'assert';
import { countCustomRepos } from '../services/setupDetection';

suite('Custom addons detection', () => {
    test('counts git repositories that are not the core ones', () => {
        const count = countCustomRepos([
            { name: 'psae-internal', isGitRepo: true, hasOdooBin: false },
            { name: 'client-addons', isGitRepo: true, hasOdooBin: false }
        ]);

        assert.strictEqual(count, 2);
    });

    test('excludes the Odoo source repository and its siblings', () => {
        const count = countCustomRepos([
            { name: 'odoo', isGitRepo: true, hasOdooBin: true },
            { name: 'enterprise', isGitRepo: true, hasOdooBin: false },
            { name: 'design-themes', isGitRepo: true, hasOdooBin: false },
            { name: 'psae-internal', isGitRepo: true, hasOdooBin: false }
        ]);

        assert.strictEqual(count, 1);
    });

    test('ignores directories that are not git repositories', () => {
        const count = countCustomRepos([
            { name: 'notes', isGitRepo: false, hasOdooBin: false },
            { name: 'psae-internal', isGitRepo: true, hasOdooBin: false }
        ]);

        assert.strictEqual(count, 1);
    });

    test('a fork named after the client still counts as core when it has odoo-bin', () => {
        const count = countCustomRepos([{ name: 'bunka-odoo', isGitRepo: true, hasOdooBin: true }]);

        assert.strictEqual(count, 0);
    });
});
