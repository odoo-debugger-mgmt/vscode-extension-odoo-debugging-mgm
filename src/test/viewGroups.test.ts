import * as assert from 'assert';
import { groupViews } from '../services/views/viewGroups';
import type { ViewRow } from '../services/views/viewQueries';

function row(id: number, overrides: Partial<ViewRow> = {}): ViewRow {
    return {
        id, name: `view ${id}`, model: 'res.partner', type: 'form', active: false,
        inheritId: 1, xmlid: null, rootId: 1, isReport: false, writeDate: 0, ...overrides
    };
}

suite('View Doctor groups', () => {
    test('puts what the upgrade disabled first: still off, then re-enabled', () => {
        const inactive = [row(10), row(11), row(20)];
        const reported = new Map([[11, ['17.0']], [12, ['17.0', '18.0']], [10, ['18.0']]]);
        const groups = groupViews(inactive, reported, [row(12, { active: true })]);

        assert.deepStrictEqual(groups.upgradeDisabled.map(view => [view.id, view.active, view.versions]), [
            [10, false, ['18.0']],
            [11, false, ['17.0']],
            [12, true, ['17.0', '18.0']]
        ]);
        assert.deepStrictEqual(groups.upgradeVersions, ['17.0', '18.0']);
        assert.deepStrictEqual(groups.otherInactive.map(view => view.id), [20]);
        assert.deepStrictEqual(groups.missingIds, []);
    });

    test('keeps report fragments the upgrade broke, but hides them among the other inactive views', () => {
        const fragment = row(30, { type: 'qweb', isReport: false });
        const report = row(31, { type: 'qweb', isReport: true });
        const brokenFragment = row(32, { type: 'qweb', isReport: false });
        const groups = groupViews([fragment, report, brokenFragment], new Map([[32, ['18.0']]]), []);

        assert.deepStrictEqual(groups.upgradeDisabled.map(view => view.id), [32]);
        assert.deepStrictEqual(groups.otherInactive.map(view => view.id), [31]);
    });

    test('reports listed views that no longer exist', () => {
        const groups = groupViews([], new Map([[40, ['17.0']]]), []);
        assert.deepStrictEqual(groups.upgradeDisabled, []);
        assert.deepStrictEqual(groups.missingIds, [40]);
    });
});
