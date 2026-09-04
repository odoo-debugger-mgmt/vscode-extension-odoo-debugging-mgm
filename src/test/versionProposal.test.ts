import * as assert from 'assert';
import { branchToSeries, proposeVersions } from '../services/versionProposal';

suite('Version proposal', () => {
    test('maps a prefixed custom branch to its Odoo series', () => {
        assert.strictEqual(branchToSeries('17.0-bunka'), '17.0');
        assert.strictEqual(branchToSeries('saas-18.4-client'), 'saas-18.4');
        assert.strictEqual(branchToSeries('19.0'), '19.0');
    });

    test('keeps master and ignores branches with no series', () => {
        assert.strictEqual(branchToSeries('master'), 'master');
        assert.strictEqual(branchToSeries('MASTER'), 'master');
        assert.strictEqual(branchToSeries('feature/login'), undefined);
        assert.strictEqual(branchToSeries(''), undefined);
    });

    test('offers repo-derived series first, picked, with the repo as the reason', () => {
        const candidates = proposeVersions(
            [{ repoName: 'psae-internal', branch: '17.0-bunka' }],
            ['19.0', '18.0', '17.0'],
            []
        );

        assert.strictEqual(candidates[0].branch, '17.0');
        assert.strictEqual(candidates[0].picked, true);
        assert.ok(candidates[0].reason.includes('psae-internal'));
        assert.ok(candidates[0].reason.includes('17.0-bunka'));
        // The series list must not repeat it.
        assert.strictEqual(candidates.filter(entry => entry.branch === '17.0').length, 1);
    });

    test('picks the newest series when no repository suggests one', () => {
        const candidates = proposeVersions([], ['19.0', '18.0', '17.0'], []);

        assert.deepStrictEqual(candidates.map(entry => entry.branch), ['19.0', '18.0', '17.0']);
        assert.deepStrictEqual(candidates.map(entry => entry.picked), [true, false, false]);
    });

    test('drops branches that already have a version', () => {
        const candidates = proposeVersions(
            [{ repoName: 'psae-internal', branch: '19.0-bunka' }],
            ['19.0', '18.0'],
            ['19.0']
        );

        assert.deepStrictEqual(candidates.map(entry => entry.branch), ['18.0']);
    });

    test('caps the series rows so the picker stays a glance', () => {
        const candidates = proposeVersions(
            [],
            ['master', '19.0', '18.0', '17.0', '16.0', '15.0'],
            []
        );

        assert.strictEqual(candidates.length, 4);
    });

    test('deduplicates repositories that agree on a series', () => {
        const candidates = proposeVersions(
            [
                { repoName: 'psae-internal', branch: '17.0-bunka' },
                { repoName: 'client-addons', branch: '17.0-bunka' }
            ],
            [],
            []
        );

        assert.strictEqual(candidates.length, 1);
        assert.strictEqual(candidates[0].branch, '17.0');
    });

    test('master is never the pre-ticked default', () => {
        // master ranks first, so the out-of-the-box answer used to spend ~2 GB
        // building the development branch.
        const candidates = proposeVersions([], ['master', '19.0', '18.0'], []);
        assert.strictEqual(candidates[0].branch, 'master');
        assert.strictEqual(candidates[0].picked, false);
        assert.strictEqual(candidates[1].branch, '19.0');
        assert.strictEqual(candidates[1].picked, true);
    });

    test('exactly one series is pre-ticked when nothing else suggested a version', () => {
        const picked = proposeVersions([], ['19.0', '18.0', '17.0'], []).filter(entry => entry.picked);
        assert.strictEqual(picked.length, 1);
        assert.strictEqual(picked[0].branch, '19.0');
    });

    test('a repo-derived candidate keeps the series rows unticked', () => {
        const candidates = proposeVersions(
            [{ repoName: 'acme', branch: '17.0-acme' }],
            ['19.0', '18.0'],
            []
        );
        assert.deepStrictEqual(
            candidates.filter(entry => entry.picked).map(entry => entry.branch),
            ['17.0']
        );
    });
});
