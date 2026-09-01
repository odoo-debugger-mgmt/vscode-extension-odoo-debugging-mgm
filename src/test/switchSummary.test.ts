import * as assert from 'assert';
import { describeSwitch } from '../services/environment';

suite('Switch summary wording', () => {
    test('says the worktree is reused when no checkout is needed', () => {
        // The provisioned case: the version owns a worktree already on the
        // right branch, so nothing is checked out. Saying "branch 19.0" here
        // told the user a branch switch was about to happen.
        assert.deepStrictEqual(
            describeSwitch({
                versionName: 'Odoo 19.0',
                core: { branch: '19.0', needsCheckout: false, missingEnvironment: false },
                repoBranchCount: 0
            }),
            ['version "Odoo 19.0"', 'its existing "19.0" worktree']
        );
    });

    test('names the branch only when one is actually checked out', () => {
        assert.deepStrictEqual(
            describeSwitch({
                versionName: 'Odoo 19.0',
                core: { branch: '19.0', needsCheckout: true, missingEnvironment: false },
                repoBranchCount: 2
            }),
            ['version "Odoo 19.0"', 'core branch "19.0"', '2 project repo branch(es)']
        );
    });

    test('reports a missing environment rather than promising a checkout', () => {
        assert.deepStrictEqual(
            describeSwitch({
                versionName: 'Odoo 19.0',
                core: { branch: '19.0', needsCheckout: false, missingEnvironment: true },
                repoBranchCount: 0
            }),
            ['version "Odoo 19.0"', 'core repositories for "19.0" are missing']
        );
    });

    test('describes a project-repo-only switch', () => {
        assert.deepStrictEqual(
            describeSwitch({ repoBranchCount: 3 }),
            ['3 project repo branch(es)']
        );
    });

    test('describes nothing when there is nothing to do', () => {
        assert.deepStrictEqual(describeSwitch({ repoBranchCount: 0 }), []);
    });
});
