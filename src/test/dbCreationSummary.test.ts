import * as assert from 'assert';
import { describeRepoBranchChoice } from '../dbs';

suite('Database creation repo branches', () => {
    test('summarizes the branches chosen', () => {
        const summary = describeRepoBranchChoice([
            { repoName: 'psae-internal', repoPath: '/custom/psae-internal', branch: '19.0' },
            { repoName: 'shared', repoPath: '/custom/shared', branch: 'main' }
        ]);
        assert.ok(summary.includes('psae-internal'));
        assert.ok(summary.includes('19.0'));
        assert.ok(summary.includes('shared'));
    });

    test('says plainly when none were chosen', () => {
        // "Skip" is a legitimate answer and must not read like a failure.
        assert.strictEqual(describeRepoBranchChoice([]), 'no project repo branches');
    });

    test('collapses a long list rather than printing every repo', () => {
        const many = Array.from({ length: 8 }, (_, index) => ({
            repoName: `repo-${index}`,
            repoPath: `/custom/repo-${index}`,
            branch: '19.0'
        }));
        const summary = describeRepoBranchChoice(many);
        assert.ok(summary.includes('repo-0'));
        assert.ok(summary.includes('8'));
        // Not every name: this goes in a notification, not a report.
        assert.ok(!summary.includes('repo-7'));
    });
});
