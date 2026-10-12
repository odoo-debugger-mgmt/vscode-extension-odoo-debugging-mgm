import * as assert from 'assert';
import { parseRefList, isOdooSeriesBranch, rankBranches } from '../services/gitService';
import { branchRowDescription } from '../commands/branchPick';

suite('Branch listing', () => {
    test('strips remote prefixes, drops HEAD and deduplicates', () => {
        const stdout = [
            '19.0',
            'origin/19.0',
            'origin/17.0',
            'origin/HEAD',
            'dev/saas-15.1-mass_mailing-test-dmo',
            '',
            '  18.0  '
        ].join('\n');

        assert.deepStrictEqual(parseRefList(stdout), [
            '19.0',
            '17.0',
            'dev/saas-15.1-mass_mailing-test-dmo',
            '18.0'
        ]);
    });

    test('recognizes Odoo series branches', () => {
        assert.strictEqual(isOdooSeriesBranch('17.0'), true);
        assert.strictEqual(isOdooSeriesBranch('saas-17.4'), true);
        assert.strictEqual(isOdooSeriesBranch('master'), true);
    });

    test('rejects the PR branches that dominate the odoo remote', () => {
        assert.strictEqual(isOdooSeriesBranch('saas-15.1-mass_mailing-test-dmo'), false);
        assert.strictEqual(isOdooSeriesBranch('dev/saas-15.1-quick-fix'), false);
        assert.strictEqual(isOdooSeriesBranch('19.0-april-onboarding-task-6076324'), false);
        assert.strictEqual(isOdooSeriesBranch(''), false);
    });

    test('ranks series branches ahead of everything else, newest first', () => {
        const ranked = rankBranches(['saas-17.4', 'my-feature', '17.0', 'master', '19.0']);
        assert.deepStrictEqual(ranked, ['master', '19.0', 'saas-17.4', '17.0', 'my-feature']);
    });

    test('orders saas releases after the major they follow', () => {
        assert.deepStrictEqual(
            rankBranches(['17.0', 'saas-17.4', 'saas-17.2', '18.0']),
            ['18.0', 'saas-17.4', 'saas-17.2', '17.0']
        );
    });
});

suite('Rows of the repository branch picker', () => {
    test('"current branch" is what the checkout is on, and the row it opens on is only "suggested"', () => {
        // The picker opened on 17.0-alt, a series name, and called it the
        // current branch while the checkout was on staging.
        assert.strictEqual(branchRowDescription('staging', 'staging', '17.0-alt'), 'current branch');
        assert.strictEqual(branchRowDescription('17.0-alt', 'staging', '17.0-alt'), 'suggested');
        assert.strictEqual(branchRowDescription('main', 'staging', '17.0-alt'), undefined);
    });

    test('the branch the checkout is on stays "current branch" when it is also the suggestion', () => {
        assert.strictEqual(branchRowDescription('17.0', '17.0', '17.0'), 'current branch');
    });

    test('a checkout whose branch is unknown marks only the suggestion', () => {
        assert.strictEqual(branchRowDescription('17.0', null, '17.0'), 'suggested');
    });
});
